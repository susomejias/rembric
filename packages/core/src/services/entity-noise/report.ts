import { measureLexicalNoise, noisePercent } from './measure.js';

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
