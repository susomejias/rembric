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

/** The module's one way of measuring the byte budget — lines join with `\n`. */
function utf8Bytes(text: string | readonly string[]): number {
  return Buffer.byteLength(typeof text === 'string' ? text : text.join('\n'), 'utf8');
}

/**
 * The longest prefix of `s` that fits `maxBytes` in UTF-8. Iterates by code
 * POINT, so it can never stop between the two halves of a surrogate pair,
 * and it visits each one once — a shrink-and-re-render loop re-encodes the
 * whole notice per unit removed.
 */
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

/**
 * The frame this branch renders around the title when EVERY section has been
 * elided — the widest fixed part it can produce, since `+N more` peaks at the
 * full section count. Reserving it is what leaves the elision loop, and the
 * all-elided return below, within bound by construction.
 */
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
  const intro = introLine(title);
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

function noStoredSectionsFrame(title: string, summaryMaxChars: number): string[] {
  return [
    directiveText(),
    `Nothing is stored yet for "${title}". ${SUMMARY_SECTIONS}`,
    closingLine(0, summaryMaxChars),
  ];
}

/**
 * The title is the notice's ONE unbounded input — nothing upstream bounds it
 * in bytes — and both branches interpolate it, so it is cut here, at the
 * bifurcation, against whichever frame the chosen branch will render. Cutting
 * it inside one branch left the other reachable at 714 bytes with a
 * placeholder-length title (measured).
 */
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
