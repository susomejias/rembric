interface LineToken {
  text: string;
  /** `'\n'`, `'\r\n'`, or `''` for a final line with no trailing terminator. */
  term: string;
}

export interface SummarySection {
  /** Trimmed, lower-cased heading text; `''` for text preceding the first heading. */
  key: string;
  headingLine: LineToken | null;
  body: LineToken[];
}

const HEADING_RE = /^##[ \t]+(.+)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function splitLines(doc: string): LineToken[] {
  const out: LineToken[] = [];
  let start = 0;
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === '\n') {
      const isCrlf = i > start && doc[i - 1] === '\r';
      const term = isCrlf ? '\r\n' : '\n';
      const textEnd = isCrlf ? i - 1 : i;
      out.push({ text: doc.slice(start, textEnd), term });
      start = i + 1;
    }
  }
  if (start < doc.length || doc.length === 0) {
    out.push({ text: doc.slice(start), term: '' });
  }
  return out;
}

function headingKey(text: string): string | null {
  const m = HEADING_RE.exec(text);
  if (!m) return null;
  const key = m[1]!.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

export function parseSummarySections(doc: string): SummarySection[] {
  const lines = splitLines(doc);
  const sections: SummarySection[] = [];
  const indexByKey = new Map<string, number>();
  let inFence = false;
  let current: SummarySection = { key: '', headingLine: null, body: [] };
  let currentHasContent = false;

  const flush = () => {
    if (current.headingLine === null && !currentHasContent) return;
    const existingIdx = indexByKey.get(current.key);
    if (existingIdx === undefined) {
      indexByKey.set(current.key, sections.length);
      sections.push(current);
    } else {
      sections[existingIdx]!.body.push(...current.body);
    }
  };

  for (const line of lines) {
    if (FENCE_RE.test(line.text)) {
      inFence = !inFence;
      current.body.push(line);
      currentHasContent = true;
      continue;
    }
    const key = inFence ? null : headingKey(line.text);
    if (key !== null) {
      flush();
      current = { key, headingLine: line, body: [] };
      currentHasContent = false;
    } else {
      current.body.push(line);
      currentHasContent = true;
    }
  }
  flush();

  return sections;
}

/** Whether `doc` contains at least one level-2 `##` heading (outside any fence). */
export function hasAnyHeading(doc: string): boolean {
  return parseSummarySections(doc).some((s) => s.key !== '');
}

function splitCoreAndGap(section: SummarySection): { core: string; gap: string } {
  if (section.body.length === 0) {
    if (!section.headingLine) return { core: '', gap: '' };
    return { core: section.headingLine.text, gap: section.headingLine.term };
  }
  let core = section.headingLine ? section.headingLine.text + section.headingLine.term : '';
  for (let i = 0; i < section.body.length - 1; i++) {
    core += section.body[i]!.text + section.body[i]!.term;
  }
  const last = section.body[section.body.length - 1]!;
  return { core: core + last.text, gap: last.term };
}

interface MergeEntry {
  section: SummarySection;
  /** The key that immediately followed this section in ITS OWN source, or `null` at that source's end. */
  naturalNextKey: string | null;
}

export function mergeSummarySections(stored: string, incoming: string): string {
  const storedSections = parseSummarySections(stored);
  const incomingSections = parseSummarySections(incoming);
  const incomingIndexByKey = new Map(incomingSections.map((s, i) => [s.key, i] as const));
  const storedKeys = new Set(storedSections.map((s) => s.key));

  const entries: MergeEntry[] = [];
  storedSections.forEach((section, i) => {
    const incIdx = incomingIndexByKey.get(section.key);
    if (incIdx !== undefined) {
      entries.push({
        section: incomingSections[incIdx]!,
        naturalNextKey: incomingSections[incIdx + 1]?.key ?? null,
      });
    } else {
      entries.push({ section, naturalNextKey: storedSections[i + 1]?.key ?? null });
    }
  });
  incomingSections.forEach((section, i) => {
    if (!storedKeys.has(section.key)) {
      entries.push({ section, naturalNextKey: incomingSections[i + 1]?.key ?? null });
    }
  });

  let out = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const { core, gap } = splitCoreAndGap(entry.section);
    out += core;
    const isLast = i === entries.length - 1;
    const actualNextKey = isLast ? null : entries[i + 1]!.section.key;
    out += entry.naturalNextKey === actualNextKey ? gap : isLast ? '' : '\n';
  }
  return out;
}
