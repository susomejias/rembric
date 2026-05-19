import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Imports from `./helpers` (test-only mirror), NOT from `./plugin`. The
// distributed plugin.ts exports ONLY `RembricPlugin`; opencode invokes every
// named export as a Plugin function. Helper exports would crash on load.
import { parseDotenv, readRembricSlug } from './helpers';

describe('parseDotenv', () => {
  it('returns {} for empty input', () => {
    expect(parseDotenv('')).toEqual({});
  });

  it('ignores comment lines and blank lines', () => {
    const out = parseDotenv('# comment\n\nFOO=bar\n\n# trailing');
    expect(out).toEqual({ FOO: 'bar' });
  });

  it('strips matched double quotes', () => {
    expect(parseDotenv('FOO="bar baz"')).toEqual({ FOO: 'bar baz' });
  });

  it('strips matched single quotes', () => {
    expect(parseDotenv("FOO='bar baz'")).toEqual({ FOO: 'bar baz' });
  });

  it('keeps mismatched quotes verbatim', () => {
    expect(parseDotenv('FOO="bar')).toEqual({ FOO: '"bar' });
  });

  it('trims surrounding whitespace on key and value', () => {
    expect(parseDotenv('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('skips lines without an =', () => {
    expect(parseDotenv('not-a-pair\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('readRembricSlug', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when .rembric is missing', () => {
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('returns the slug for a valid PROJECT_SLUG', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=valid-slug\n');
    expect(readRembricSlug(dir)).toBe('valid-slug');
  });

  it('returns null when PROJECT_SLUG is missing from .rembric', () => {
    writeFileSync(join(dir, '.rembric'), 'OTHER=value\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects leading hyphen', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=-bad\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects trailing hyphen', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=bad-\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects uppercase letters', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=BadSlug\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects slug longer than 64 chars', () => {
    const long = 'a'.repeat(65);
    writeFileSync(join(dir, '.rembric'), `PROJECT_SLUG=${long}\n`);
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('accepts slug exactly 64 chars', () => {
    const ok = 'a'.repeat(64);
    writeFileSync(join(dir, '.rembric'), `PROJECT_SLUG=${ok}\n`);
    expect(readRembricSlug(dir)).toBe(ok);
  });

  it('accepts single-character slug', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=a\n');
    expect(readRembricSlug(dir)).toBe('a');
  });
});

describe('readRembricSlug byte-for-byte equivalence with bridge parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches a representative fixture verbatim', () => {
    const fixture = [
      '# Rembric project slug for this repo',
      '',
      'PROJECT_SLUG=my-repo',
      'OTHER_KEY="ignored"',
      '   ',
      'TRAILING_WHITESPACE   =   xyz   ',
    ].join('\n');
    writeFileSync(join(dir, '.rembric'), fixture);

    const parsed = parseDotenv(fixture);
    expect(parsed.PROJECT_SLUG).toBe('my-repo');
    expect(parsed.OTHER_KEY).toBe('ignored');
    expect(parsed.TRAILING_WHITESPACE).toBe('xyz');
    expect(readRembricSlug(dir)).toBe('my-repo');
  });
});
