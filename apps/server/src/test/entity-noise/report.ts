import { measureLexicalNoise, noisePercent } from './measure.js';

/**
 * Prints the measured per-kind lexical noise table. Run it when a kind's
 * pattern or the corpus changes, then update `memory-entities`' justification
 * table and `PUBLISHED_NOISE` (asserted by `noise-rate.test.ts`):
 *
 *   npx tsx src/test/entity-noise/report.ts
 */

const rows = measureLexicalNoise().sort((a, b) => b.noiseRate - a.noiseRate);
const tick = '`';

console.log('| kind | probes | worst-case lexical noise |');
console.log('| ---- | ------ | ------------------------ |');
for (const r of rows) {
  console.log(`| ${tick}${r.group}${tick} | ${r.probes} | ${noisePercent(r.noiseRate)}% |`);
}

console.log('\nper probe:');
for (const r of rows) {
  for (const p of r.results) {
    console.log(
      `  ${r.group.padEnd(38)} ${p.probe.identifier.padEnd(46)} ` +
        `truth=${p.truthMatched ? 'hit' : 'MISS'} matches=${p.totalMatches} ` +
        `noise=${noisePercent(p.noiseRate)}%`,
    );
  }
}
