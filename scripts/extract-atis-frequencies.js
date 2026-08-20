/**
 * extract-atis-frequencies.js
 *
 * AFV's station list has no ATIS entry for 26 of the 43 route airports, which
 * left those vATIS profiles generating frequency 0. OurAirports publishes a
 * frequency table that covers most of them, so this reduces it to a small
 * ICAO -> MHz lookup the server can load.
 *
 *   node scripts/extract-atis-frequencies.js "<path>/airport-frequencies.csv"
 *
 * Writes data/atis-frequencies.json. Public domain source, so the values can
 * ship inside a downloadable profile.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
const out = path.join(__dirname, '..', 'data', 'atis-frequencies.json');

if (!src || !fs.existsSync(src)) {
  console.error('Usage: node scripts/extract-atis-frequencies.js <airport-frequencies.csv>');
  process.exit(1);
}

/* Descriptions carry commas, so the quoting has to be honoured rather than
   split on the delimiter. */
function parseLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* An airport can publish several ATIS frequencies and we broadcast one
   combined station, so they have to be ranked rather than picked at random:
   EHAM lists Arrival 132.980 and Departure 122.200, VHHH splits ATIS-A and
   ATIS-D, and ULLI runs English and Russian side by side. Arrival wins because
   it is the one every inbound needs; a departure-only frequency is the worst
   choice of the set. */
function score(type, desc) {
  const s = (type + ' ' + desc).toUpperCase();
  let n = 0;
  if (/\bARR|ARRIV/.test(s) || /\bATIS-A\b/.test(s)) n += 3;
  if (/\bDEP|DEPART/.test(s) || /\bATIS-D\b/.test(s)) n -= 3;
  if (/\(EN|\bENG\b/.test(s)) n += 1;
  if (/\(RUS|\(FR|\(DE|\(ES|\(IT/.test(s)) n -= 2;
  if (/^ATIS$/.test(type.trim().toUpperCase())) n += 1;
  return n;
}

const best = {};
const lines = fs.readFileSync(src, 'utf-8').split(/\r?\n/);
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const f = parseLine(lines[i]);
  const icao = (f[2] || '').trim().toUpperCase();
  const type = (f[3] || '').trim();
  const desc = (f[4] || '').trim();
  const mhz = parseFloat(f[5]);

  if (!/^[A-Z]{4}$/.test(icao)) continue;                 // skip local US identifiers
  if (!/ATIS/i.test(type) && !/^ATIS\b/i.test(desc)) continue;
  if (!isFinite(mhz) || mhz < 118 || mhz > 137) continue;  // VHF voice only

  const s = score(type, desc);
  if (!best[icao] || s > best[icao].score) best[icao] = { mhz: mhz.toFixed(3), score: s, from: type + (desc && desc !== type ? ' / ' + desc : '') };
}

/* Hand-verified values win. OurAirports misses some airports entirely and
   files others against the navaid the ATIS is broadcast over -- YSSY on
   115.550, YBAS on 115.900 -- which is below the VHF comm band and unusable on
   VATSIM, so those need supplying by hand rather than reading from the CSV. */
const manualPath = path.join(__dirname, '..', 'data', 'atis-frequencies.manual.json');
let manual = {};
if (fs.existsSync(manualPath)) {
  manual = JSON.parse(fs.readFileSync(manualPath, 'utf-8'));
  delete manual._comment;
}

const keys = Object.keys(best).sort();
const table = {};
keys.forEach(k => { table[k] = best[k].mhz; });
let overridden = 0, added = 0;
for (const [icao, mhz] of Object.entries(manual)) {
  if (!/^[A-Z]{4}$/.test(icao)) continue;
  if (table[icao]) overridden++; else added++;
  table[icao] = String(mhz);
}
console.log(`Manual list: ${added} added, ${overridden} overrode the CSV`);

// Sorted after the merge, or hand-added entries land at the end and every
// regeneration churns the diff.
const sorted = {};
Object.keys(table).sort().forEach(k => { sorted[k] = table[k]; });
fs.writeFileSync(out, JSON.stringify(sorted, null, 0) + '\n', 'utf-8');
console.log(`Wrote ${Object.keys(sorted).length} ATIS frequencies to ${path.relative(process.cwd(), out)}`);

for (const k of ['EHAM', 'LEMD', 'ULLI', 'VHHH']) {
  if (best[k]) console.log(`  ${k} -> ${best[k].mhz}  (${best[k].from})`);
}
