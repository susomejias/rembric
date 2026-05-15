#!/usr/bin/env node
/**
 * One-shot font vendor script.
 *
 * Hits the Google Fonts CSS API with a modern UA (so it returns woff2
 * URLs), parses each @font-face declaration, downloads the woff2, and
 * writes it to `src/dashboard/public/assets/fonts/<family>-<weight>.woff2`.
 *
 * After running this once, commit the woff2 files. No runtime CDN
 * dependency: the @font-face declarations in `styles/core/tokens.css`
 * already point at the local paths.
 *
 * Re-run only when the font set changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fontsDir = join(root, 'src/dashboard/public/assets/fonts');
mkdirSync(fontsDir, { recursive: true });

const FAMILIES = [
  { name: 'Space Grotesk', slug: 'space-grotesk', weights: [400, 500, 600, 700, 800] },
  { name: 'Inter', slug: 'inter', weights: [400, 500, 600] },
  { name: 'JetBrains Mono', slug: 'jetbrains-mono', weights: [400, 500, 600] },
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function googleFontsUrl(families) {
  const parts = families.map(
    (f) => `family=${encodeURIComponent(f.name)}:wght@${f.weights.join(';')}`,
  );
  return `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`;
}

async function fetchCssWithWoff2(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    throw new Error(`google fonts CSS fetch failed: ${res.status}`);
  }
  return res.text();
}

function parseFaces(css) {
  const blocks = [];
  const re = /@font-face\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[1];
    const family = (/font-family:\s*'([^']+)'/.exec(body) || [])[1];
    const weight = Number((/font-weight:\s*(\d+)/.exec(body) || [])[1]);
    const urlMatch = /src:[^;]*url\((https:\/\/[^)]+\.woff2)\)/.exec(body);
    if (!family || !weight || !urlMatch) continue;
    const unicodeRange = (/unicode-range:\s*([^;]+);/.exec(body) || [])[1] || '';
    blocks.push({ family, weight, url: urlMatch[1], unicodeRange });
  }
  return blocks;
}

async function downloadWoff2(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`woff2 fetch failed: ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const cssUrl = googleFontsUrl(FAMILIES);
  console.log(`fetch-fonts: GET ${cssUrl}`);
  const css = await fetchCssWithWoff2(cssUrl);
  const faces = parseFaces(css);
  console.log(`fetch-fonts: parsed ${faces.length} @font-face blocks`);

  // Google Fonts returns multiple subsets per (family, weight) — typically
  // cyrillic-ext, cyrillic, greek-ext, greek, vietnamese, latin-ext, latin.
  // We want the `latin` block (basic Latin + symbols). Its signature is the
  // exact range `U+0000-00FF` at the start of the `unicode-range` value.
  const seen = new Set();
  const wanted = [];
  for (const f of faces) {
    const key = `${f.family}@${f.weight}`;
    if (seen.has(key)) continue;
    const isLatinBasic = /U\+0000-00FF/.test(f.unicodeRange);
    if (isLatinBasic) {
      seen.add(key);
      wanted.push(f);
    }
  }

  // Fallback: anything we still missed → pick the FIRST face for that pair
  // (Google orders subsets stable; first is typically cyrillic-ext, so this
  // path means something is genuinely wrong with the API response).
  for (const f of faces) {
    const key = `${f.family}@${f.weight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(f);
    console.warn(`fetch-fonts: no latin block for ${key}, using fallback ${f.url}`);
  }

  for (const f of wanted) {
    const family = FAMILIES.find((F) => F.name === f.family);
    if (!family) {
      console.warn(`fetch-fonts: skipping unknown family ${f.family}`);
      continue;
    }
    const filename = `${family.slug}-${f.weight}.woff2`;
    const dest = join(fontsDir, filename);
    process.stdout.write(`fetch-fonts: ${filename} ...`);
    const buf = await downloadWoff2(f.url);
    writeFileSync(dest, buf);
    process.stdout.write(` ${buf.length} bytes\n`);
  }

  console.log(`fetch-fonts: done. ${wanted.length} files vendored under ${fontsDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
