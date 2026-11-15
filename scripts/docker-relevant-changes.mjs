#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A deny-list on purpose: a path nobody classified (a new COPY source, a new
// script) keeps building the image instead of silently skipping it.
const OUTSIDE_IMAGE = [
  /^openspec\//,
  /^docs\//,
  /^examples\//,
  /^\.(agents|claude|codex|opencode|pi)\//,
  /^\.(claude|codex)-plugin\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/(PULL_REQUEST_TEMPLATE\.md|FUNDING\.yml|dependabot\.yml)$/,
  /^\.release-please-manifest\.json$/,
  /^[^/]+\.md$/,
  /^apps\/plugin\/(?!install\.sh$|package\.json$)/,
];

export function touchesImage(paths) {
  if (paths.length === 0) return true;
  return paths.some((path) => !OUTSIDE_IMAGE.some((pattern) => pattern.test(path)));
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv) {
  const base = arg(argv, '--base');
  const head = arg(argv, '--head');
  if (!base || !head) {
    console.error('usage: docker-relevant-changes.mjs --base <sha> --head <sha>');
    return 2;
  }
  const paths = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const docker = touchesImage(paths);
  console.log(`${paths.length} changed path(s); docker=${docker}`);
  for (const path of paths) console.log(`  ${path}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docker=${docker}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
