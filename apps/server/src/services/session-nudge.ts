import { SUMMARY_SECTIONS } from '../mcp/summary-rubric.js';

import { sliceWithoutSplittingSurrogatePair } from './strings.js';
import { parseSummarySections, type SummarySection } from './summary-sections.js';

/**
 * The server-side gate and notice composition for the stretch-close
 * reminder (`session-nudges`). Pure: takes a row-shaped input plus `now`,
 * the floor and the summary cap, returns either `null` (gate does not
 * fire) or the composed notice as a one-element array of lines. No SQL, no
 * clock of its own, no repository — `services/agent-sessions.ts` owns
 * persistence and passes in what this module reads.
 */

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

function utf8Bytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8');
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

/**
 * Builds the notice, eliding from the TAIL of stored order (never the
 * head) as soon as adding the next section would exceed the bound —
 * `## Goal` and every early section survive elision by construction, and
 * the directive/intro/closing lines are never elided.
 */
function buildWithStoredSections(
  title: string,
  sections: SummarySection[],
  usedChars: number,
  summaryMaxChars: number,
): string {
  const directive = directiveText();
  const intro = `Stored for "${title}" (current sizes, not targets):`;
  const closing = closingLine(usedChars, summaryMaxChars);
  const base = [directive, intro];

  const kept: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const line = `${headingDisplay(sections[i]!)} (${sectionBodyChars(sections[i]!)}c)`;
    const candidate = [...base, ...kept, line, closing];
    if (utf8Bytes(candidate) > NOTICE_MAX_BYTES) {
      // The section that just failed to fit is never kept — pop back further
      // if even the shorter elision label doesn't fit alongside what is
      // already kept, so the returned string is ALWAYS within bound.
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

/**
 * The title is the only variable-length input here and nothing upstream
 * bounds it in BYTES — measured 776 with a 100-code-unit CJK title — so it
 * is cut to fit. By code unit, since one costs 1..3 bytes.
 */
function buildWithNoStoredSections(title: string, summaryMaxChars: number): string {
  const directive = directiveText();
  const closing = closingLine(0, summaryMaxChars);
  const render = (t: string): string =>
    [directive, `Nothing is stored yet for "${t}". ${SUMMARY_SECTIONS}`, closing].join('\n');
  let kept = title;
  while (kept.length > 0 && Buffer.byteLength(render(kept), 'utf8') > NOTICE_MAX_BYTES) {
    kept = sliceWithoutSplittingSurrogatePair(kept, kept.length - 1);
  }
  return render(kept);
}

export function composeSessionNotice(row: SessionNudgeRow, summaryMaxChars: number): string {
  const title = row.title ?? 'this session';
  const sections =
    row.summary === null ? [] : parseSummarySections(row.summary).filter((s) => s.key !== '');
  if (sections.length === 0) {
    return buildWithNoStoredSections(title, summaryMaxChars);
  }
  const usedChars = row.summary?.length ?? 0;
  return buildWithStoredSections(title, sections, usedChars, summaryMaxChars);
}

/**
 * The gate — `sessions/spec.md`'s three conditions, in order. `floorMs` and
 * `summaryMaxChars` are explicit parameters rather than imported constants
 * so this module stays a pure function of its arguments and
 * `services/agent-sessions.ts` (the sole owner of both `NUDGE_FLOOR_MS` and
 * `SUMMARY_MAX_CHARS`) is never imported here. A local copy of the cap would
 * let the notice's "N used of M available" drift from the value the write
 * path actually rejects against.
 */
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
