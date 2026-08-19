#!/usr/bin/env node
/**
 * Check vitest JSON output for rescued tests — tests that passed after a retry
 * but still carry non-empty failureMessages. These are invisible in the default
 * reporter but indicate a flaky test that could exhaust its retries.
 *
 * Usage: node scripts/check-rescued-tests.mjs [test-results.json]
 * Default: reads ./test-results.json
 */
import { readFileSync, existsSync } from 'node:fs';

const path = process.argv[2] || './test-results.json';
if (!existsSync(path)) {
  console.error(`check-rescued-tests: ${path} not found — did the test run produce it?`);
  process.exit(2);
}

const raw = readFileSync(path, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error(`check-rescued-tests: ${path} is not valid JSON`);
  process.exit(2);
}

const tests = data.testResults ?? [];
let rescued = 0;

for (const file of tests) {
  for (const assertion of file.assertionResults ?? []) {
    const failures = assertion.failureMessages ?? [];
    if (failures.length > 0 && assertion.status === 'passed') {
      rescued++;
      console.log(
        `RESCUED: ${file.name} > ${assertion.fullName || assertion.title} — ${failures.length} failureMessages`,
      );
    }
  }
}

if (rescued > 0) {
  console.error(`\ncheck-rescued-tests: ${rescued} rescued test(s) found — the run is marked red.`);
  console.error('A rescued test carries stale failureMessages from a failed retry attempt.');
  console.error('Fix the underlying flakiness or remove the retry from the test.');
  process.exit(1);
}

console.log(`check-rescued-tests: ok (${tests.length} files, no rescued tests)`);
