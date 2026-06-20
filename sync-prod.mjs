/**
 * Full sync from production Postgres → local SQLite (dev).
 *
 * Strategy: clear each local table and re-insert from prod, preserving
 * exact IDs so foreign key references (e.g. eventId) stay consistent.
 *
 * Production is NEVER written to unless you pass --push.
 * Skips Airport + Runway tables (huge, loaded from CSV/dat files).
 */

import { readFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import pkg from 'pg';

const { Client } = pkg;
const PUSH_ENABLED = process.argv.includes('--push');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function isoDate(v) { return v ? new Date(v).toISOString() : null; }
function bool2int(v) { return v ? 1 : 0; }
const q = c => `"${c}"`;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

const devEnv = loadEnvFile('.env.dev');
const prodUrl = devEnv.PROD_DATABASE_URL;
if (!prodUrl) {
  console.error('  ERROR: PROD_DATABASE_URL not set in .env.dev');
  process.exit(1);
}

const dbPath = 'prisma/dev.db';
if (!existsSync(dbPath)) {
  console.log('  No local dev.db found — nothing to sync.');
  process.exit(0);
}

const pg = new Client({ connectionString: prodUrl });
await pg.connect();
const lite = new Database(dbPath);

console.log(`  Syncing all data... (${PUSH_ENABLED ? 'pull + push' : 'pull only'})`);

// ---------------------------------------------------------------------------
// Pull table: clear local → re-insert from prod with exact IDs
// ---------------------------------------------------------------------------

async function pullTable(opts) {
  const { table, cols, boolCols = [], dateCols = [] } = opts;

  const prodRows = (await pg.query(`SELECT * FROM "${table}"`)).rows;

  // Clear local table
  lite.prepare(`DELETE FROM "${table}"`).run();

  // Re-insert with exact prod values (including id)
  if (prodRows.length === 0) {
    console.log(`    ${table} ✓ 0 rows`);
    return;
  }

  const placeholders = cols.map(() => '?').join(',');
  const insertSql = `INSERT INTO "${table}" (${cols.map(q).join(',')}) VALUES (${placeholders})`;
  const stmt = lite.prepare(insertSql);

  const insertMany = lite.transaction((rows) => {
    for (const pr of rows) {
      const values = cols.map(c => {
        const v = pr[c];
        if (v === undefined || v === null) return null;
        if (boolCols.includes(c)) return bool2int(v);
        if (dateCols.includes(c)) return isoDate(v);
        return v;
      });
      stmt.run(...values);
    }
  });

  insertMany(prodRows);
  console.log(`    ${table} ✓ ${prodRows.length} rows`);
}

// ---------------------------------------------------------------------------
// Sync all tables (order matters — referenced tables first)
// ---------------------------------------------------------------------------

await pullTable({
  table: 'User',
  cols: ['cid', 'name']
});

await pullTable({
  table: 'WfEvent',
  cols: ['id', 'name', 'year', 'sheetUrl', 'mode', 'isActive', 'turnaroundMins',
         'isWorldFlight', 'flightSuffix', 'flightStartNumber', 'aircraftType',
         'costIndex', 'startDateUtc', 'startTimeUtc', 'nextSectorAfter',
         'cruiseAltitude', 'cruiseMode', 'createdAt'],
  boolCols: ['isActive', 'isWorldFlight'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'WfScheduleRow',
  cols: ['id', 'eventId', 'sortOrder', 'number', 'from', 'to', 'dateUtc',
         'depTimeUtc', 'arrTimeUtc', 'blockTime', 'flightTime', 'atcRoute', 'atcRoute2']
});

await pullTable({
  table: 'OfficialTeam',
  cols: ['id', 'teamName', 'callsign', 'mainCid', 'aircraftType', 'country',
         'participatingWf26', 'createdAt'],
  boolCols: ['participatingWf26'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'Affiliate',
  cols: ['id', 'callsign', 'simType', 'cid', 'sinceYear', 'hasMembers', 'participatingWf26', 'createdAt'],
  boolCols: ['hasMembers', 'participatingWf26'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'AffiliateMember',
  cols: ['id', 'affiliateId', 'cid', 'active', 'addedAt'],
  boolCols: ['active'],
  dateCols: ['addedAt']
});

await pullTable({
  table: 'AffiliateSectorClaim',
  cols: ['id', 'affiliateId', 'sectorNumber', 'cid', 'claimedAt'],
  dateCols: ['claimedAt']
});

await pullTable({
  table: 'DepFlow',
  cols: ['id', 'eventId', 'sector', 'rate', 'flowtype', 'updatedAt'],
  dateCols: ['updatedAt']
});

await pullTable({
  table: 'TobtBooking',
  cols: ['id', 'slotKey', 'cid', 'callsign', 'from', 'to', 'dateUtc',
         'depTimeUtc', 'tobtTimeUtc', 'assignedRoute', 'manual', 'createdAt'],
  boolCols: ['manual'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'TobtBookingBackup',
  cols: ['id', 'eventId', 'slotKey', 'cid', 'callsign', 'from', 'to',
         'dateUtc', 'depTimeUtc', 'tobtTimeUtc', 'originalId', 'backedUpAt'],
  dateCols: ['backedUpAt']
});

await pullTable({
  table: 'UserAdditionalRole',
  cols: ['id', 'cid', 'role', 'teamName', 'sinceYear', 'canEditBookings', 'canManageMembers',
         'participating', 'createdAt'],
  boolCols: ['canEditBookings', 'canManageMembers', 'participating'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'DocumentationPermission',
  cols: ['id', 'cid', 'pattern', 'createdAt'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'AirportScenery',
  cols: ['id', 'icao', 'sim', 'name', 'developer', 'store', 'url', 'type',
         'submittedBy', 'submittedAt', 'approved', 'approvedBy', 'approvedAt'],
  boolCols: ['approved'],
  dateCols: ['submittedAt', 'approvedAt']
});

await pullTable({
  table: 'AirportDocument',
  cols: ['id', 'icao', 'filename', 'uploadedBy', 'uploadedAt', 'eventId'],
  dateCols: ['uploadedAt']
});

await pullTable({
  table: 'DocumentationAccessRequest',
  cols: ['id', 'cid', 'pattern', 'name', 'email', 'role', 'requestedAt',
         'status', 'reviewedBy', 'reviewedAt', 'createdAt'],
  dateCols: ['requestedAt', 'reviewedAt', 'createdAt']
});

await pullTable({
  table: 'StaffAccessRequest',
  cols: ['id', 'cid', 'division', 'name', 'email', 'role', 'rating',
         'status', 'reviewedBy', 'reviewedAt', 'createdAt'],
  dateCols: ['reviewedAt', 'createdAt']
});

await pullTable({
  table: 'MasterToken',
  cols: ['id', 'token', 'cid', 'label', 'createdAt', 'usedAt'],
  dateCols: ['createdAt', 'usedAt']
});

await pullTable({
  table: 'WfVisitedAirport',
  cols: ['id', 'icao', 'year', 'eventName']
});

await pullTable({
  table: 'SceneryReport',
  cols: ['id', 'sceneryId', 'reason', 'details', 'reportedBy', 'reportedAt',
         'resolved', 'resolvedBy', 'resolvedAt'],
  boolCols: ['resolved'],
  dateCols: ['reportedAt', 'resolvedAt']
});

await pullTable({
  table: 'FirEventAccess',
  cols: ['id', 'cid', 'scope', 'value', 'createdAt', 'createdBy'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'SectorPlan',
  cols: ['id', 'wf', 'fromIcao', 'toIcao', 'eventId', 'depRouteSuggestion',
         'arrRouteSuggestion', 'depSplitRoute', 'depSplitPct', 'arrSplitRoute', 'arrSplitPct', 'splitAgreed',
         'depFlowType', 'depFlowReason', 'depFlowRate', 'arrFlowRequest', 'arrFlowReason',
         'arrFlowRequestedBy', 'arrFlowRequestedAt', 'depUpdatedBy', 'depUpdatedAt',
         'arrUpdatedBy', 'arrUpdatedAt', 'createdAt', 'updatedAt'],
  boolCols: ['splitAgreed'],
  dateCols: ['arrFlowRequestedAt', 'depUpdatedAt', 'arrUpdatedAt', 'createdAt', 'updatedAt']
});

await pullTable({
  table: 'SectorPlanIssue',
  cols: ['id', 'sectorPlanId', 'wf', 'raisedByCid', 'raisedByFir', 'notes',
         'status', 'resolvedByCid', 'resolvedAt', 'replies', 'createdAt'],
  dateCols: ['resolvedAt', 'createdAt']
});

await pullTable({
  table: 'WfChallengeScore',
  cols: ['id', 'eventId', 'callsign', 'style', 'speed', 'height', 'createdAt'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'AdminPermission',
  cols: ['id', 'cid', 'page', 'createdAt'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'AirportSuggestion',
  cols: ['id', 'firstName', 'lastName', 'icao', 'type', 'association',
         'reason', 'contact', 'notify', 'cid', 'createdAt'],
  boolCols: ['notify'],
  dateCols: ['createdAt']
});

// Skip PageVisibility — admin/page visibility settings stay local in dev so
// toggling them here doesn't mirror prod state (the route hidden/visible flag
// is meaningful per-environment).

await pullTable({
  table: 'MailingListSubscriber',
  cols: ['id', 'email', 'firstName', 'lastName', 'cid', 'createdAt'],
  dateCols: ['createdAt']
});

await pullTable({
  table: 'SiteSetting',
  cols: ['key', 'value']
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Airport + Runway (large tables — only sync if row count differs)
// ---------------------------------------------------------------------------

for (const { table, cols } of [
  { table: 'Airport', cols: ['icao', 'name', 'lat', 'lon', 'elev'] },
  { table: 'Runway', cols: ['id', 'airportIcao', 'ident1', 'ident2', 'lat1', 'lon1', 'lat2', 'lon2'] },
]) {
  const prodCount = (await pg.query(`SELECT COUNT(*) as c FROM "${table}"`)).rows[0].c;
  let localCount = 0;
  try { localCount = lite.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get().c; } catch {}

  if (Number(prodCount) === localCount) {
    console.log(`    ${table} ✓ ${localCount} rows (unchanged, skipped)`);
  } else {
    await pullTable({ table, cols });
  }
}

lite.close();
await pg.end();
console.log('  Sync complete.');
