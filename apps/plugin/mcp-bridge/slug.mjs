import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDotenv, SLUG_RE } from './rembric-dotenv.mjs';

export function resolveProjectDirectory(env = process.env, cwd = process.cwd()) {
  if (env.CLAUDE_PROJECT_DIR || env.PWD) {
    return env.CLAUDE_PROJECT_DIR || env.PWD;
  }
  return cwd;
}

export function projectDirectorySource(env = process.env) {
  if (env.CLAUDE_PROJECT_DIR) return 'CLAUDE_PROJECT_DIR';
  if (env.PWD) return 'PWD';
  return 'process.cwd()';
}

function readProjectSlug(projectDir, parse, slugRe) {
  const file = join(projectDir, '.rembric');
  if (!existsSync(file)) return { value: null, issue: `No .rembric in ${projectDir}` };
  try {
    const parsed = parse(readFileSync(file, 'utf8'));
    if (!parsed.PROJECT_SLUG) return { value: null, issue: `${file} has no PROJECT_SLUG` };
    if (!slugRe.test(parsed.PROJECT_SLUG)) {
      return { value: null, issue: `PROJECT_SLUG="${parsed.PROJECT_SLUG}" in ${file} is invalid` };
    }
    return { value: parsed.PROJECT_SLUG, issue: null };
  } catch {
    return { value: null, issue: `Could not read ${file}` };
  }
}

export function resolveSlug(projectDir, env = process.env, parse = parseDotenv, slugRe = SLUG_RE) {
  const environmentSlug = env.REMBRIC_PROJECT_SLUG;
  const fileSlug = readProjectSlug(projectDir, parse, slugRe);
  if (fileSlug.value) return { slug: fileSlug.value, issue: null };
  if (environmentSlug && slugRe.test(environmentSlug)) {
    return { slug: environmentSlug, issue: fileSlug.issue };
  }

  if (environmentSlug) {
    return { slug: null, issue: `${environmentSlug} in REMBRIC_PROJECT_SLUG is invalid` };
  }
  return { slug: null, issue: fileSlug.issue };
}

export function buildEndpoint(baseUrl, slug) {
  return `${baseUrl.replace(/\/+$/, '')}/mcp${slug ? `/${slug}` : ''}`;
}
