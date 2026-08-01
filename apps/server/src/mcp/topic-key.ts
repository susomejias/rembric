import transliterate from 'slugify';
import * as stopwords from 'stopword';

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
 *   procedural     runbook
 *
 * The slug-from-text logic:
 *   1. transliterate to ASCII, lowercased
 *   2. drop stopwords
 *   3. keep up to 6 surviving word-shaped tokens
 *   4. join with `-`, trim to 48 chars, never ending on a particle
 */

/**
 * Languages whose particles are filtered. Deliberately the two this corpus
 * actually contains: measured, every wider grouping eats load-bearing English
 * vocabulary for no gain — `romance+germanic` swallows `dos` and `mit`, and all
 * 60 languages swallow `global`, `save` and `stop`.
 */
export const STOPWORD_LANGUAGES = ['eng', 'spa'] as const;

const STOPWORDS = new Set(STOPWORD_LANGUAGES.flatMap((l) => stopwords[l]));

const FAMILY_BY_TYPE: Record<string, string> = {
  user: 'preference',
  feedback: 'feedback',
  project: 'decision',
  reference: 'reference',
  procedural: 'runbook',
};

const MAX_SLUG_CHARS = 48;
const MAX_KEEP_TOKENS = 6;
const HAS_LETTER = /[a-z]/;

/**
 * `topicKey: null` is the answer for a title no transliteration reaches — a
 * placeholder would hand two unrelated memories the same key, and adopting it
 * makes the topic_key upsert supersede the wrong row.
 */
export type TopicKeySuggestion =
  | { topicKey: string; reason?: never }
  | { topicKey: null; reason: string };

export function suggestTopicKey(input: {
  type: string;
  title?: string;
  content?: string;
}): TopicKeySuggestion {
  const family = FAMILY_BY_TYPE[input.type] ?? 'topic';
  const source = (input.title ?? input.content ?? '').trim();
  if (source.length === 0) {
    return { topicKey: null, reason: 'no title or content to derive a key from' };
  }
  const slug = slugify(source);
  if (slug === null) {
    return {
      topicKey: null,
      reason:
        'the title transliterates to no word-shaped token (scripts such as Han, Kana or Hangul have no ASCII equivalent) — author a topic_key yourself, Unicode is accepted',
    };
  }
  return { topicKey: `${family}/${slug}` };
}

/** `null` when the text yields no token carrying topic signal. */
function slugify(text: string): string | null {
  // `.`/`_`/`/` are deleted by the library, not split on, so `db/client.ts`
  // would collapse to one token. The pre-pass restores them as boundaries.
  const tokens = transliterate(text.replace(/[._/\\]+/g, ' '), { lower: true, strict: true })
    .split('-')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const kept = tokens.slice(0, MAX_KEEP_TOKENS);
  // On `kept`, not on every token: an all-numeric budget with one late word
  // would otherwise pass the check and still yield a digits-only slug.
  if (!kept.some((t) => HAS_LETTER.test(t))) return null;
  return kept.join('-').slice(0, MAX_SLUG_CHARS).replace(/-+$/, '');
}

const NEARBY_PREFIX_TOKENS = 2;

/**
 * A short prefix from a topic_key (own output of `suggestTopicKey`), used to
 * find "nearby" active keys the agent might have meant instead of minting a
 * synonym — e.g. `decision/dev-stack-chown` → `decision/dev-stack`, which
 * matches `decision/dev-stack-permissions`.
 */
export function topicKeyPrefix(topicKey: string): string {
  const slashIdx = topicKey.indexOf('/');
  if (slashIdx === -1) return topicKey;
  const family = topicKey.slice(0, slashIdx + 1);
  const slugTokens = topicKey
    .slice(slashIdx + 1)
    .split('-')
    .filter(Boolean);
  return family + slugTokens.slice(0, NEARBY_PREFIX_TOKENS).join('-');
}
