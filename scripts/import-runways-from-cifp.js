/**
 * import-runways-from-cifp.js
 *
 * Runways came from OurAirports' runways.csv via a one-off seed and were never
 * refreshed, so they drifted: PADQ had been renumbered 07/25 and 18/36 when the
 * chart and the navdata both say 08/26 and 01/19, CYVR carried a phantom "26A"
 * and "XX", and several airports still listed runways that have closed.
 *
 * CIFP is AIRAC-cycle data and already in the repo, so it is the better source.
 *
 *   node scripts/import-runways-from-cifp.js FNBJ            # one airport, dry run
 *   node scripts/import-runways-from-cifp.js --all           # every route airport, dry run
 *   node scripts/import-runways-from-cifp.js --all --push    # apply
 *
 * Reads DATABASE_URL from .env, so it writes to whichever database that points
 * at - check which one you are on before pushing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '..', 'package.json'));
const { Client } = require('pg');

const args = process.argv.slice(2);
const push = args.includes('--push');
const all = args.includes('--all');
/* CIFP is not always complete. UHPP's second parallel and ZKPY's 01/19 exist in
   reality but are absent from it, so those two are held back rather than having
   real runways deleted on the strength of a gap in the data. */
const skip = new Set(
  (args.find(a => a.startsWith('--skip=')) || '').replace('--skip=', '')
    .split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
);
const single = args.find(a => /^[A-Za-z]{4}$/.test(a));
if (!all && !single) {
  console.error('Usage: node scripts/import-runways-from-cifp.js <ICAO>|--all [--push]');
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

function cifpEnds(icao) {
  const file = path.join(__dirname, '..', 'data', 'XP12', 'CIFP', icao + '.dat');
  if (!fs.existsSync(file)) return null;
  const ends = [];
  let declared = 0;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.startsWith('RWY:')) continue;
    declared++;
    const ident = (line.slice(4).split(',')[0] || '').trim().replace(/^RW/, '');
    const coords = /;([NS]\d+),([EW]\d+),/.exec(line);
    if (!ident || !coords) continue;
    const lat = cifpCoord(coords[1]);
    const lon = cifpCoord(coords[2]);
    if (lat == null || lon == null) continue;
    ends.push({ ident, lat, lon });
  }

  /* HUEN declares 12, 17, 30 and 35 but carries coordinates for 17 alone. An
     airport whose ends are only partly positioned would be rewritten from the
     few that parsed, silently deleting real runways, so leave it untouched. */
  if (declared !== ends.length) {
    console.warn(`  ${icao}: ${declared - ends.length} of ${declared} CIFP runway ends have no coordinates - left alone`);
    return [];
  }

  /* EGSS comes back as 04, 04C, 22, 22C. The C entries are points partway down
     the same strip for procedure design, not runways anyone names on frequency.
     A genuine centre runway only exists where the plain number does not - three
     parallels are 16L/16C/16R, never 16 and 16C together. */
  const plain = new Set(ends.map(e => e.ident).filter(i => /^\d{1,2}$/.test(i)));
  return ends.filter(e => {
    const m = /^(\d{1,2})C$/.exec(e.ident);
    return !(m && plain.has(m[1]));
  });
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

function pairUp(ends, icao) {
  const pairs = [];
  const used = new Set();
  for (const e of ends) {
    if (used.has(e.ident)) continue;
    const wanted = reciprocalOf(e.ident);
    const other = ends.find(x => x.ident === wanted && !used.has(x.ident));
    if (!other) {
      console.warn(`  ${icao}: no reciprocal for ${e.ident} (expected ${wanted}) - skipped`);
      continue;
    }
    used.add(e.ident); used.add(other.ident);
    const [a, b] = Number(e.ident.replace(/\D/g, '')) <= Number(other.ident.replace(/\D/g, '')) ? [e, other] : [other, e];
    pairs.push({ ident1: a.ident, lat1: a.lat, lon1: a.lon, ident2: b.ident, lat2: b.lat, lon2: b.lon });
  }
  return pairs.sort((x, y) => x.ident1.localeCompare(y.ident1));
}

const url = /DATABASE_URL="([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8'))[1];
const host = /@([^/:]+)/.exec(url);
console.log(`Database: ${host ? host[1] : 'unknown host'}\n`);

const client = new Client({ connectionString: url });
await client.connect();

let icaos;
if (all) {
  const ev = await client.query('SELECT id FROM "WfEvent" WHERE "isActive" LIMIT 1');
  const r = await client.query(
    'SELECT DISTINCT "from" i FROM "WfScheduleRow" WHERE "eventId" = $1 UNION SELECT DISTINCT "to" FROM "WfScheduleRow" WHERE "eventId" = $1',
    [ev.rows[0].id]
  );
  icaos = r.rows.map(x => x.i).filter(Boolean).sort();
} else {
  icaos = [single.toUpperCase()];
}

const existing = await client.query('SELECT "airportIcao" a, "ident1", "ident2" FROM "Runway"');
const byIcao = {};
for (const r of existing.rows) (byIcao[r.a] = byIcao[r.a] || []).push(r.ident1 + '/' + r.ident2);

const plan = [];
let unchanged = 0, noData = 0;
for (const icao of icaos) {
  if (skip.has(icao)) { console.log(`${icao}: skipped by --skip`); continue; }
  const ends = cifpEnds(icao);
  if (!ends || !ends.length) { noData++; console.log(`${icao}: no CIFP data - left alone`); continue; }
  const pairs = pairUp(ends, icao);
  if (!pairs.length) { noData++; continue; }

  const before = (byIcao[icao] || []).slice().sort();
  const after = pairs.map(p => p.ident1 + '/' + p.ident2).sort();
  if (JSON.stringify(before) === JSON.stringify(after)) { unchanged++; continue; }

  const added = after.filter(x => !before.includes(x));
  const removed = before.filter(x => !after.includes(x));
  console.log(`${icao}  ${before.join(', ') || '(none)'}  ->  ${after.join(', ')}`);
  if (added.length) console.log(`        + ${added.join(', ')}`);
  if (removed.length) console.log(`        - ${removed.join(', ')}`);
  plan.push({ icao, pairs });
}

console.log(`\n${plan.length} airport(s) to change, ${unchanged} already correct, ${noData} without usable CIFP data.`);

if (!plan.length) { await client.end(); process.exit(0); }

if (!push) {
  console.log('\nDry run. Re-run with --push to apply.');
  await client.end();
  process.exit(0);
}

for (const { icao, pairs } of plan) {
  // Replace wholesale: renumbering means matching old rows to new ones is
  // guesswork, and nothing references a Runway row by id.
  await client.query('DELETE FROM "Runway" WHERE "airportIcao" = $1', [icao]);
  for (const p of pairs) {
    await client.query(
      'INSERT INTO "Runway" ("airportIcao", "ident1", "ident2", lat1, lon1, lat2, lon2) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [icao, p.ident1, p.ident2, p.lat1, p.lon1, p.lat2, p.lon2]
    );
  }
  console.log(`  ${icao}: ${pairs.length} runway(s) written`);
}

const after = await client.query(
  'SELECT "airportIcao" a, "ident1", "ident2" FROM "Runway" WHERE "airportIcao" = ANY($1) ORDER BY "airportIcao", "ident1"',
  [plan.map(p => p.icao)]
);
console.log('\nVerification:');
const grouped = {};
for (const r of after.rows) (grouped[r.a] = grouped[r.a] || []).push(r.ident1 + '/' + r.ident2);
for (const k of Object.keys(grouped)) console.log(`  ${k}: ${grouped[k].join(', ')}`);
await client.end();
