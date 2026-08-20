/**
 * import-runways-from-cifp.js
 *
 * Fills in runways for an airport the OurAirports CSV seeder missed. FNBJ is
 * the case that prompted it: Luanda's replacement airport opened too recently
 * to be in the CSV, so its sector file was generated with no runway at all.
 *
 * CIFP carries the ends with coordinates, so it can stand in.
 *
 *   node scripts/import-runways-from-cifp.js FNBJ           # dry run
 *   node scripts/import-runways-from-cifp.js FNBJ --push    # write to the DB
 *
 * Reads DATABASE_URL from .env, so it writes to whichever database that points
 * at — check which one you are on before pushing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '..', 'package.json'));
const { Client } = require('pg');

const icao = String(process.argv[2] || '').toUpperCase();
const push = process.argv.includes('--push');
if (!/^[A-Z]{4}$/.test(icao)) {
  console.error('Usage: node scripts/import-runways-from-cifp.js <ICAO> [--push]');
  process.exit(1);
}

/* CIFP packs coordinates as DDMMSSss with a leading hemisphere letter:
   S09032526 is 09 deg 03 min 25.26 sec south. */
function cifpCoord(raw) {
  const m = /^([NSEW])(\d+)$/.exec(String(raw).trim());
  if (!m) return null;
  const [, hemi, digits] = m;
  const degLen = (hemi === 'E' || hemi === 'W') ? 3 : 2;
  const deg = Number(digits.slice(0, degLen));
  const min = Number(digits.slice(degLen, degLen + 2));
  const sec = Number(digits.slice(degLen + 2, degLen + 4) + '.' + digits.slice(degLen + 4));
  const val = deg + min / 60 + sec / 3600;
  return (hemi === 'S' || hemi === 'W') ? -val : val;
}

const file = path.join(__dirname, '..', 'data', 'XP12', 'CIFP', icao + '.dat');
if (!fs.existsSync(file)) {
  console.error('No CIFP file for ' + icao + ' at ' + file);
  process.exit(1);
}

const ends = [];
for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
  if (!line.startsWith('RWY:')) continue;
  const ident = (line.slice(4).split(',')[0] || '').trim().replace(/^RW/, '');
  const coords = /;([NS]\d+),([EW]\d+),/.exec(line);
  if (!ident || !coords) continue;
  const lat = cifpCoord(coords[1]);
  const lon = cifpCoord(coords[2]);
  if (lat == null || lon == null) continue;
  ends.push({ ident, lat, lon });
}

if (!ends.length) {
  console.error('No RWY records found in ' + path.basename(file));
  process.exit(1);
}

/* A runway row holds both ends. 06L pairs with 24R, not 24L: add 18 to the
   number and swap L/R, which is how the reciprocal is named. */
function reciprocalOf(ident) {
  const m = /^(\d{1,2})([LRC])?$/.exec(ident);
  if (!m) return null;
  const num = ((Number(m[1]) + 18 - 1) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2] || '';
  return String(num).padStart(2, '0') + side;
}

const pairs = [];
const used = new Set();
for (const e of ends) {
  if (used.has(e.ident)) continue;
  const wantedName = reciprocalOf(e.ident);
  const other = ends.find(x => x.ident === wantedName && !used.has(x.ident));
  if (!other) { console.warn('  no reciprocal for ' + e.ident + ' (expected ' + wantedName + ') - skipped'); continue; }
  used.add(e.ident); used.add(other.ident);
  // Lower number first, matching how the CSV seeder wrote le_/he_.
  const [a, b] = Number(e.ident.replace(/\D/g, '')) <= Number(other.ident.replace(/\D/g, '')) ? [e, other] : [other, e];
  pairs.push({ ident1: a.ident, lat1: a.lat, lon1: a.lon, ident2: b.ident, lat2: b.lat, lon2: b.lon });
}

console.log(`${icao}: ${ends.length} runway ends in CIFP -> ${pairs.length} runway(s)`);
for (const p of pairs) {
  console.log(`  ${p.ident1}/${p.ident2}  ${p.lat1.toFixed(6)},${p.lon1.toFixed(6)}  ->  ${p.lat2.toFixed(6)},${p.lon2.toFixed(6)}`);
}

const url = /DATABASE_URL="([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8'))[1];
const host = /@([^/:]+)/.exec(url);
console.log(`\nDatabase: ${host ? host[1] : 'unknown host'}`);

const client = new Client({ connectionString: url });
await client.connect();

const ap = await client.query('SELECT icao, name, lat, lon FROM "Airport" WHERE icao = $1', [icao]);
if (!ap.rows.length) {
  console.error(`${icao} is not in the Airport table - nothing to attach runways to.`);
  await client.end();
  process.exit(1);
}
console.log(`Airport: ${ap.rows[0].name} (${ap.rows[0].lat}, ${ap.rows[0].lon})`);

const existing = await client.query('SELECT "ident1", "ident2" FROM "Runway" WHERE "airportIcao" = $1', [icao]);
console.log(`Existing runway rows: ${existing.rows.length}` + (existing.rows.length ? ' -> ' + existing.rows.map(r => r.ident1 + '/' + r.ident2).join(', ') : ''));

if (!push) {
  console.log('\nDry run. Re-run with --push to insert.');
  await client.end();
  process.exit(0);
}

let inserted = 0;
for (const p of pairs) {
  if (existing.rows.some(r => r.ident1 === p.ident1 && r.ident2 === p.ident2)) {
    console.log(`  ${p.ident1}/${p.ident2} already present - skipped`);
    continue;
  }
  await client.query(
    'INSERT INTO "Runway" ("airportIcao", "ident1", "ident2", lat1, lon1, lat2, lon2) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [icao, p.ident1, p.ident2, p.lat1, p.lon1, p.lat2, p.lon2]
  );
  inserted++;
}

const after = await client.query('SELECT "ident1", "ident2" FROM "Runway" WHERE "airportIcao" = $1 ORDER BY "ident1"', [icao]);
console.log(`\nInserted ${inserted}. ${icao} now has ${after.rows.length} runway(s): ${after.rows.map(r => r.ident1 + '/' + r.ident2).join(', ')}`);
await client.end();
