#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readManifest(packageDir) {
  try {
    return JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(
      `could not read ${packageDir}/package.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function registryError(result, packageSpec) {
  const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/\bE404\b|\b404\b[\s\S]*(?:not found|no such package)|notarget/i.test(detail)) {
    return null;
  }
  return new Error(
    `could not determine whether ${packageSpec} is published:\n${detail.trim() || `exit ${result.status ?? 'unknown'}`}`,
  );
}

export function isPublished(packageName, version, npmCommand = 'npm') {
  const packageSpec = `${packageName}@${version}`;
  const result = spawnSync(npmCommand, ['view', packageSpec, 'version', '--json'], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = registryError(result, packageSpec);
    if (error) throw error;
    return false;
  }

  let publishedVersion;
  try {
    publishedVersion = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`npm view returned invalid JSON for ${packageSpec}`);
  }
  if (publishedVersion !== version) {
    throw new Error(
      `npm view returned ${JSON.stringify(publishedVersion)} for exact query ${packageSpec}`,
    );
  }

  const attestation = spawnSync(npmCommand, ['view', packageSpec, 'dist.attestations', '--json'], {
    encoding: 'utf8',
  });
  if (attestation.error) throw attestation.error;
  if (attestation.status !== 0) {
    throw new Error(`could not verify provenance for ${packageSpec}`);
  }
  try {
    const raw = attestation.stdout.trim();
    if (!raw) throw new Error(`published ${packageSpec} has no npm provenance attestation`);
    const metadata = JSON.parse(raw);
    if (typeof metadata?.provenance?.predicateType !== 'string') {
      throw new Error(`published ${packageSpec} has no npm provenance attestation`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('has no npm provenance')) throw error;
    throw new Error(`npm view returned invalid attestation metadata for ${packageSpec}`, {
      cause: error,
    });
  }
  return true;
}

const AVAILABILITY_TIMEOUT_MS = 15 * 60 * 1000;
const AVAILABILITY_INTERVAL_MS = 15 * 1000;
const SERVED = Symbol('served');

export async function waitUntilServed(packageName, version, npmCommand = 'npm', wait = {}) {
  const timeoutMs = wait.timeoutMs ?? AVAILABILITY_TIMEOUT_MS;
  const intervalMs = wait.intervalMs ?? AVAILABILITY_INTERVAL_MS;
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const deadline = now() + timeoutMs;
  const attempt = () => {
    try {
      return isPublished(packageName, version, npmCommand) ? SERVED : null;
    } catch (error) {
      return error;
    }
  };
  let outcome = attempt();
  while (outcome !== SERVED && now() < deadline) {
    await sleep(intervalMs);
    outcome = attempt();
  }
  if (outcome === SERVED) return;
  const detail = outcome instanceof Error ? `: ${outcome.message}` : '';
  throw new Error(
    `npm accepted ${packageName}@${version} but the registry did not serve it within ${timeoutMs} ms${detail}`,
  );
}

export async function publishPackage(packageDir, npmCommand = 'npm', wait = {}) {
  const manifest = readManifest(packageDir);
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${packageDir}/package.json must declare name and version`);
  }
  const packageSpec = `${manifest.name}@${manifest.version}`;
  if (isPublished(manifest.name, manifest.version, npmCommand)) {
    process.stdout.write(`[npm-publish] ${packageSpec} already exists; skipped\n`);
    return false;
  }

  const result = spawnSync(npmCommand, ['publish', '--provenance', '--access', 'public'], {
    cwd: resolve(packageDir),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`publishing ${packageSpec} failed`);
  await waitUntilServed(manifest.name, manifest.version, npmCommand, wait);
  process.stdout.write(`[npm-publish] ${packageSpec} is served by the registry\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packageDir = process.argv[2];
    if (!packageDir) throw new Error('usage: npm-publish.mjs <package-directory>');
    await publishPackage(packageDir);
  } catch (error) {
    process.stderr.write(
      `[npm-publish] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
