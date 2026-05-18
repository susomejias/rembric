/**
 * Deterministic topic_key suggestion.
 *
 * No LLM. Pure heuristic: pick a family prefix from the memory `type`,
 * then derive a slug from the title (or content fallback), then return
 * `family/slug`. Same input always produces the same output.
 *
 * Families are scoped by memory `type` so the same fact produces
 * the same key regardless of which agent is saving it:
 *
 *   type           family
 *   --------       ---------
 *   user           preference
 *   feedback       feedback
 *   project        decision
 *   reference      reference
 *
 * The slug-from-text logic:
 *   1. lowercase
 *   2. drop stopwords (a / an / the / and / or / to / of / in / on / for / with)
 *   3. keep up to 6 surviving word-shaped tokens
 *   4. join with `-`, trim to 48 chars
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'be',
  'this',
  'that',
  'these',
  'those',
  'it',
  'as',
  'at',
  'by',
  'about',
  'from',
  'into',
  'over',
  'under',
  'after',
  'before',
]);

const FAMILY_BY_TYPE: Record<string, string> = {
  user: 'preference',
  feedback: 'feedback',
  project: 'decision',
  reference: 'reference',
};

const MAX_SLUG_CHARS = 48;
const MAX_KEEP_TOKENS = 6;

export function suggestTopicKey(input: { type: string; title?: string; content?: string }): string {
  const family = FAMILY_BY_TYPE[input.type] ?? 'topic';
  const source = (input.title ?? input.content ?? '').trim();
  const slug = slugify(source) || 'untitled';
  return `${family}/${slug}`;
}

function slugify(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const kept = tokens.slice(0, MAX_KEEP_TOKENS);
  let s = kept
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > MAX_SLUG_CHARS) s = s.slice(0, MAX_SLUG_CHARS).replace(/-+$/, '');
  return s;
}
