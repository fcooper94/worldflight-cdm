// Clear stored ATC routes for the active event so FIR managers start from
// scratch. Only atcRoute / atcRoute2 are touched — flight times, block times,
// dates, flows and everything else are left intact. Routes reappear per-sector
// once published via Sector Planning finalise/re-sync.
//
// Targets whatever DATABASE_URL in .env points at (Postgres prod or sqlite dev
// — but this script speaks Postgres). Dry-run by default; pass --push to write.
//
//   node clear-atc-routes.mjs           # preview only
//   node clear-atc-routes.mjs --push    # actually clear

import pg from 'pg';
import fs from 'fs';

const PUSH = process.argv.includes('--push');
const url = (fs.readFileSync('.env', 'utf8').match(/^DATABASE_URL="?([^"\n]+)"?/m) || [])[1];
if (!url || !/postgres/i.test(url)) {
  console.error('DATABASE_URL is not a Postgres URL — aborting (this script only targets Postgres).');
  process.exit(1);
}

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const active = (await c.query('SELECT id,name FROM "WfEvent" WHERE "isActive"=true')).rows[0];
if (!active) { console.log('No active event.'); await c.end(); process.exit(1); }

const before = (await c.query(
  `SELECT COUNT(*)::int n FROM "WfScheduleRow"
   WHERE "eventId"=$1 AND ((COALESCE("atcRoute",'')<>'') OR (COALESCE("atcRoute2",'')<>''))`,
  [active.id]
)).rows[0].n;

console.log(`PROD | Active event: ${active.name} (id ${active.id}) | rows with a stored ATC route: ${before}`);

if (!PUSH) {
  console.log('DRY RUN — re-run with --push to clear atcRoute/atcRoute2 (nothing else is touched).');
  await c.end();
  process.exit(0);
}

const res = await c.query(`UPDATE "WfScheduleRow" SET "atcRoute"='', "atcRoute2"='' WHERE "eventId"=$1`, [active.id]);
const after = (await c.query(
  `SELECT COUNT(*)::int n FROM "WfScheduleRow"
   WHERE "eventId"=$1 AND ((COALESCE("atcRoute",'')<>'') OR (COALESCE("atcRoute2",'')<>''))`,
  [active.id]
)).rows[0].n;

console.log(`Cleared ATC routes on ${res.rowCount} rows. Verification — rows still holding a route: ${after}`);
await c.end();
