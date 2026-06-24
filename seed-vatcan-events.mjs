// Create a VATCAN booking event for every WF schedule row that doesn't
// already have one, and store the returned event_id back on the row.
//
// Usage:
//   node seed-vatcan-events.mjs            (dry-run — lists what it would do)
//   node seed-vatcan-events.mjs --push     (actually creates events)
//   node seed-vatcan-events.mjs --push --only WF2601,WF2602  (subset)
//
// Reads the active event from WfEvent (isActive=true) so we only ever seed
// the current year's route.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { vatcanCreateEvent, vatcanIsEnabled } from './lib/vatcan-bookings.mjs';

const prisma = new PrismaClient();
const PUSH = process.argv.includes('--push');
const ownerArg = process.argv.indexOf('--owner');
const OWNER_CID = ownerArg !== -1
  ? Number(process.argv[ownerArg + 1])
  : Number(process.env.VATCAN_BOOKINGS_OWNER_CID || 1303570);
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg !== -1
  ? new Set(String(process.argv[onlyArg + 1] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
  : null;

// "Fri 7th Nov" + year + "21:00" → Date (UTC). Returns null if unparseable.
const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function parseDateTimeUtc(dateStr, timeStr, year) {
  if (!dateStr || !timeStr) return null;
  const dm = String(dateStr).match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)/);
  const tm = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const day = Number(dm[1]);
  const mon = MONTHS[dm[2].toLowerCase().slice(0, 3)];
  if (mon === undefined) return null;
  return new Date(Date.UTC(year, mon, day, Number(tm[1]), Number(tm[2]), 0));
}

// Format Date → "YYYY-MM-DD HH:MM:SS" (UTC) for VATCAN.
function fmtVatcanDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function logHeader() {
  console.log('');
  console.log('  VATCAN events seeder');
  console.log('  ────────────────────');
  console.log('  Mode:        ' + (PUSH ? 'PUSH (will create events)' : 'DRY-RUN (no API calls)'));
  console.log('  Base URL:    ' + (process.env.VATCAN_BOOKINGS_API_URL || 'https://bookings.vlhtesting.com'));
  console.log('  Owner CID:   ' + OWNER_CID);
  if (ONLY) console.log('  Only:        ' + [...ONLY].join(', '));
  console.log('');
}

async function main() {
  logHeader();
  if (PUSH && !vatcanIsEnabled()) {
    console.error('  ERROR: VATCAN_BOOKINGS_API_KEY not set (or disabled via VATCAN_BOOKINGS_DISABLED). Aborting.');
    process.exit(1);
  }

  const activeEvent = await prisma.wfEvent.findFirst({ where: { isActive: true } });
  if (!activeEvent) {
    console.error('  ERROR: no active WfEvent found.');
    process.exit(1);
  }
  console.log('  Active event: ' + activeEvent.name + ' (id ' + activeEvent.id + ')');

  const rows = await prisma.wfScheduleRow.findMany({
    where: { eventId: activeEvent.id },
    orderBy: { sortOrder: 'asc' }
  });
  console.log('  Schedule rows: ' + rows.length);

  const candidates = rows.filter(r => {
    if (ONLY && !ONLY.has(r.number.toUpperCase())) return false;
    return !r.vatcanEventId;
  });
  console.log('  Rows needing events: ' + candidates.length);
  if (!candidates.length) {
    console.log('');
    console.log('  Nothing to do. All rows already have a vatcanEventId.');
    await prisma.$disconnect();
    return;
  }
  console.log('');

  // VATCAN event_date = scheduled dep time MINUS 60 min (start of our
  // ±60min departure window). This way the event is "open" in VATCAN from
  // the moment the booking window starts, not just at the scheduled dep.
  const WINDOW_OFFSET_MIN = -60;

  let created = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of candidates) {
    const name = `${activeEvent.name} ${r.number} ${r.from}→${r.to}`;
    const dt = parseDateTimeUtc(r.dateUtc, r.depTimeUtc, activeEvent.year);
    if (!dt) {
      console.log(`  [skip] ${r.number}  unparseable date/time: "${r.dateUtc}" / "${r.depTimeUtc}"`);
      skipped++;
      continue;
    }
    dt.setUTCMinutes(dt.getUTCMinutes() + WINDOW_OFFSET_MIN);
    const date = fmtVatcanDate(dt);
    if (!PUSH) {
      console.log(`  [dry] ${r.number}  "${name}"  event_date=${date}  (window opens, dep ${r.depTimeUtc}z)`);
      continue;
    }
    try {
      const event = await vatcanCreateEvent({ name, dateUtc: date, eventOwnerCid: OWNER_CID });
      const id = event?.event_id;
      if (!id) throw new Error('no event_id in response: ' + JSON.stringify(event));
      await prisma.wfScheduleRow.update({ where: { id: r.id }, data: { vatcanEventId: id } });
      console.log(`  [ok ] ${r.number}  event_id=${id}  event_date=${date}`);
      created++;
    } catch (e) {
      console.error(`  [fail] ${r.number}: ${e.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`  Done. created=${created} failed=${failed} skipped=${skipped} dry=${!PUSH ? candidates.length - skipped : 0}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await prisma.$disconnect();
  process.exit(1);
});
