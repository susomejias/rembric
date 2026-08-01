/**
 * `stopword@3` ships no types, and `@types/stopword` is pinned to major 2 — so
 * declaring the two arrays this module reads is more accurate than depending on
 * types for a different major. Widen only when a third language is enabled.
 */
declare module 'stopword' {
  export const eng: readonly string[];
  export const spa: readonly string[];
}
