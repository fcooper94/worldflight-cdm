/**
 * extract-transition-alts.js
 *
 * Pulls TRANSITION_ALT out of X-Plane 12's atc.dat into a small lookup the
 * server can load, so vATIS profiles carry each airport's real transition
 * altitude instead of one hard-coded table. atc.dat itself is ~10 MB and holds
 * airspace polygons we have no use for, so only the altitudes are kept.
 *
 * Usage:
 *   node scripts/extract-transition-alts.js "<path to>/1200 atc data/Earth nav data/atc.dat"
 *
 * Writes data/transition-altitudes.json — { "EGSS": 6000, ... }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
const out = path.join(__dirname, '..', 'data', 'transition-altitudes.json');

if (!src || !fs.existsSync(src)) {
  console.error('Usage: node scripts/extract-transition-alts.js <path to atc.dat>');
  process.exit(1);
}

const alts = {};
let id = null;
for (const raw of fs.readFileSync(src, 'utf-8').split('\n')) {
  const line = raw.trim();
  if (line.startsWith('FACILITY_ID ')) {
    id = line.split(/\s+/)[1];
  } else if (line.startsWith('TRANSITION_ALT ') && id) {
    const v = parseInt(line.split(/\s+/)[1], 10);
    // An airport appears once per controlling facility; they agree, so first wins.
    if (!isNaN(v) && v > 0 && alts[id] == null) alts[id] = v;
  }
}

const keys = Object.keys(alts).sort();
const sorted = {};
keys.forEach(k => { sorted[k] = alts[k]; });
fs.writeFileSync(out, JSON.stringify(sorted, null, 0) + '\n', 'utf-8');
console.log(`Wrote ${keys.length} transition altitudes to ${path.relative(process.cwd(), out)}`);
