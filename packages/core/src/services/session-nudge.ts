import { SUMMARY_SECTIONS } from '../summary-rubric.js';

import { sliceWithoutSplittingSurrogatePair } from './strings.js';
import { parseSummarySections, type SummarySection } from './summary-sections.js';

export interface SessionNudgeRow {
  startedAt: Date;
  lastWorkAt: Date | null;
  lastSummaryAt: Date | null;
  lastNudgeAt: Date | null;
  summary: string | null;
  title: string | null;
}

/** The composed notice's own byte bound — see `claude-code-plugin`'s per-firing-turn ceiling for the derivation. */
export const NOTICE_MAX_BYTES = 640;

const HEADING_DISPLAY_MAX_CHARS = 32;

/** The module's one way of measuring the byte budget — lines join with `\n`. */
function utf8Bytes(text: string | readonly string[]): number {
  return Buffer.byteLength(typeof text === 'string' ? text : text.join('\n'), 'utf8');
}

function sliceToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const size = utf8Bytes(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return s.slice(0, end);
}

function headingDisplay(section: SummarySection): string {
  const raw = (section.headingLine?.text ?? `## ${section.key}`).trim();
  return raw.length > HEADING_DISPLAY_MAX_CHARS
    ? sliceWithoutSplittingSurrogatePair(raw, HEADING_DISPLAY_MAX_CHARS)
    : raw;
}

function sectionBodyChars(section: SummarySection): number {
  return section.body.reduce((sum, line) => sum + line.text.length + line.term.length, 0);
}

function introLine(title: string): string {
  return `Stored for "${title}" (current sizes, not targets):`;
}

function directiveText(): string {
  return (
    'rembric: A while has passed since the session summary was last refreshed. ' +
    'Call `memory.session_summary` with ONLY the `##` sections that changed — ' +
    'a section you omit keeps its stored text. Nothing to add? Do not call it.'
  );
}

function closingLine(usedChars: number, summaryMaxChars: number): string {
  return `${usedChars} used of ${summaryMaxChars} available.`;
}

function storedSectionsFrame(
  title: string,
  sectionCount: number,
  usedChars: number,
  summaryMaxChars: number,
): string[] {
  return [
    directiveText(),
    introLine(title),
    `+${sectionCount} more`,
    closingLine(usedChars, summaryMaxChars),
  ];
}

function buildWithStoredSections(
  title: string,
  sections: SummarySection[],
  usedChars: number,
  summaryMaxChars: number,
): string {
  const directive = directiveText();
  const intro = introLine(title);
  const closing = closingLine(usedChars, summaryMaxChars);
  const base = [directive, intro];

  const kept: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const line = `${headingDisplay(sections[i]!)} (${sectionBodyChars(sections[i]!)}c)`;
    const candidate = [...base, ...kept, line, closing];
    if (utf8Bytes(candidate) > NOTICE_MAX_BYTES) {
      let remaining = sections.length - kept.length;
      while (kept.length > 0) {
        const trial = [...base, ...kept, `+${remaining} more`, closing];
        if (utf8Bytes(trial) <= NOTICE_MAX_BYTES) return trial.join('\n');
        kept.pop();
        remaining++;
      }
      return [...base, `+${remaining} more`, closing].join('\n');
    }
    kept.push(line);
  }
  return [...base, ...kept, closing].join('\n');
}

function noStoredSectionsFrame(title: string, summaryMaxChars: number): string[] {
  return [
    directiveText(),
    `Nothing is stored yet for "${title}". ${SUMMARY_SECTIONS}`,
    closingLine(0, summaryMaxChars),
  ];
}

export function composeSessionNotice(row: SessionNudgeRow, summaryMaxChars: number): string {
  const rawTitle = row.title ?? 'this session';
  const sections =
    row.summary === null ? [] : parseSummarySections(row.summary).filter((s) => s.key !== '');

  if (sections.length === 0) {
    const budget = NOTICE_MAX_BYTES - utf8Bytes(noStoredSectionsFrame('', summaryMaxChars));
    return noStoredSectionsFrame(sliceToUtf8Bytes(rawTitle, budget), summaryMaxChars).join('\n');
  }

  const usedChars = row.summary?.length ?? 0;
  const budget =
    NOTICE_MAX_BYTES -
    utf8Bytes(storedSectionsFrame('', sections.length, usedChars, summaryMaxChars));
  return buildWithStoredSections(
    sliceToUtf8Bytes(rawTitle, budget),
    sections,
    usedChars,
    summaryMaxChars,
  );
}

export function evaluateSessionNudge(
  row: SessionNudgeRow,
  now: Date,
  floorMs: number,
  summaryMaxChars: number,
): string[] | null {
  if (row.lastWorkAt === null) return null;
  const workAfterSummary =
    row.lastSummaryAt === null || row.lastWorkAt.getTime() > row.lastSummaryAt.getTime();
  if (!workAfterSummary) return null;
  const anchor = row.lastNudgeAt ?? row.startedAt;
  if (now.getTime() - anchor.getTime() < floorMs) return null;
  return [composeSessionNotice(row, summaryMaxChars)];
}
