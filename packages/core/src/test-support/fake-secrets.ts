export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const BASE64 = `${ALNUM}+/`;
export const BASE64URL = `${ALNUM}-_`;

export function fakeChars(length: number, seed: number, alphabet = ALNUM): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out += alphabet[((t ^ (t >>> 14)) >>> 0) % alphabet.length];
  }
  return out;
}

export function fakeGithubToken(seed: number): string {
  return `ghp_${fakeChars(36, seed)}`;
}

export function fakePemBlock(label: string, seed: number): string {
  const lines = [
    fakeChars(64, seed, BASE64),
    fakeChars(64, seed + 1, BASE64),
    `${fakeChars(40, seed + 2, BASE64)}==`,
  ];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function fakeJwt(seed: number): string {
  return `eyJ${fakeChars(33, seed, BASE64URL)}.eyJ${fakeChars(61, seed + 1, BASE64URL)}.${fakeChars(43, seed + 2, BASE64URL)}`;
}
