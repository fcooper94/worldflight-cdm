import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import express from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/* ===========================
   OFFICIAL TEAM CALLSIGN RULES
   =========================== */

async function isReservedTeamCallsign(callsign, cid) {
  const normalized = callsign.trim().toUpperCase();

  const team = await prisma.officialTeam.findFirst({
    where: {
      callsign: normalized,
      participatingWf26: true
    }
  });

  if (!team) {
    return { reserved: false };
  }

  if (Number(team.mainCid) !== Number(cid)) {
    return {
      reserved: true,
      allowed: false,
      teamName: team.teamName
    };
  }

  return {
    reserved: true,
    allowed: true
  };
}


import path from 'path';
import { fileURLToPath } from 'url';

import 'dotenv/config';
import session from 'express-session';
import axios from 'axios';
import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import cron from 'node-cron';
import renderLayout from './layout.js';

import { createServer } from 'http';
import { Server } from 'socket.io';







const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const allTobtSlots = {}; // slotKey -> { from, to, dateUtc, depTimeUtc, tobt }



let cachedPilots = [];

async function refreshPilots() {
  try {
    const res = await axios.get(
      'https://data.vatsim.net/v3/vatsim-data.json'
    );
    cachedPilots = res.data.pilots || [];
    console.log('[VATSIM] Pilots refreshed:', cachedPilots.length);
  } catch (err) {
    console.error('[VATSIM] Failed to refresh pilots:', err.message);
    cachedPilots = [];
  }
}

async function loadTobtBookingsFromDb() {
  const bookings = await prisma.tobtBooking.findMany();

  bookings.forEach(b => {
    tobtBookingsBySlot[b.slotKey] = {
  slotKey: b.slotKey,   // ← REQUIRED
  cid: b.cid,
  callsign: b.callsign,
  from: b.from,
  to: b.to,
  dateUtc: b.dateUtc,
  depTimeUtc: b.depTimeUtc,
  tobtTimeUtc: b.tobtTimeUtc,
  createdAtISO: b.createdAt.toISOString()
};


    // ONLY index by CID if CID exists (pilot booking)
    if (b.cid !== null) {
      if (!tobtBookingsByCid[b.cid]) {
        tobtBookingsByCid[b.cid] = new Set();
      }
      tobtBookingsByCid[b.cid].add(b.slotKey);
    }
  });

  console.log(`[TOBT] Loaded ${bookings.length} bookings from DB`);
}





/* ===== EXPRESS + HTTP SERVER ===== */
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpServer = createServer(app);
const io = new Server(httpServer);

/* ================= ICAO-SCOPED EMIT HELPER ================= */

function emitToIcao(icao, event, payload) {
  if (!icao) return;
  io.to(`icao:${icao.toUpperCase()}`).emit(event, payload);
}


io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});



/* ===== SHARED STATE (GLOBAL) ===== */
const sharedToggles = {};      // { callsign: { clearance: bool, start: bool, sector?: "EGCC-EGLL" } }
const sharedDepFlows = {};     // { "EGCC-EGLL": 3, ... }  (per sector: FROM-TO)
const connectedUsers = {};     // { socketId: { cid, position } }

/* ===== DEP FLOW PERSISTENCE ===== */
async function loadDepFlowsFromDb() {
  const flows = await prisma.depFlow.findMany();
  flows.forEach(f => {
    sharedDepFlows[f.sector] = f.rate;
  });
  console.log(`[DEP FLOW] Loaded ${flows.length} flow rates from DB`);
}

const tobtBookingsBySlot = {}; // slotKey -> { cid, createdAtISO, callsign }
const tobtBookingsByCid = {};  // { cid: Set(slotKey) }


/**
 * sharedTSAT is the authoritative TSAT store:
 * {
 *   "BAW123": { tsat: "14:32", icao?: "EGCC" }
 * }
 */
const sharedTSAT = {};

/**
 * recentlyStarted:
 * {
 *   "BAW123": { tsat: "14:32", icao: "EGCC", startedAt: "14:35" }
 * }
 */
let recentlyStarted = {};

const startedAircraft = {}; // { "BAW123": true }

/**
 * TSAT queues per sector:
 * {
 *   "EGCC-EGLL": [
 *     { callsign: "BAW123", tsat: Date },
 *     { callsign: "EZY45",  tsat: Date }
 *   ]
 * }
 */


const tsatQueues = {};

function getTobtBookingForCallsign(callsign, icao) {
  const cs = callsign.trim().toUpperCase();

  for (const booking of Object.values(tobtBookingsBySlot)) {
    if (
      booking.callsign === cs &&
      booking.from === icao
    ) {
      return booking; // includes tobtTimeUtc
    }
  }
  return null;
}

function hhmmColonToHHMM(time) {
  if (!time) return '';
  return time.replace(':', '');
}


function getNextAvailableTobts(from, to, limit = 5) {
  return Object.entries(allTobtSlots)
    .filter(([slotKey, slot]) =>
      slot.from === from &&
      slot.to === to &&
      !tobtBookingsBySlot[slotKey]
    )
    .map(([slotKey, slot]) => ({
      slotKey,
      tobt: slot.tobt
    }))
    .sort((a, b) => a.tobt.localeCompare(b.tobt))
    .slice(0, limit);
}

function requireLogin(req, res, next) {
  if (req.session?.user?.data) {
    return next();
  }

  // Save where the user wanted to go
  req.session.returnTo = req.originalUrl;

  return res.redirect('/');
}



function canEditIcao(user, pageIcao) {
  if (!user) return false;
  if (ADMIN_CIDS.includes(Number(user.cid))) return true;

  const cs = user.callsign || '';
  return cs.startsWith(pageIcao + '_') && !cs.endsWith('_OBS');
}

// Basic HTML escaping for any user/admin-provided text rendered into server-side templates
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rebuildAllTobtSlots() {
  // Clear existing slots
  Object.keys(allTobtSlots).forEach(k => delete allTobtSlots[k]);

  for (const row of adminSheetCache) {
    const { from, to, date_utc, dep_time_utc } = row;

    // Only generate TOBTs if a dep flow exists
    const slots = generateTobtSlots({
      from,
      to,
      dateUtc: date_utc,
      depTimeUtc: dep_time_utc
    });

    if (!slots) continue; // no flow defined → no TOBTs

    for (const tobt of slots) {
      const slotKey = makeTobtSlotKey({
        from,
        to,
        dateUtc: date_utc,
        depTimeUtc: dep_time_utc,
        tobtTimeUtc: tobt
      });

      allTobtSlots[slotKey] = {
        from,
        to,
        dateUtc: date_utc,
        depTimeUtc: dep_time_utc,
        tobt
      };
    }
  }

  console.log(
    `[TOBT] Rebuilt allTobtSlots: ${Object.keys(allTobtSlots).length} slots`
  );
}




/* ===== RECENTLY STARTED HELPER ===== */
function buildRecentlyStartedForICAO(icao) {
  return Object.entries(recentlyStarted)
    .filter(([cs, e]) => e.icao === icao)
    .map(([callsign, entry]) => ({
      callsign,
      startedAt: entry.startedAt
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/* ===== UPCOMING TSAT HELPER ===== */
function buildUpcomingTSATsForICAO(icao, vatsimPilots = []) {
  const list = [];

  for (const [callsign, tsatObj] of Object.entries(sharedTSAT)) {
    if (startedAircraft[callsign]) continue;

    if (tsatObj.icao !== icao) continue;

    let dest = '----';
    const pilot = vatsimPilots.find(p => p.callsign === callsign);
    if (pilot?.flight_plan) {
      dest = pilot.flight_plan.arrival || dest;
    }

    list.push({
      callsign,
      dest,
      tsat: tsatObj.tsat
    });
  }

  const now = new Date();

  return list
    .sort((a, b) => {
      const da = hhmmToOperationalUtcDate(a.tsat, now);
      const db = hhmmToOperationalUtcDate(b.tsat, now);

      // Push invalid TSATs to bottom
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;

      return da - db;
    })
    .slice(0, 5);
}


function buildUnassignedTobtsForICAO(icao) {
  if (!icao) return [];

  const normalizedIcao = icao.toUpperCase();

  return Object.entries(allTobtSlots)
    .filter(([key, slot]) => {
      return (
        slot.from === normalizedIcao &&
        !tobtBookingsBySlot[key]   // ✅ NOT BOOKED
      );
    })
    .map(([key, slot]) => ({
      tobt: slot.tobt,
      to: slot.to
    }))
    .sort((a, b) => a.tobt.localeCompare(b.tobt));
}

function isWorldFlightDestination(icao) {
  const upper = String(icao).toUpperCase();

  return adminSheetCache.some(row =>
    row.from === upper || row.to === upper
  );
}




/* ===== ADMIN CID WHITELIST ===== */
const ADMIN_CIDS = [10000010, 1303570, 10000005];

/* ===== GOOGLE SHEET ===== */
const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];
let lastDepartureSnapshot = new Set();

const port = process.env.PORT || 8080;

/* ================= TSAT HELPERS (SERVER) ================= */

/**
 * Normalise sector key as FROM-TO, e.g. "EGCC-EGLL"
 */
function normalizeSectorKey(sectorRaw) {
  if (!sectorRaw) return 'UNKNOWN-UNKNOWN';
  return sectorRaw.trim().toUpperCase();
}

/**
 * Assign a TSAT for a callsign within a sector queue with these rules:
 * - Earliest = now + 1 minute
 * - If flow <= 31: min spacing = 2 minutes
 * - If flow > 31: spacing = floor(60 / flow), >= 1 minute
 * - At most `flow` TSATs in any rolling 60-minute window
 * - Uses the earliest available valid slot, so it can backfill gaps
 *   if the hour is not yet "full".
 */
function assignTSAT(sectorKey, callsign) {
  const sector = normalizeSectorKey(sectorKey);

  const flowPerHourRaw = sharedDepFlows[sector];
  const flowPerHour = flowPerHourRaw ? Number(flowPerHourRaw) : 60; // default 60/h

  const now = new Date();
  now.setSeconds(0, 0);

    // 🔒 TOBT lower bound (if exists)
  let tobtLowerBound = null;

  // Determine FROM ICAO from sector (FROM-TO)
  const fromIcao = sector.split('-')[0];

  // Look up TOBT for this aircraft
  const tobtBooking = getTobtBookingForCallsign(callsign, fromIcao);

  if (tobtBooking?.tobtTimeUtc) {
    const [hh, mm] = tobtBooking.tobtTimeUtc.split(':').map(Number);

    const tobtDate = new Date(now);
tobtDate.setUTCHours(hh, mm, 0, 0);

// 🔁 If TOBT time is earlier than now, assume NEXT UTC DAY
if (tobtDate <= now) {
  tobtDate.setUTCDate(tobtDate.getUTCDate() + 1);
}

tobtLowerBound = tobtDate;

  }


    let earliest = new Date(now.getTime() + 1 * 60000);

  // 🔒 Enforce TSAT ≥ TOBT
  if (tobtLowerBound && tobtLowerBound > earliest) {
    earliest = tobtLowerBound;
  }


  if (!tsatQueues[sector]) tsatQueues[sector] = [];
  let queue = tsatQueues[sector];

  // Remove existing entry for this callsign and prune old entries (older than 60 min in the past)
  const cutoffPast = new Date(now.getTime() - 60 * 60000);
  queue = queue.filter(
    entry =>
      entry.callsign !== callsign &&
      entry.tsat >= cutoffPast
  );

  tsatQueues[sector] = queue;

  // Minimum spacing rule
  const minIntervalMinutes =
    flowPerHour <= 31
      ? 2
      : Math.max(1, Math.floor(60 / flowPerHour));

  const maxPerHour = flowPerHour; // hard cap per 60-min window

  // Start searching from the earliest allowed time
  let candidate = new Date(earliest);

  while (true) {
    const windowStart = new Date(candidate.getTime() - 60 * 60000);

    const inWindow = queue.filter(
      entry => entry.tsat >= windowStart && entry.tsat <= candidate
    );

    // Enforce flow capacity per rolling hour
    if (inWindow.length >= maxPerHour) {
      candidate = new Date(candidate.getTime() + 1 * 60000);
      continue;
    }

    // Enforce minimum spacing from any existing TSAT in the window
    const tooClose = inWindow.some(entry => {
      return Math.abs(entry.tsat - candidate) < minIntervalMinutes * 60 * 1000;
    });

    if (!tooClose) break; // found a valid slot

    candidate = new Date(candidate.getTime() + 1 * 60000);
  }

  // Save into queue
  queue.push({ callsign, tsat: candidate });
  queue.sort((a, b) => a.tsat - b.tsat);
  tsatQueues[sector] = queue;

  const tsatStr =
    candidate.getHours().toString().padStart(2, '0') +
    ':' +
    candidate.getMinutes().toString().padStart(2, '0');

  // Store TSAT as an object
  sharedTSAT[callsign] = {
  tsat: tsatStr,
  icao: sector.split('-')[0]
};


  return tsatStr;
}

/**
 * Clear TSAT for a given callsign in a sector.
 */
function clearTSAT(sectorKey, callsign) {
  const sector = normalizeSectorKey(sectorKey);

  if (tsatQueues[sector]) {
    tsatQueues[sector] = tsatQueues[sector].filter(
      entry => entry.callsign !== callsign
    );
    if (tsatQueues[sector].length === 0) {
      delete tsatQueues[sector];
    }
  }
  delete sharedTSAT[callsign];
}

async function bootstrap() {
  await refreshPilots();
  await loadDepFlowsFromDb();
  await loadTobtBookingsFromDb();

  await refreshAdminSheet();   // 🔑 REQUIRED
  rebuildAllTobtSlots();       // 🔑 NOW WORKS

  setInterval(refreshPilots, 60000);
}


bootstrap().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

function getWfAirportsSet() {
  const s = new Set();
  for (const row of adminSheetCache) {
    if (row.from) s.add(String(row.from).toUpperCase());
    if (row.to)   s.add(String(row.to).toUpperCase());
  }
  return s;
}

const SCENERY_FILE = path.join(__dirname, 'data', 'scenery-links.json');

function refreshSceneryLinksFile() {
  const wfSet = getWfAirportsSet();

  // ensure /data exists
  const dataDir = path.dirname(SCENERY_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const existing = fs.existsSync(SCENERY_FILE)
    ? JSON.parse(fs.readFileSync(SCENERY_FILE, 'utf8'))
    : {};

  const next = {};

  for (const icao of wfSet) {
    next[icao] = existing[icao] || { msfs: [], xplane: [], p3d: [] };
  }

  fs.writeFileSync(SCENERY_FILE, JSON.stringify(next, null, 2));
  return { count: wfSet.size };
}

function extractTSATMap() {
  return Object.fromEntries(
    Object.entries(sharedTSAT).map(([cs, obj]) => [cs, obj.tsat])
  );
}
function rebuildTSATStateForICAO(icao) {
  Object.entries(sharedToggles).forEach(([callsign, toggles]) => {
    if (!toggles.start) return;
    if (!toggles.sector) return;

    const fromIcao = toggles.sector.split('-')[0];
    if (fromIcao !== icao) return;

    // If START is already true but TSAT does not exist, rebuild it
    if (!sharedTSAT[callsign]) {
      assignTSAT(toggles.sector, callsign);
    }
  });
}


/* ================= SOCKET.IO ================= */
io.on('connection', async socket => {

  console.log('Client connected:', socket.id);

  const user = socket.request.session?.user?.data || null;
const icaoFromQuery = socket.handshake.query?.icao || null;
if (icaoFromQuery) {
  const room = `icao:${icaoFromQuery.toUpperCase()}`;
  socket.join(room);
}


// ✅ Rebuild TSATs for late joiners (keep this)
if (icaoFromQuery) rebuildTSATStateForICAO(icaoFromQuery);

// ✅ These can stay as-is
socket.emit('syncState', sharedToggles);
socket.emit('syncDepFlows', sharedDepFlows);
socket.emit(
  'unassignedTobtUpdate',
  buildUnassignedTobtsForICAO(icaoFromQuery)
);


// ✅ IMPORTANT: emit a string map, not objects (fixes [object Object])
socket.emit('syncTSAT', extractTSATMap());

socket.emit('tsatStartedUpdated', startedAircraft);

if (icaoFromQuery) {
  socket.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icaoFromQuery, cachedPilots));
  socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icaoFromQuery));
}


  socket.on('requestInitialTSATState', ({ icao }) => {
    if (!icao) return;
    socket.emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);


    socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icao));
  });

  socket.on('requestToggleStateSync', () => {
    socket.emit('syncState', sharedToggles);
  });

  socket.on('requestTSATSync', () => {
    socket.emit(
      'syncTSAT',
      Object.fromEntries(
        Object.entries(sharedTSAT).map(([cs, obj]) => [cs, obj.tsat])
      )
    );
  });
  socket.on('requestSyncAllState', ({ icao }) => {
  if (!icao) return;

  rebuildTSATStateForICAO(icao);

  socket.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icao, cachedPilots));
  socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icao));

  socket.emit('unassignedTobtUpdate', buildUnassignedTobtsForICAO(icao));

  socket.emit('syncState', sharedToggles);
  socket.emit('syncDepFlows', sharedDepFlows);
  socket.emit('syncTSAT', extractTSATMap());
  socket.emit('tsatStartedUpdated', startedAircraft);
});



  socket.on('requestStartedStateSync', () => {
    socket.emit('tsatStartedUpdated', startedAircraft);
  });

  /* =========================================================
     PERMISSION HELPER
     ========================================================= */

  function canEditSector(sector) {
    if (!user || !sector) return false;
    const pageIcao = sector.split('-')[0];
    return ADMIN_CIDS.includes(Number(user.cid)) || canEditIcao(user, pageIcao);
  }

  /* =========================================================
     TOGGLES (CLR / START)
     ========================================================= */

  socket.on('updateToggle', ({ callsign, type, value, sector }) => {
  if (!callsign || type !== 'start') return;

    if (!canEditSector(sector)) return;

    if (!sharedToggles[callsign]) sharedToggles[callsign] = {};
    sharedToggles[callsign].start = value;

    if (sector) {
      sharedToggles[callsign].sector = normalizeSectorKey(sector);
    }

    const activeSector = sector || sharedToggles[callsign].sector;
    const icao = activeSector?.split('-')[0];

    if (type === 'start' && value === true && activeSector) {
      const tsat = assignTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat });
      io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    }

    if (type === 'start' && value === false && activeSector) {
      clearTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat: '' });
      io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    }

    io.emit('toggleUpdated', { callsign, type, value });
  });

  /* =========================================================
     TSAT MANIPULATION
     ========================================================= */

  socket.on('requestTSAT', async ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    const tsat = assignTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat });
    io.emit(
      'upcomingTSATUpdate',
      buildUpcomingTSATsForICAO(sector.split('-')[0])
    );
  });

  socket.on('recalculateTSAT', ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    const tsat = assignTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat });
  });

  socket.on('cancelTSAT', ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    clearTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat: '' });
    io.emit(
      'upcomingTSATUpdate',
      buildUpcomingTSATsForICAO(sector.split('-')[0])
    );
  });

  socket.on('updateTSAT', ({ callsign, tsat }) => {
    if (!callsign) return;
    sharedTSAT[callsign] = { tsat };
    io.emit('tsatUpdated', { callsign, tsat });
  });

  /* =========================================================
     STARTED / RECENTLY STARTED
     ========================================================= */

  socket.on('markTSATStarted', ({ callsign }) => {
    const sector = sharedToggles[callsign]?.sector;
    if (!canEditSector(sector)) return;

    const icao = sector.split('-')[0];
    const entry = sharedTSAT[callsign];
    if (!entry) return;

    startedAircraft[callsign] = true;
    recentlyStarted[callsign] = {
      tsat: entry.tsat,
      icao,
      startedAt: new Date().toISOString().slice(11, 16)
    };

    io.emit('tsatStartedUpdated', startedAircraft);
    io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    io.emit(
  'recentlyStartedUpdate',
  buildRecentlyStartedForICAO(icao)
);

  });

  socket.on('sendBackToUpcoming', ({ callsign }) => {
  const entry = recentlyStarted[callsign];
  if (!entry) return;
  if (!canEditIcao(user, entry.icao)) return;

  if (entry.tsat) {
    sharedTSAT[callsign] = {
      tsat: entry.tsat,
      icao: entry.icao   // 🔑 REQUIRED
    };
  }

  delete recentlyStarted[callsign];
  delete startedAircraft[callsign];

  io.emit('tsatStartedUpdated', startedAircraft);
  io.emit(
    'upcomingTSATUpdate',
    buildUpcomingTSATsForICAO(entry.icao, cachedPilots)
  );
  io.emit(
    'recentlyStartedUpdate',
    buildRecentlyStartedForICAO(entry.icao)
  );
});


  socket.on('deleteStartedEntry', ({ callsign }) => {
    const entry = recentlyStarted[callsign];
    if (!entry) return;
    if (!canEditIcao(user, entry.icao)) return;

    delete recentlyStarted[callsign];
    delete startedAircraft[callsign];

    io.emit(
      'recentlyStartedUpdate',
      buildRecentlyStartedForICAO(entry.icao)
    );
  });

  /* =========================================================
     DEP FLOWS
     ========================================================= */

 socket.on('updateDepFlow', async ({ sector, value }) => {
  const key = normalizeSectorKey(sector);
  const rate = Number(value) || 0;

  if (rate === 0) {
    delete sharedDepFlows[key];

    await prisma.depFlow.deleteMany({
      where: { sector: key }
    });

    io.emit('depFlowUpdated', { sector: key, value: 0 });
    return;
  }

  sharedDepFlows[key] = rate;

  await prisma.depFlow.upsert({
    where: { sector: key },
    update: { rate },
    create: { sector: key, rate }
  });

  io.emit('depFlowUpdated', { sector: key, value: rate });
});



  /* =========================================================
     CONNECTED USERS
     ========================================================= */

  socket.on('registerUser', ({ cid, position }) => {
    connectedUsers[socket.id] = { cid, position };
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
    console.log('Client disconnected:', socket.id);
  });
});


/* ===== ADMIN SHEET REFRESH ===== */
async function refreshAdminSheet() {
  try {
    const res = await axios.get(GOOGLE_SHEET_CSV_URL);

    const lines = res.data.split('\n').map(l => l.trim()).filter(Boolean);
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

    const idx = {
      number: headers.indexOf('Number'),
  from: headers.indexOf('From'),
  to: headers.indexOf('To'),
  date_utc: headers.indexOf('Date_UTC'),
  dep_time_utc: headers.indexOf('Dep_Time_UTC'),
  arr_time_utc: headers.indexOf('Arr_Time_UTC'),
  block_time: headers.indexOf('Block_Time'),
  atc_route: headers.indexOf('ATC_Route')
    };

    adminSheetCache = lines.slice(1).map(line => {
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      return {
        number: cols[idx.number] || '',
    from: cols[idx.from] || '',
    to: cols[idx.to] || '',
    date_utc: cols[idx.date_utc] || '',
    dep_time_utc: cols[idx.dep_time_utc] || '',
    arr_time_utc: cols[idx.arr_time_utc] || '',
    block_time: cols[idx.block_time] || '',
    atc_route: cols[idx.atc_route] || ''
      };
    });

    console.log('✅ Admin Sheet refreshed:', adminSheetCache.length, 'rows');
  } catch (err) {
    console.error('❌ Failed to refresh Admin Sheet:', err.message);
  }
}

refreshAdminSheet();
cron.schedule('0 0 * * *', refreshAdminSheet);

/* ===== SESSION ===== */
const sessionMiddleware = session({
  name: 'worldflight.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
});

app.use(sessionMiddleware);

// HOME: logged in → dashboard, logged out → login page


app.get('/dashboard', (req, res) => {
  return res.redirect(301, '/schedule');
});



/* ===== ADMIN AUTH ===== */
function requireAdmin(req, res, next) {
  const cid = req.session?.user?.data?.cid;
  if (!cid || !ADMIN_CIDS.includes(Number(cid))) {
    return res.status(403).send('Access Denied: Admins Only');
  }
  next();
}

function normalizeRoute(route, adminRoute = null) {
  if (!route) return [];

  let tokens = route
    .toUpperCase()
    .replace(/\/\d+[A-Z]?/g, '')      // remove runway suffixes (/27R)
    .replace(/\bN\d+F\d+\b/g, '')     // remove speed/level (N0456F350)
    .split(/\s+/)
    .filter(Boolean);

  // Remove trailing STAR(s) and destination ICAO
  while (
    tokens.length &&
    (
      /^[A-Z]{4}$/.test(tokens[tokens.length - 1]) || // destination ICAO
      /\d[A-Z]$/.test(tokens[tokens.length - 1])      // STAR like IMCO1A
    )
  ) {
    tokens.pop();
  }

  // If adminRoute provided, align from first matching fix
  if (adminRoute) {
    const adminTokens = adminRoute
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean);

    const firstFix = adminTokens[0];
    const idx = tokens.indexOf(firstFix);

    if (idx !== -1) {
      tokens = tokens.slice(idx);
    }
  }

  return tokens;
}




/* ===== WF STATUS ===== */
function getWorldFlightStatus(pilot) {
  if (!pilot.flight_plan) return { isWF: false, routeMatch: false };

  const from = pilot.flight_plan.departure;
  const to = pilot.flight_plan.arrival;
  const route = pilot.flight_plan.route || '';

  const match = adminSheetCache.find(
    wf => wf.from === from && wf.to === to
  );
  if (!match) return { isWF: false, routeMatch: false };

  const adminTokens = normalizeRoute(match.atc_route);
  const liveTokens = normalizeRoute(route, match.atc_route);

  return {
    isWF: true,
    routeMatch:
      adminTokens.join(' ') === liveTokens.join(' ')
  };
}

app.get('/api/icao/:icao/scenery-links', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  // Optional: WF-only guard (keep if you want)
  

  const rows = await prisma.airportScenery.findMany({
    where: {
      icao,
      approved: true
    },
    orderBy: [
      { sim: 'asc' },
      { name: 'asc' }
    ]
  });

  // Group by simulator for existing frontend
  const result = {
    msfs: [],
    xplane: [],
    p3d: []
  };

  for (const r of rows) {
    if (r.sim === 'MSFS') result.msfs.push(r);
    if (r.sim === 'XPLANE') result.xplane.push(r);
    if (r.sim === 'P3D') result.p3d.push(r);
  }

  res.json(result);
});


app.post('/admin/scenery/refresh-links', requireAdmin, (req, res) => {
  const result = refreshSceneryLinksFile();
  res.json({ success: true, ...result });
});


app.get('/api/icao/:icao/map', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const airport = await prisma.airport.findUnique({
  where: { icao },
  include: { runways: true }
});


  if (!airport) {
    return res.status(404).json({ error: 'Airport not found' });
  }

  function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const aircraft = cachedPilots
  // must have a flight plan
  .filter(p => p.flight_plan)

  // ✅ departures only
  .filter(p => p.flight_plan.departure === icao)

  // must have position
  .filter(p => p.latitude && p.longitude)
.filter(p => {
  const d = distanceNm(
    airport.lat,
    airport.lon,
    p.latitude,
    p.longitude
  );

  const altMSL = Number(p.altitude ?? 0);
  const airportElev = Number(airport.elev ?? 0);
  const altAGL = altMSL - airportElev;

  return (
    d <= 8 &&                 // spatial clamp
    altAGL >= -50 &&          // allow slight negatives
    altAGL <= 200             // surface / flare / rollout
  );
})


  .map(p => ({
    callsign: p.callsign,
    lat: p.latitude,
    lon: p.longitude,
    heading: p.heading,
    groundspeed: p.groundspeed,
    altitude: p.altitude
  }));





  res.json({ airport, aircraft });
});



app.use(express.static('public'));
function parseUtcDateTime(dateUtc, timeUtc) {
  let year = new Date().getUTCFullYear();

  // Handle ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
    const [y, m, d] = dateUtc.split('-').map(Number);
    const [hh, mm] = timeUtc.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  }

  // Handle "Sat 1st Nov", "Mon 22nd Jan", etc.
  // 1️⃣ Remove weekday
  let cleaned = dateUtc.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, '');

  // 2️⃣ Remove ordinal suffixes (st, nd, rd, th)
  cleaned = cleaned.replace(/(\d+)(st|nd|rd|th)/i, '$1');

  // cleaned now looks like "1 Nov"
  const parsed = Date.parse(`${cleaned} ${year} UTC`);
  if (isNaN(parsed)) {
    throw new Error('Invalid date format: ' + dateUtc);
  }

  const date = new Date(parsed);

  const [hh, mm] = timeUtc.split(':').map(Number);
  date.setUTCHours(hh, mm, 0, 0);

  return date;
}

function hhmmToNextUtcDate(hhmm, nowUtc = new Date()) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;

  const [hh, mm] = hhmm.split(':').map(Number);

  const d = new Date(nowUtc);
  d.setUTCSeconds(0, 0);
  d.setUTCHours(hh, mm, 0, 0);

  // If the time is not in the future, treat it as next day
  if (d <= nowUtc) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d;
}

function buildTimeWindow(hhmm) {
  if (!hhmm) return '';
  return `${subtractMinutes(hhmm, 60)}–${addMinutes(hhmm, 60)}`;
}

function addMinutes(timeStr, minutes) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, hh, mm));
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().substring(11, 16);
}


function hhmmToOperationalUtcDate(hhmm, nowUtc = new Date()) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;

  const [hh, mm] = hhmm.split(':').map(Number);

  const d = new Date(nowUtc);
  d.setUTCSeconds(0, 0);
  d.setUTCHours(hh, mm, 0, 0);

  const diffMs = nowUtc - d;
  const diffHours = diffMs / (1000 * 60 * 60);

  // If TSAT is more than 4 hours in the past, assume next day
  if (diffHours > 4) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d;
}


function formatUtcHHMM(date) {
  return date.toISOString().substring(11, 16);
}

function subtractMinutes(timeStr, minutes) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, hh, mm));
  date.setUTCMinutes(date.getUTCMinutes() - minutes);
  return date.toISOString().substring(11, 16);
}


function generateTobtSlots({ from, to, dateUtc, depTimeUtc }) {
  const dep = parseUtcDateTime(dateUtc, depTimeUtc);

  // Inclusive window
  const windowStart = new Date(dep.getTime() - 60 * 60 * 1000);
  const windowEnd   = new Date(dep.getTime() + 60 * 60 * 1000);

  const flowKey = `${from}-${to}`;
  const flow = Number(sharedDepFlows[flowKey]);

if (!flow || flow <= 0) {
  return null; // Explicitly signal "no flow defined"
}

  const intervalMinutes = Math.max(1, Math.floor(60 / flow));

  const slots = [];

  // Use a fresh cursor and NEVER mutate windowStart
  let cursor = new Date(windowStart);

  while (cursor <= windowEnd) {
    slots.push(formatUtcHHMM(cursor));
    cursor = new Date(cursor.getTime() + intervalMinutes * 60000);
  }

  return slots;
}


function makeTobtSlotKey({ from, to, dateUtc, depTimeUtc, tobtTimeUtc }) {
  return `${from}-${to}|${dateUtc}|${depTimeUtc}|${tobtTimeUtc}`;
}
app.get('/', (req, res) => {
  if (req.session?.user?.data) {
    return res.redirect('/schedule');
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});






app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/schedule', (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
const isAdmin = ADMIN_CIDS.includes(cid);
const myBookings = cid ? tobtBookingsByCid[cid] : null;

  const content = `
  <section class="card card-full">
    <h2>WorldFlight Event Schedule</h2>

    <div class="table-scroll">
      <table class="departures-table">
        <thead>
  <tr>
    <th class="col-wf-sector">WF</th>
    <th class="col-from">Dep</th>
    <th class="col-to">Arr</th>
    <th class="col-date">Date</th>
    <th class="col-window">Dep Window</th>
    <th class="col-window">Arr Window</th>
    <th class="col-time">Block Time</th>
    <th class="col-route">ATC Route</th>
    <th class="col-book">Book Slot</th>
    <th class="col-plan">Plan</th>
    
  </tr>
</thead>

        <tbody>
          ${adminSheetCache.map(r => `
            <tr>
              <td class="col-wf-sector">${r.number}</td>
              <td class="col-from">
                <a href="/icao/${r.from}">
                  ${r.from}
                </a>
              </td>
              <td class="col-to">
                <a href="/icao/${r.to}">
                  ${r.to}
                </a>
              </td>
              <td class="col-date">${r.date_utc}</td>
              <td class="col-window">${buildTimeWindow(r.dep_time_utc)}</td>
              <td class="col-window">${buildTimeWindow(r.arr_time_utc)}</td>
              <td class="col-time">${r.block_time}</td>
              <td class="col-route">
  <div class="route-collapsible">
    <span class="route-text collapsed">
      ${escapeHtml(r.atc_route)}
    </span>
    <button
      type="button"
      class="route-toggle"
      aria-expanded="false">
      Expand
    </button>
  </div>
</td>

<td class="col-book">
  ${
    (() => {
      if (!myBookings) {
        return `
          <a class="tobt-btn book"
             href="/book?from=${r.from}&to=${r.to}&dateUtc=${encodeURIComponent(r.date_utc)}&depTimeUtc=${r.dep_time_utc}">
            Book Slot
          </a>
        `;
      }

      const sectorKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;

      const mySlotKey = [...myBookings].find(k =>
        k.startsWith(sectorKey + '|')
      );

      if (!mySlotKey) {
        return `
          <a class="tobt-btn book"
             href="/book?from=${r.from}&to=${r.to}&dateUtc=${encodeURIComponent(r.date_utc)}&depTimeUtc=${r.dep_time_utc}">
            Book Slot
          </a>
        `;
      }

      return `
        <button
          class="tobt-btn cancel"
          data-slot-key="${mySlotKey}">
          Cancel
        </button>
      `;
    })()
  }
</td>

<td class="col-plan">
  ${
    (() => {
      // Base SimBrief URL (always present)
      let url =
        `https://dispatch.simbrief.com/options/custom` +
        `?orig=${r.from}` +
        `&dest=${r.to}` +
        `&route=${encodeURIComponent(r.atc_route)}`;

      // If user has bookings, check this sector
      if (myBookings) {
        const sectorKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;

        const mySlotKey = [...myBookings].find(k =>
          k.startsWith(sectorKey + '|')
        );

        if (mySlotKey) {
          const booking = tobtBookingsBySlot[mySlotKey];
          const [h, m] = booking.tobtTimeUtc.split(':').map(Number);

const hh = String(h).padStart(2, '0');
const mm = String(m).padStart(2, '0');


url +=
  `&callsign=${encodeURIComponent(booking.callsign)}` +
  `&deph=${hh}` +
  `&depm=${mm}` +
  `&manualrmk=${encodeURIComponent(`WF TOBT [SLOT] ${hh}:${mm} UTC - Route validated from www.worldflight.center`)}`;

        } else {
          url +=
            `&manualrmk=${encodeURIComponent(
              'Route validated from www.worldflight.center'
            )}`;
        }
      } else {
        url +=
          `&manualrmk=${encodeURIComponent(
            'Route validated from www.worldflight.center'
          )}`;
      }

      // ✅ THIS WAS MISSING
      return `
        <a class="simbrief-btn"
           href="${url}"
           target="_blank"
           rel="noopener">
          <span class="simbrief-logo">SB</span>
          <span class="simbrief-text">Plan with SimBrief</span>
        </a>
      `;
    })()
  }
</td>


            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </section>
  <script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.route-toggle');
  if (!btn) return;

  const wrapper = btn.closest('.route-collapsible');
  const text = wrapper.querySelector('.route-text');

  const expanded = btn.getAttribute('aria-expanded') === 'true';

  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Expand' : 'Collapse';

  text.classList.toggle('collapsed', expanded);
});
</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tobt-btn.cancel');
  if (!btn) return;

  const slotKey = btn.dataset.slotKey;
  if (!slotKey) return;

  const ok = await openConfirmModal({
    title: 'Cancel TOBT Slot',
    message: 'Are you sure you want to cancel this booking?'
  });

  if (!ok) return;

  const res = await fetch('/api/tobt/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ slotKey })
  });

  if (!res.ok) {
    alert('Failed to cancel booking');
    return;
  }

  location.reload();
});

</script>



  `;

  res.send(renderLayout({
    title: 'WorldFlight Schedule',
    user: req.session.user?.data || null,
    isAdmin,
    content,
    layoutClass: 'dashboard-full schedule-page'
  }));
});

app.get('/api/icao/:icao/departures/live', (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const departures = cachedPilots
    .filter(p => p.flight_plan?.departure === icao)
    .filter(p => {
      const alt = Number(p.altitude || 0);
      const gs  = Number(p.groundspeed || 0);
      return alt < 500 && gs < 40;
    })
    .map(p => {
      let status = 'At Gate';
      if (p.groundspeed >= 5) status = 'Taxiing';

      return {
        status,
        callsign: p.callsign,
        aircraft: p.flight_plan.aircraft_short || p.flight_plan.aircraft || '—',
        destination: p.flight_plan.arrival || '—',
        route: p.flight_plan.route || ''
      };
    });

  // ✅ THIS WAS MISSING
  res.json(departures);
});



app.get('/api/icao/:icao/departures', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const list = buildUpcomingTSATsForICAO(icao, cachedPilots);
  res.json(list);
});

app.post('/admin/api/scenery/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await prisma.airportScenery.update({
    where: { id },
    data: {
      approved: true,
      approvedBy: req.session.user.data.name || 'Admin',
      approvedAt: new Date()
    }
  });

  res.json({ success: true });
});

app.post('/admin/api/scenery/:id/reject', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await prisma.airportScenery.delete({
    where: { id }
  });

  res.json({ success: true });
});

app.get('/admin/scenery', requireAdmin, (req, res) => {
  const user = req.session.user?.data || null;

  const content = `
    <section class="card card-narrow">
  <h2>Pending Scenery Submissions</h2>

  <div class="table-wrap">
    <table class="admin-table admin-scenery-table">
        <thead>
          <tr>
            <th>ICAO</th>
            <th>Sim</th>
            <th>Product</th>
            <th>Developer</th>
            <th>Store</th>
            <th>Type</th>
            <th>Submitted by</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody id="sceneryAdminTable">
          <tr>
            <td colspan="8" class="empty">Loading…</td>
          </tr>
        </tbody>
      </table>
  </div>
</section>

    <script>
      async function loadPendingScenery() {
        const tbody = document.getElementById('sceneryAdminTable');

        const res = await fetch('/admin/api/scenery/pending');

if (!res.ok) {
  console.error('Failed to load pending scenery', res.status);
  tbody.innerHTML =
    '<tr><td colspan="8" class="empty">Failed to load submissions</td></tr>';
  return;
}

const rows = await res.json();


        if (!rows.length) {
          tbody.innerHTML =
            '<tr><td colspan="8" class="empty">No pending submissions</td></tr>';
          return;
        }

       tbody.innerHTML = rows.map(r =>
  '<tr>' +
    '<td>' + r.icao + '</td>' +
    '<td><span class="sim-badge">' + r.sim + '</span></td>' +
    '<td><a href="' + r.url + '" target="_blank" rel="noopener">' + r.name + '</a></td>' +
    '<td>' + (r.developer || '—') + '</td>' +
    '<td>' + (r.store || '—') + '</td>' +
    '<td>' + r.type + '</td>' +
    '<td>' + (r.submittedBy || '—') + '</td>' +
    '<td class="actions">' +
      '<div class="action-group">' +
        '<button class="btn-approve" onclick="approveScenery(' + r.id + ')">Approve</button>' +
        '<button class="btn-reject" onclick="rejectScenery(' + r.id + ')">Reject</button>' +
      '</div>' +
    '</td>' +
  '</tr>'
).join('');

      }

      async function approveScenery(id) {
        const ok = confirm('Approve this scenery submission?');
        if (!ok) return;
        await fetch('/admin/api/scenery/' + id + '/approve', { method: 'POST' });
        loadPendingScenery();
      }

      async function rejectScenery(id) {
        const ok = confirm('Reject this scenery submission?');
        if (!ok) return;
        await fetch('/admin/api/scenery/' + id + '/reject', { method: 'POST' });
        loadPendingScenery();
      }

      document.addEventListener('DOMContentLoaded', loadPendingScenery);
    </script>
  `;

  res.send(renderLayout({
    title: 'Scenery Submissions',
    user,
    isAdmin: true,
    content,
    layoutClass: 'dashboard-full'
  }));
});




app.get('/admin/api/scenery/pending', requireAdmin, async (req, res) => {
  const rows = await prisma.airportScenery.findMany({
    where: { approved: false },
    orderBy: { submittedAt: 'asc' }
  });

  res.json(rows);
});



app.use('/uploads', express.static(path.join(__dirname, 'Uploads')));

app.get('/icao/:icao', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const content = `
  <section class="card">

  <div class="icao-top-row three-cols">

    <!-- LEFT: Upcoming Departures -->
    <div class="icao-deps">
  <div class="deps-scroll">
    <table class="departures-table">
      <thead>
        <tr>
          <th class="col-sts">STS</th>
          <th>Callsign</th>
          <th>A/C</th>
          <th>Dest</th>
          <th>ATC Route</th>
        </tr>
      </thead>
      <tbody id="upcomingDepartures"></tbody>
    </table>
  </div>
</div>


    <!-- MIDDLE: Online Controllers -->
    
    <ul id="onlineControllers" class="atc-list">
  <li class="atc-item">
    <span class="atc-callsign">EGCC_M_TWR</span>
    <span class="atc-freq">199.998</span>
  </li>
</ul>


    <!-- RIGHT: Map -->
    <div class="icao-map">
      <div id="icaoMap" data-icao="${icao}"></div>

      <div class="icao-map-footer">
        <button id="expandMapBtn" class="map-expand-btn">
          Expand map
        </button>
      </div>
    </div>

  </div>

</section>

<section class="card">
  <h2>Airport Documentation</h2>

  <table class="docs-table">
    <thead>
      <tr>
        <th>File Name</th>
        <th>Type</th>
        <th>Last Updated</th>
        <th>Submitted By</th>
      </tr>
    </thead>
    <tbody id="airportDocs"></tbody>
  </table>
</section>


<section class="card">
  <h2>Available Scenery</h2>
  <div id="airportScenery"></div>
  <button id="openSceneryModal" class="action-btn">
  ➕ Submit scenery for this airport
</button>

</section>

<div id="sceneryModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-dialog">
    <h3>Submit scenery for <span id="sceneryIcao"></span></h3>

    <form id="sceneryForm">
      <input type="hidden" name="icao" id="sceneryIcaoInput">

      <label>
        Simulator
        <select name="sim" required>
          <option value="">Select…</option>
          <option value="MSFS">MSFS</option>
          <option value="XPLANE">X-Plane</option>
          <option value="P3D">Prepar3D</option>
        </select>
      </label>

      <label>
        Product name
        <input name="name" required>
      </label>

      <label>
        Developer
        <input name="developer">
      </label>

      <label>
        Store
        <input name="store" placeholder="Orbx, SimMarket, flightsim.to">
      </label>

      <label>
        URL
        <input name="url" type="url" required>
      </label>

      <label>
        Type
        <select name="type" required>
          <option value="Freeware">Freeware</option>
          <option value="Payware">Payware</option>
        </select>
      </label>

      <div id="sceneryFormMessage" class="modal-message hidden"></div>

      <div class="modal-actions">
        <button
          type="button"
          class="modal-btn modal-btn-cancel"
          id="closeSceneryModal">
          Cancel
        </button>

        <button
          type="submit"
          class="modal-btn modal-btn-submit"
          id="submitSceneryBtn">
          Submit scenery
        </button>
      </div>
    </form>
  </div>
</div>


<script>
document.addEventListener('DOMContentLoaded', function () {
  var map = document.getElementById('icaoMap');
  if (!map) return;

  var icao = map.dataset.icao;
  if (!icao) return;

  /* ---------- INITIAL LOAD ---------- */
  loadDepartures(icao);
  loadControllers(icao);
  loadAirportDocs(icao);
  loadAirportScenery(icao);

  /* ---------- REFRESH EVERY 60s ---------- */
  setInterval(function () {
    loadDepartures(icao);
    loadControllers(icao);
  }, 60000);

  /* ---------- ROUTE EXPAND / COLLAPSE ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.route-toggle');
    if (!btn) return;

    var wrapper = btn.closest('.route-collapsible');
    var text = wrapper.querySelector('.route-text');

    var expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.textContent = expanded ? 'Expand' : 'Collapse';
    text.classList.toggle('collapsed', expanded);
  });

  /* ---------- SCENERY MODAL ---------- */
  var openBtn  = document.getElementById('openSceneryModal');
  var modal    = document.getElementById('sceneryModal');
  var closeBtn = document.getElementById('closeSceneryModal');
  var form     = document.getElementById('sceneryForm');
  var submitBtn = document.getElementById('submitSceneryBtn');
  var msg       = document.getElementById('sceneryFormMessage');

  if (openBtn && modal && form) {
    openBtn.addEventListener('click', function () {
      document.getElementById('sceneryIcao').textContent = icao;
      document.getElementById('sceneryIcaoInput').value = icao;
      modal.classList.remove('hidden');
    });

    function closeModal() {
      modal.classList.add('hidden');
      form.reset();
      msg.classList.add('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit scenery';
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    var backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeModal);

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      msg.classList.add('hidden');
      msg.textContent = '';

      try {
        var payload = Object.fromEntries(new FormData(form).entries());

        fetch('/api/scenery/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        .then(function (res) {
          if (!res.ok) throw new Error('Submit failed');

          msg.textContent = 'Scenery submitted for approval';
          msg.className = 'modal-message success';
          setTimeout(closeModal, 1500);
        })
        .catch(function () {
          msg.textContent = 'Failed to submit scenery. Please try again.';
          msg.className = 'modal-message error';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit scenery';
        });

      } catch (err) {
        console.error(err);
      }
    });
  }
});

/* ================= FUNCTIONS ================= */

function loadControllers(icao) {
  fetch('/api/icao/' + icao + '/controllers')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var ul = document.getElementById('onlineControllers');
      if (!ul) return;

      ul.innerHTML = data.length
        ? data.map(function (c) {
            return (
              '<li class="atc-item">' +
                '<span class="atc-callsign">' + c.callsign + '</span>' +
                '<span class="atc-freq">' + c.frequency + '</span>' +
              '</li>'
            );
          }).join('')
        : '<li class="atc-empty">No ATC online</li>';
    });
}

function loadDepartures(icao) {
  fetch('/api/icao/' + icao + '/departures/live')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var tbody = document.getElementById('upcomingDepartures');
      if (!tbody) return;

      tbody.innerHTML = data.map(function (d) {
        return (
          '<tr>' +
            '<td class="col-sts">' +
              '<span class="sts-icon ' +
                (d.status === 'Taxiing' ? 'sts-taxi' : 'sts-gate') +
              '" title="' + d.status + '">' +
                (d.status === 'Taxiing' ? '➜' : '⎍') +
              '</span>' +
            '</td>' +
            '<td>' + d.callsign + '</td>' +
            '<td>' + d.aircraft + '</td>' +
            '<td>' + d.destination + '</td>' +
            '<td>' +
              '<div class="route-collapsible">' +
                '<span class="route-text collapsed">' + d.route + '</span>' +
                '<button type="button" class="route-toggle" aria-expanded="false">Expand</button>' +
              '</div>' +
            '</td>' +
          '</tr>'
        );
      }).join('');
    });
}

function loadAirportDocs(icao) {
  fetch('/api/icao/' + icao + '/docs')
    .then(function (res) { return res.json(); })
    .then(function (docs) {
      var tbody = document.getElementById('airportDocs');
      if (!tbody) return;

      tbody.innerHTML = docs.length
        ? docs.map(function (d) {
            return (
              '<tr>' +
                '<td><a href="' + d.url + '" target="_blank">' + d.filename + '</a></td>' +
                '<td>' + d.type + '</td>' +
                '<td>' + new Date(d.updated).toLocaleDateString('en-GB') + '</td>' +
                '<td>' + d.submittedBy + '</td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="4" class="empty">No documentation available</td></tr>';
    });
}
</script>






`;

  


  res.send(renderLayout({
    title: `${icao} Airport Portal`,
    user: req.session?.user?.data,
    isAdmin: ADMIN_CIDS.includes(Number(req.session?.user?.data?.cid)),
    content,
    layoutClass: 'dashboard-wide'
  }));
});

app.get('/api/icao/:icao/departures/live', (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const departures = cachedPilots
    .filter(p => p.flight_plan?.departure === icao)
    .map(p => {
      let status = 'Airborne';

      if (p.groundspeed < 5 && p.altitude < 500) {
        status = 'At Gate';
      } else if (p.groundspeed >= 5 && p.altitude < 500) {
        status = 'Taxiing';
      } else if (p.altitude >= 500 && p.altitude < 3000) {
        status = 'Departed';
      }

      return {
        status,
        callsign: p.callsign,
        aircraft: p.flight_plan.aircraft_short || p.flight_plan.aircraft || '—',
        destination: p.flight_plan.arrival || '—',
        route: p.flight_plan.route || ''
      };
    })
    // ✅ KEEP ONLY RELEVANT STATES
    .filter(d =>
      d.status === 'At Gate' ||
      d.status === 'Taxiing'
    )
    // optional: stable order
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'At Gate' ? -1 : 1;
      }
      return a.callsign.localeCompare(b.callsign);
    });

  res.json(departures);
});

app.post('/api/scenery/submit', requireLogin, async (req, res) => {
  try {
    const {
      icao,
      sim,
      name,
      developer,
      store,
      url,
      type
    } = req.body;

    if (!icao || !sim || !name || !url || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await prisma.airportScenery.create({
      data: {
        icao: icao.toUpperCase(),
        sim,
        name,
        developer: developer || null,
        store: store || null,
        url,
        type,
        submittedBy: req.session.user.data.name || req.session.user.data.cid,
        approved: false
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[SCENERY SUBMIT]', err);
    res.status(500).json({ error: 'Failed to submit scenery' });
  }
});


app.get('/api/icao/:icao/controllers', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const shortIcao = icao.startsWith('K') ? icao.slice(1) : null;

  axios.get('https://data.vatsim.net/v3/vatsim-data.json')
    .then(r => {
      const controllers = r.data.controllers || [];

      const filtered = controllers
        .filter(c => {
          const cs = c.callsign.toUpperCase();

          if (cs.endsWith('_OBS')) return false;
          if (cs.startsWith(icao + '_')) return true;
          if (shortIcao && cs.startsWith(shortIcao + '_')) return true;

          return false;
        })
        .map(c => ({
          callsign: c.callsign,
          frequency: c.frequency,
          name: c.name
        }))
        .sort((a, b) => a.callsign.localeCompare(b.callsign));

      res.json(filtered);
    })
    .catch(() => res.json([]));
});


app.get('/api/icao/:icao/docs', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const dir = path.join(__dirname, 'uploads', icao);

  if (!fs.existsSync(dir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      const ext = path.extname(file).replace('.', '').toUpperCase();
      const name = path.basename(file, path.extname(file));

      return {
        filename: name,
        type: ext || 'FILE',
        updated: stat.mtime,
        submittedBy: 'System', // ← future override
        url: `/uploads/${icao}/${file}`
      };
    })
    .sort((a, b) => b.updated - a.updated);

  res.json(files);
});


app.get('/api/tobt/slots', (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);

  const { from, to, dateUtc, depTimeUtc } = req.query;

  if (!from || !to || !dateUtc || !depTimeUtc) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const slots = generateTobtSlots({ from, to, dateUtc, depTimeUtc });

  // ✅ MUST check before using slots
  if (slots === null) {
    return res.json({
      noFlow: true,
      message: 'No flow rate has been defined for this sector.'
    });
  }

  const results = [];

  slots.forEach(tobt => {
    const slotKey = makeTobtSlotKey({
      from,
      to,
      dateUtc,
      depTimeUtc,
      tobtTimeUtc: tobt
    });

    const booking = tobtBookingsBySlot[slotKey];

    results.push({
      tobt,
      slotKey,                 // 🔑 REQUIRED
      booked: !!booking,
      byMe: booking?.cid === cid,
      callsign: booking?.callsign || null
    });
  });

  res.json(results);
});



/* ===== ADMIN MANUAL REFRESH ===== */
app.post('/wf-schedule/refresh-schedule', requireAdmin, async (req, res) => {
  await refreshAdminSheet();
  rebuildAllTobtSlots();
  res.json({ success: true });
});

app.post('/api/tobt/cancel', async (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  if (!cid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { slotKey } = req.body;
  if (!slotKey) {
    return res.status(400).json({ error: 'Missing slotKey' });
  }

  const booking = tobtBookingsBySlot[slotKey];

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const isAdmin =
  ADMIN_CIDS.includes(cid) ||
  !!req.session?.user?.data?.controller;

// Pilot can cancel own booking
if (booking.cid !== null && booking.cid !== cid) {
  return res.status(403).json({ error: 'Forbidden' });
}

// ATC/Admin can cancel ATC-assigned bookings
if (booking.cid === null && !isAdmin) {
  return res.status(403).json({ error: 'Forbidden' });
}


  await prisma.tobtBooking.delete({
    where: { slotKey }
  });

  delete tobtBookingsBySlot[slotKey];

  // 🔑 Maintain CID index (remove from My Slots)
if (booking.cid !== null && tobtBookingsByCid[booking.cid]) {
  tobtBookingsByCid[booking.cid].delete(slotKey);

  if (tobtBookingsByCid[booking.cid].size === 0) {
    delete tobtBookingsByCid[booking.cid];
  }
}


  if (tobtBookingsByCid[cid]) {
    tobtBookingsByCid[cid].delete(slotKey);
    if (tobtBookingsByCid[cid].size === 0) {
      delete tobtBookingsByCid[cid];
    }
  }

emitToIcao(
  booking.from,
  'unassignedTobtUpdate',
  buildUnassignedTobtsForICAO(booking.from)
);



  res.json({ success: true });
});


app.post('/api/tobt/book', requireLogin, async (req, res) => {

 


  const cid = Number(req.session.user?.data?.cid);

  const controllerCallsign =
    req.session.user?.data?.controller?.callsign || '';

  const isAtcAssignment =
    ADMIN_CIDS.includes(cid) ||
    /_(DEL|RMP|GND|TWR|APP|CTR)$/.test(controllerCallsign);

  // Pilots MUST have a CID
  if (!isAtcAssignment && !cid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { slotKey, callsign } = req.body;

  if (!slotKey || !callsign) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  // Prevent double booking (in-memory)
  if (tobtBookingsBySlot[slotKey]) {
    return res.status(409).json({ error: 'Slot already booked' });
  }

  // sector = FROM-TO|date|depTime
  const sectorKey = slotKey.split('|').slice(0, 3).join('|');
  const normalizedCallsign = callsign.trim().toUpperCase();

  // 🔒 Reserved Official Team callsign enforcement
  const teamCheck = await isReservedTeamCallsign(normalizedCallsign, cid);

  if (teamCheck.reserved && !teamCheck.allowed) {
    return res.status(403).json({
      error: `Callsign ${normalizedCallsign} is reserved for an official team.`
    });
  }

  for (const existingSlotKey in tobtBookingsBySlot) {
    const existingSectorKey = existingSlotKey
      .split('|')
      .slice(0, 3)
      .join('|');

    const existing = tobtBookingsBySlot[existingSlotKey];

    if (
      existingSectorKey === sectorKey &&
      existing.callsign === normalizedCallsign
    ) {
      return res.status(409).json({
        error:
          'A booking has already been made with this callsign on ' +
          sectorKey.split('|')[0]
      });
  }
}





  // 🔒 Enforce 1 booking per sector per user
// sector = FROM-TO|date|depTime
const slotParts = slotKey.split('|');
if (slotParts.length === 4) {
  const sectorKey = slotParts.slice(0, 3).join('|');

  // 🔒 Enforce 1 booking per sector per user (PILOTS ONLY)
// 🔑 Maintain CID index for ALL pilot-owned bookings (including admins)
if (cid !== null) {
  if (!tobtBookingsByCid[cid]) {
    tobtBookingsByCid[cid] = new Set();
  }
  tobtBookingsByCid[cid].add(slotKey);
}


}


  // slotKey format: FROM-TO|Date|DepTime|TOBT
  const parts = slotKey.split('|');
  if (parts.length !== 4) {
    return res.status(400).json({ error: 'Invalid slot key format' });
  }

  const [sectorPart, dateUtc, depTimeUtc, tobtTimeUtc] = parts;
  const [from, to] = sectorPart.split('-');

  if (!from || !to) {
    return res.status(400).json({ error: 'Invalid sector format' });
  }

  try {
    await prisma.tobtBooking.create({
      data: {
        slotKey,
        cid,
        callsign: normalizedCallsign,
        from,
        to,
        dateUtc,
        depTimeUtc,
        tobtTimeUtc,
      }
    });

   } catch (err) {
    console.error('[TOBT] DB insert failed:', err);
    return res.status(500).json({ error: 'Failed to book TOBT slot' });
  }

  // ✅ Update in-memory slot index
tobtBookingsBySlot[slotKey] = {
  slotKey,
  cid,
  callsign: normalizedCallsign,
  from,
  to,
  dateUtc,
  depTimeUtc,
  tobtTimeUtc
};

// 🔑 Maintain CID index (PILOTS ONLY)
if (!isAtcAssignment && cid !== null) {
  if (!tobtBookingsByCid[cid]) {
    tobtBookingsByCid[cid] = new Set();
  }
  tobtBookingsByCid[cid].add(slotKey);
}


// 🔄 NOW notify clients to refresh
emitToIcao(from, 'departures:update');

emitToIcao(
  from,
  'unassignedTobtUpdate',
  buildUnassignedTobtsForICAO(from)
);

res.json({ success: true });
});










app.post('/api/tobt/update-callsign', async (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  if (!cid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { slotKey, callsign } = req.body;
  if (!slotKey || !callsign) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const booking = tobtBookingsBySlot[slotKey];
  if (!booking || booking.cid !== cid) {
    return res.status(403).json({ error: 'Not your booking' });
  }

// 🔒 Enforce unique callsign per sector on UPDATE
// 🔒 Enforce unique callsign per sector on UPDATE
const normalizedCallsign = callsign.trim().toUpperCase();

// 🔒 Reserved Official Team callsign enforcement (UPDATE)
const teamCheck = await isReservedTeamCallsign(normalizedCallsign, cid);

if (teamCheck.reserved && !teamCheck.allowed) {
  return res.status(403).json({
    error: `Callsign ${normalizedCallsign} is reserved for an official team.`
  });
}


// sector = FROM-TO|date|depTime
const sectorKey = slotKey.split('|').slice(0, 3).join('|');

for (const existingSlotKey in tobtBookingsBySlot) {
  if (existingSlotKey === slotKey) continue; // ignore own booking

  const existingSectorKey = existingSlotKey
    .split('|')
    .slice(0, 3)
    .join('|');

  const existing = tobtBookingsBySlot[existingSlotKey];

  if (
    existingSectorKey === sectorKey &&
    existing.callsign === normalizedCallsign
  ) {
    return res.status(409).json({
      error:
        'A booking has already been made with this callsign on ' +
        sectorKey.split('|')[0]
    });
  }
}
 

  try {
    await prisma.tobtBooking.update({
      where: { slotKey },
      data: {
        callsign: normalizedCallsign,
        from: booking.from,
        to: booking.to,
        dateUtc: booking.dateUtc,
        depTimeUtc: booking.depTimeUtc,
        tobtTimeUtc: booking.tobtTimeUtc
      }
    });
  } catch (err) {
    console.error('[TOBT] Callsign update failed:', err);
    return res.status(500).json({ error: 'Failed to update callsign' });
  }

  // ✅ Update in-memory cache
  booking.callsign = normalizedCallsign;


  res.json({ success: true });
});


// 🔒 Reserved Official Team callsign enforcement (UPDATE)



app.get('/admin', (req, res) => {
  res.redirect(301, '/wf-schedule');
});

/* ===========================
   OFFICIAL TEAMS / AFFILIATES
   =========================== */

app.get('/official-teams', requireAdmin, async (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  if (!isAdmin) {
    return res.status(403).send('You do not have Admin access');
  }

  const [teams, affiliates] = await Promise.all([
    prisma.officialTeam.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.affiliate.findMany({ orderBy: { createdAt: 'desc' } })
  ]);

  const content = `
  <section class="card card-full">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <h2 style="margin:0;">Official Teams / WF Affiliates</h2>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="action-btn primary" id="addTeamBtn">Add Official Team</button>
        <button class="action-btn" id="addAffiliateBtn">Add WF Affiliate</button>
      </div>
    </div>
<div class="sub-card">
     <h3 class="section-title">Official Teams</h3>
    <div class="table-scroll">
      <table class="departures-table official-teams">
        <thead>
          <tr>
            <th>Team Name</th>
            <th>Callsign</th>
            <th>Main CID</th>
            <th>A/C Type</th>
            <th>Country</th>
            <th class="col-wf26 col-center">WF26</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${teams.map(t => `
            <tr data-team-id="${t.id}">
              <td>${escapeHtml(t.teamName)}</td>
              <td>${escapeHtml(t.callsign)}</td>
              <td>${t.mainCid}</td>
              <td>${escapeHtml(t.aircraftType)}</td>
              <td>${escapeHtml(t.country)}</td>
              <td class="col-wf26 col-center">
  <input
    type="checkbox"
    class="wf26-toggle wf-check"
    data-entity="team"
    data-id="${t.id}"
    ${t.participatingWf26 ? 'checked' : ''}
  />
</td>
              <td style="text-align:right;">
                <button class="tobt-btn cancel" data-action="delete-team" data-id="${t.id}">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
</div>
    <div class="sub-card">
  <h3 class="section-title">WF Affiliates</h3>
    <div class="table-scroll">
    <table class="departures-table affiliates">
  <thead>
    <tr>
      <th class="col-callsign">Callsign</th>
      <th class="col-simtype">Full Sim / Home Cockpit</th>
      <th class="col-cid col-right">CID</th>
      <th class="col-wf26 col-center">WF26</th>
      <th class="col-actions"></th>
    </tr>
  </thead>
  <tbody>
    ${affiliates.map(a => `
      <tr data-affiliate-id="${a.id}">
        <td class="col-callsign">${escapeHtml(a.callsign)}</td>
        <td class="col-simtype">
  ${escapeHtml(a.simType)}
</td>


        <td class="col-cid col-right">${a.cid}</td>
        <td class="col-wf26 col-center">
          <input
            type="checkbox"
            class="wf26-toggle wf-check"
            data-entity="affiliate"
            data-id="${a.id}"
            ${a.participatingWf26 ? 'checked' : ''}
          />
        </td>
        <td class="col-actions col-right">
          <button
            class="tobt-btn cancel"
            data-action="delete-affiliate"
            data-id="${a.id}">
            Delete
          </button>
        </td>
      </tr>
    `).join('')}
  </tbody>
</table>

    </div>
    </div>
  </section>

  <!-- ===== Add Entry Modal ===== -->
  <div id="adminEntryModal" class="modal hidden">
    <div class="modal-backdrop"></div>

    <div class="modal-card card" style="max-width:520px; text-align:left;">
      <h3 id="adminEntryModalTitle" style="text-align:center;">Add Entry</h3>
      <p id="adminEntryModalHelp" class="modal-help" style="text-align:center;">Fill in the details below.</p>

      <form id="adminEntryForm">
  <input type="hidden" id="adminEntryType" name="type" value="team" />

  <!-- ================= TEAM FIELDS ================= -->
  <div id="teamFields">
    <label style="display:block; margin:10px 0 6px;">Team Name</label>
    <input name="teamName" type="text" placeholder="e.g. Virtual Airline XYZ" required />

    <label style="display:block; margin:10px 0 6px;">Callsign</label>
    <input name="callsign" type="text" placeholder="e.g. BAW" maxlength="10" required />

    <label style="display:block; margin:10px 0 6px;">Main CID</label>
    <input name="mainCid" type="number" inputmode="numeric" placeholder="e.g. 1303570" required />

    <label style="display:block; margin:10px 0 6px;">A/C Type</label>
    <input name="aircraftType" type="text" placeholder="e.g. B738" required />

    <label style="display:block; margin:10px 0 6px;">Country</label>
    <input name="country" type="text" placeholder="e.g. UK" required />
  </div>

  <!-- ================= AFFILIATE FIELDS ================= -->
  
  <!-- ================= AFFILIATE FIELDS ================= -->
<div id="affiliateFields" class="hidden">

  <label style="display:block; margin:10px 0 6px;">Callsign</label>
  <input
    name="affiliateCallsign"
    type="text"
    placeholder="e.g. TOM1VB"
    maxlength="10"
    style="text-transform:uppercase;"
  />

  <label style="display:block; margin:10px 0 6px;">Full Sim / Home Cockpit</label>
  <select name="simType">
    <option value="" disabled selected>SELECT SIM TYPE</option>
    <option value="FULL SIM">FULL SIM</option>
    <option value="HOME COCKPIT">HOME COCKPIT</option>
  </select>

  <label style="display:block; margin:10px 0 6px;">CID</label>
  <input
    name="cid"
    type="number"
    inputmode="numeric"
    placeholder="E.G. 1303570"
  />

</div>



  <!-- ================= WF26 ================= -->
  <label style="display:flex; align-items:center; gap:10px; margin:14px 0 0; user-select:none;">
    <input type="checkbox" name="participatingWf26" />
    Participating in WF26
  </label>

  <div class="modal-actions" style="margin-top:16px;">
    <button type="button" class="action-btn" id="adminEntryCancel">Cancel</button>
    <button type="submit" class="action-btn primary" id="adminEntrySave">Save</button>
  </div>
</form>

    </div>
  </div>

  <script>
  document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('adminEntryModal');
    const form = document.getElementById('adminEntryForm');
    const typeInput = document.getElementById('adminEntryType');

    const teamFields = document.getElementById('teamFields');
    const affiliateFields = document.getElementById('affiliateFields');

    const titleEl = document.getElementById('adminEntryModalTitle');
    const cancelBtn = document.getElementById('adminEntryCancel');
    const addTeamBtn = document.getElementById('addTeamBtn');
    const addAffiliateBtn = document.getElementById('addAffiliateBtn');

    if (!modal || !form || !typeInput || !teamFields || !affiliateFields || !titleEl || !cancelBtn || !addTeamBtn || !addAffiliateBtn) {
      console.error('[Admin modal] Missing required DOM elements:', {
        modal, form, typeInput, teamFields, affiliateFields, titleEl, cancelBtn, addTeamBtn, addAffiliateBtn
      });
      return;
    }

    function setSectionEnabled(container, enabled) {
      // Disable inputs in the hidden section to prevent validation blocking and unwanted FormData values
      container.querySelectorAll('input, select, textarea, button').forEach(el => {
        el.disabled = !enabled;
      });
    }

    function openEntryModal(type) {
      typeInput.value = type;
      form.reset();

      if (type === 'team') {
        titleEl.textContent = 'Add Official Team';

        teamFields.classList.remove('hidden');
        affiliateFields.classList.add('hidden');

        setSectionEnabled(teamFields, true);
        setSectionEnabled(affiliateFields, false);

        // Required only for TEAM
        form.querySelector('input[name="teamName"]').required = true;
        form.querySelector('input[name="callsign"]').required = true;
        form.querySelector('input[name="mainCid"]').required = true;
        form.querySelector('input[name="aircraftType"]').required = true;
        form.querySelector('input[name="country"]').required = true;

        // Optional / not required for TEAM
        const affiliateCallsign = form.querySelector('input[name="affiliateCallsign"]');
        const simType = form.querySelector('select[name="simType"], input[name="simType"]');
        const cid = form.querySelector('input[name="cid"]');

        if (affiliateCallsign) affiliateCallsign.required = false;
        if (simType) simType.required = false;
        if (cid) cid.required = false;

      } else {
        titleEl.textContent = 'Add WF Affiliate';

        teamFields.classList.add('hidden');
        affiliateFields.classList.remove('hidden');

        setSectionEnabled(teamFields, false);
        setSectionEnabled(affiliateFields, true);

        // Required for AFFILIATE
        const affiliateCallsign = form.querySelector('input[name="affiliateCallsign"]');
        const simType = form.querySelector('select[name="simType"], input[name="simType"]');
        const cid = form.querySelector('input[name="cid"]');

        if (affiliateCallsign) affiliateCallsign.required = true;
        if (simType) simType.required = true;
        if (cid) cid.required = true;

        // Not required for AFFILIATE
        form.querySelector('input[name="teamName"]').required = false;
        form.querySelector('input[name="callsign"]').required = false;
        form.querySelector('input[name="mainCid"]').required = false;
        form.querySelector('input[name="aircraftType"]').required = false;
        form.querySelector('input[name="country"]').required = false;
      }

      modal.classList.remove('hidden');

      // Focus first enabled input/select (not hidden/disabled)
      const firstFocusable = modal.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
      if (firstFocusable) firstFocusable.focus();
    }

    function closeEntryModal() {
      modal.classList.add('hidden');
    }

    addTeamBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openEntryModal('team');
    });

    addAffiliateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openEntryModal('affiliate');
    });

    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeEntryModal();
    });

    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeEntryModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeEntryModal();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const type = typeInput.value;
      const fd = new FormData(form);
      const payload = {};

      payload.participatingWf26 = fd.get('participatingWf26') === 'on';

      if (type === 'team') {
        payload.teamName = (fd.get('teamName') || '').toString().trim();
        payload.callsign = (fd.get('callsign') || '').toString().trim().toUpperCase();
        payload.mainCid = Number(fd.get('mainCid'));
        payload.aircraftType = (fd.get('aircraftType') || '').toString().trim().toUpperCase();
        payload.country = (fd.get('country') || '').toString().trim();
      } else {
        payload.callsign = (fd.get('affiliateCallsign') || '').toString().trim().toUpperCase();
        payload.simType = (fd.get('simType') || '').toString().trim().toUpperCase();
        payload.cid = Number(fd.get('cid'));
      }

      const url = type === 'team' ? '/api/admin/official-teams' : '/api/admin/affiliates';

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to save');
        return;
      }

      closeEntryModal();
      location.reload();
    });

    // Delete handlers (event delegation)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!action || !id) return;

      if (action === 'delete-team') {
        const ok = await openConfirmModal({
          title: 'Delete Official Team',
          message: 'Are you sure you want to delete this team?'
        });
        if (!ok) return;

        const res = await fetch('/api/admin/official-teams/' + id, {
          method: 'DELETE',
          credentials: 'same-origin'
        });

        if (!res.ok) alert('Failed to delete');
        else location.reload();
      }

      if (action === 'delete-affiliate') {
        const ok = await openConfirmModal({
          title: 'Delete WF Affiliate',
          message: 'Are you sure you want to delete this affiliate?'
        });
        if (!ok) return;

        const res = await fetch('/api/admin/affiliates/' + id, {
          method: 'DELETE',
          credentials: 'same-origin'
        });

        if (!res.ok) alert('Failed to delete');
        else location.reload();
      }
    });

    // WF26 toggle persistence
    document.querySelectorAll('.wf26-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const entity = cb.dataset.entity;
        const id = cb.dataset.id;
        const participatingWf26 = cb.checked;

        const url = entity === 'team'
          ? '/api/admin/official-teams/' + id
          : '/api/admin/affiliates/' + id;

        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ participatingWf26 })
        });

        if (!res.ok) {
          cb.checked = !participatingWf26;
          alert('Failed to update WF26 flag');
        }
      });
    });

    // Affiliate sim type dropdown persistence
    
    
  });
</script>

 

  `;

  return res.send(renderLayout({
    title: 'Official Teams / Affiliates',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full'
  }));
});



// Create Official Team
app.post('/api/admin/official-teams', requireAdmin, async (req, res) => {
  const { teamName, callsign, mainCid, aircraftType, country, participatingWf26 } = req.body || {};

  if (!teamName || !callsign || !mainCid || !aircraftType || !country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const created = await prisma.officialTeam.create({
    data: {
      teamName: String(teamName).trim(),
      callsign: String(callsign).trim().toUpperCase(),
      mainCid: Number(mainCid),
      aircraftType: String(aircraftType).trim().toUpperCase(),
      country: String(country).trim(),
      participatingWf26: Boolean(participatingWf26)
    }
  });

  return res.json({ success: true, id: created.id });
});

// Create Affiliate
app.post('/api/admin/affiliates', requireAdmin, async (req, res) => {
  const { callsign, simType, cid, participatingWf26 } = req.body || {};

  if (!callsign || !simType || !cid) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const created = await prisma.affiliate.create({
    data: {
      callsign: String(callsign).trim().toUpperCase(),
      simType: String(simType).trim(),
      cid: Number(cid),
      participatingWf26: Boolean(participatingWf26)
    }
  });

  return res.json({ success: true, id: created.id });
});

// Delete Official Team
app.delete('/api/admin/official-teams/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.officialTeam.delete({ where: { id } }).catch(() => null);
  return res.json({ success: true });
});

// Delete Affiliate
app.delete('/api/admin/affiliates/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.affiliate.delete({ where: { id } }).catch(() => null);
  return res.json({ success: true });
});

// Patch Official Team (WF26 toggle)
app.patch('/api/admin/official-teams/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { participatingWf26 } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.officialTeam.update({
    where: { id },
    data: { participatingWf26: Boolean(participatingWf26) }
  });

  return res.json({ success: true });
});

// Patch Affiliate (WF26 toggle)
app.patch('/api/admin/affiliates/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { participatingWf26 } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.affiliate.update({
    where: { id },
    data: { participatingWf26: Boolean(participatingWf26) }
  });

  return res.json({ success: true });
});


/* ===== CHANGE CHECK ===== */
app.get('/departures/check-changes', async (req, res) => {
  const icao = req.query.icao?.toUpperCase();
  if (!icao) return res.json({ changed: false });

  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');

  const currentSet = new Set(
    response.data.pilots
      .filter(p => p.flight_plan && p.flight_plan.departure === icao && p.groundspeed < 5)
      .map(p => `${p.callsign}-${p.flight_plan.arrival}`)
  );

  const changed = currentSet.size !== lastDepartureSnapshot.size;
  lastDepartureSnapshot = currentSet;

  res.json({ changed });
});

/* ===== ADMIN PAGE ===== */
app.get('/wf-schedule', requireAdmin, (req, res) => {
if (!req.session.user || !req.session.user.data) {
  return res.redirect('/');
}

const user = req.session.user.data;
const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

if (!isAdmin) {
  return res.status(403).send('You do not have Admin access');
}

const content = `
 <main class="dashboard-full">
<section class="card dashboard-full">

<h2>WorldFlight Admin Schedule</h2>
<button id="refreshScheduleBtn" style="margin-bottom:16px;">⟳ Force Refresh Schedule</button>

<div class="table-scroll">
<table class="departures-table" id="mainDeparturesTable">

<thead>
<tr>
  <th>WF</th>
  <th>From</th>
  <th>Dep Flow</th>
  <th>To</th>
  <th>Date</th>
  <th>Dep</th>
  <th>Arr</th>
  <th class="col-route">ATC Route</th>
</tr>
</thead>
<tbody>
${adminSheetCache.map(r => {
  const sectorKey = `${r.from}-${r.to}`;
  return `
<tr>
  <td>${r.number}</td>
  <td>${r.from}</td>
  <td>
    <input
      class="dep-flow-input"
      type="number"
      data-sector="${sectorKey}"
      placeholder="Rate"
      style="width:70px;"
    />
  </td>
  <td>${r.to}</td>
  <td>${r.date_utc}</td>
  <td>${r.dep_time_utc}</td>
  <td>${r.arr_time_utc}</td>
  <td>
  <div class="route-collapsible">
    <span class="route-text collapsed">
      ${r.atc_route}
      </span>

    <button
      type="button"
      class="route-toggle"
      aria-expanded="false">
      Show route
    </button>
  </div>
</td>
</tr>`;
}).join('')}
</tbody>
</table>
</div>

</section>
</main> 

<footer>
<section class="card">
    <!-- EVERYTHING that was inside <main> goes here -->
    <footer class="connected-users-footer">
  <strong>Connected Users:</strong>
  <div id="connectedUsersList">Loading...</div>
</footer>
  </section>

  <!-- KEEP ALL EXISTING <script> TAGS EXACTLY AS THEY ARE -->
  <script>
document.getElementById('refreshScheduleBtn').onclick = async () => {
  await fetch('/wf-schedule/refresh-schedule', { method: 'POST' });
  location.reload();
};
</script>

<script src="/socket.io/socket.io.js"></script>

<script>
const socket = io();

/* ===== DEP FLOW COLOUR LOGIC ===== */
function applyDepFlowStyle(input) {
  const val = Number(input.value);

  input.classList.remove('dep-flow-low', 'dep-flow-mid', 'dep-flow-high');

  if (!val) return;

  if (val <= 20) {
    input.classList.add('dep-flow-low');    // RED
  } else if (val >= 21 && val <= 40) {
    input.classList.add('dep-flow-mid');    // ORANGE
  } else if (val >= 41) {
    input.classList.add('dep-flow-high');   // GREEN
  }
}

/* ===== DEP FLOW: INITIAL SYNC (+ COLOUR) ===== */
socket.on('syncDepFlows', flows => {
  window.sharedFlowRates = flows; // exposed for any client-side TSAT logic if needed
  Object.entries(flows).forEach(([sector, value]) => {
    const input = document.querySelector('.dep-flow-input[data-sector="' + sector + '"]');
    if (input) {
      input.value = value;
      applyDepFlowStyle(input);
    }
  });
});

/* ===== DEP FLOW: LIVE UPDATE ===== */
socket.on('depFlowUpdated', ({ sector, value }) => {
  const input = document.querySelector('.dep-flow-input[data-sector="' + sector + '"]');
  if (input) {
    input.value = value;
    applyDepFlowStyle(input);
  }
});

/* ===== DEP FLOW: LOCAL EDIT ===== */
document.querySelectorAll('.dep-flow-input').forEach(input => {
  input.addEventListener('input', () => {
    applyDepFlowStyle(input);

    socket.emit('updateDepFlow', {
      sector: input.dataset.sector,
      value: input.value
    });
  });
});

/* ===== ADMIN REGISTRATION FOR CONNECTED USERS FOOTER ===== */
socket.emit('registerUser', {
  cid: "${req.session.user?.data?.cid || 'UNKNOWN'}",
  position: "${req.session.user?.data?.controller?.callsign || 'UNKNOWN'}"
});

/* ===== CONNECTED USERS FOOTER ===== */
socket.on('connectedUsersUpdate', users => {
  const container = document.getElementById('connectedUsersList');
  if (!users.length) {
    container.innerHTML = '<em>No users connected</em>';
    return;
  }
  container.innerHTML = users
    .map(u => 'CID ' + u.cid + ' — ' + u.position)
    .join('<br>');
});
</script>
<script>
/* ===============================
   USER CONTEXT
================================ */

// These values already exist server-side
const USER_CONTEXT = {
  cid: ${req.session.user?.data?.cid || 'null'},
  isAdmin: ${ADMIN_CIDS.includes(Number(req.session.user?.data?.cid))},
  isATC: ${!!req.session.user?.data?.controller},
};

/* ===============================
   ROLE VISIBILITY
================================ */

document.querySelectorAll('.admin-only').forEach(el => {
  if (!USER_CONTEXT.isAdmin) el.remove();
});

document.querySelectorAll('.atc-only').forEach(el => {
  if (!USER_CONTEXT.isATC) el.remove();
});

document.querySelectorAll('.pilot-only').forEach(el => {
  if (USER_CONTEXT.isATC) el.remove();
});

/* ===============================
   ACTIVE PAGE HIGHLIGHT
================================ */

const path = window.location.pathname;
document.querySelectorAll('.nav-item').forEach(link => {
  if (path.startsWith(link.dataset.path)) {
    link.classList.add('active');
  }
});

/* ===============================
   SIDEBAR TOGGLE (PERSISTENT)
================================ */

const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('sidebarToggle');

const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';

if (collapsed) {
  sidebar.classList.add('collapsed');
  document.body.classList.add('sidebar-collapsed');
}

toggleBtn.onclick = () => {
  sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');

  localStorage.setItem(
    'sidebarCollapsed',
    sidebar.classList.contains('collapsed')
  );
};
</script>
<script>
document.addEventListener('click', function (e) {
  const btn = e.target.closest('.route-toggle');
  if (!btn) return;

  const wrapper = btn.closest('.route-collapsible');
  const text = wrapper.querySelector('.route-text');

  const expanded = btn.getAttribute('aria-expanded') === 'true';

  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Show route' : 'Hide route';

  text.classList.toggle('collapsed', expanded);
});
</script>

`;
res.send(
  renderLayout({
    title: 'WF Schedule',
    user,
    isAdmin,
    layoutClass: 'dashboard-full',
    content
  })
);

});

/* ===== DEPARTURES PAGE ===== */
app.get('/departures', async (req, res) => {

  // 1️⃣ Auth guard
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  

  // 2️⃣ ICAO — DEFINE ONCE
  const pageIcao = req.query.icao?.toUpperCase();
  if (!pageIcao || pageIcao.length !== 4) {
    return res.redirect('/atc');
  }


  
  // 3️⃣ Controller connection check
  const controllerCallsign = user.callsign || '';

  // "Connected" to the aerodrome if callsign is ICAO_* and not ICAO_OBS
  const isAerodromeController =
    controllerCallsign.startsWith(pageIcao + '_') &&
    !controllerCallsign.endsWith('_OBS');

  // Kept for backwards compatibility (if anything still uses it)
  const isConnectedToIcao = controllerCallsign.startsWith(pageIcao + '_');

  // Admins can always edit; otherwise must be connected as ICAO_* (except ICAO_OBS)
  const canEdit = isAdmin || isAerodromeController;
  const disabledAttr = canEdit ? '' : 'disabled';

  // 4️⃣ Fetch VATSIM data
  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
  const pilots = response.data.pilots;

  // 5️⃣ Use pageIcao everywhere
  const departures = pilots.filter(
    p =>
      p.flight_plan &&
      p.flight_plan.departure === pageIcao &&
      p.groundspeed < 5
  );
  
// DEBUG (safe now)
  console.log('--- EDIT PERMISSION DEBUG ---');
  console.log('CID:', user.cid);
  console.log('Callsign:', controllerCallsign);
  console.log('Page ICAO:', pageIcao);
  console.log('Is Admin:', isAdmin);
  console.log('Can Edit:', canEdit);
  console.log('-----------------------------');

  
  const CAN_EDIT = canEdit;


  
  const tsatRefreshHtml = CAN_EDIT
  ? `
    <button
      class="tsat-refresh"
      data-callsign=""
      style="display:none;"
    >
      ⟳
    </button>
  `
  : '';

  
  const rowsHtml = departures.map(p => {
  const disabledAttr = CAN_EDIT ? '' : 'disabled';

  const sectorKey = `${p.flight_plan.departure}-${p.flight_plan.arrival}`;

  // ✅ define wfStatus BEFORE using it
  const wfStatus = getWorldFlightStatus(p);
const isEventFlight = wfStatus.isWF;

// Look up booking BY PILOT CALLSIGN
const tobtBooking = getTobtBookingForCallsign(p.callsign, pageIcao);
const isBooked = !!tobtBooking;
const isManualTobt = !!tobtBooking && tobtBooking.cid === null;


let tobtCellHtml = '';

if (isEventFlight) {
  if (tobtBooking) {
    // 🔴 ATC-assigned TOBT → removable
    if (CAN_EDIT && tobtBooking.cid === null) {
      tobtCellHtml = `
        <div class="tobt-assigned">
          <strong>${tobtBooking.tobtTimeUtc}</strong>
          <button
  class="tobt-remove-btn"
  data-slotkey="${tobtBooking.slotKey}"
  data-callsign="${p.callsign}"
  title="Remove TOBT"
  aria-label="Remove TOBT"
>
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path
      d="M7 7l10 10M17 7L7 17"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
    />
  </svg>
</button>


        </div>
      `;
    } else {
      // 🟢 Pilot-booked → read-only
      tobtCellHtml = `<strong>${tobtBooking.tobtTimeUtc}</strong>`;
    }
  } else {
    // No TOBT → dropdown
    const availableTobts = getNextAvailableTobts(
      pageIcao,
      p.flight_plan.arrival
    );

    if (!availableTobts.length) {
      tobtCellHtml = `<em>None</em>`;
    } else {
      tobtCellHtml = `
      <div class="tobt-select-wrapper">
        <select class="tobt-select" data-callsign="${p.callsign}">
          <option value="">Select TOBT</option>
          ${availableTobts.map(s =>
            `<option value="${s.slotKey}">${s.tobt}</option>`
          ).join('')}
        </select>
      </div>
      `;
    }
  }
}





let primaryStatusHtml = '';
  let showRouteWarning = false;

  if (!isEventFlight) {
  primaryStatusHtml = `
    <span
      class="status-pill non-event"
      title="Flying to a non-event destination"
    >
      Non-Event
    </span>`;
} else {
  if (isManualTobt) {
  primaryStatusHtml = `
    <span
      class="status-pill manual"
      title="TOBT manually assigned by ATC"
    >
      <span class="status-icon">!</span>
      Manual
    </span>`;
} else if (isBooked) {
  primaryStatusHtml = `
    <span
      class="status-pill booked"
      title="Has an event booking"
    >
      Booked
    </span>`;
} else {
  primaryStatusHtml = `
    <span
      class="status-pill non-booked"
      title="Flying to WF destination without a booking"
    >
      Non-Booked
    </span>`;
}

  showRouteWarning = !wfStatus.routeMatch;
}



  const routeHtml = p.flight_plan.route
    ? `<span class="route-collapsed">Click to expand</span><span class="route-expanded" style="display:none;">${p.flight_plan.route}</span>`
    : 'N/A';

  return `
<tr>
  <td class="col-status">
    ${primaryStatusHtml}
    ${showRouteWarning
  ? `<span
       class="status-pill route-warning"
       title="Wrong route for event traffic"
     >
       Route!
     </span>`
  : ''
}
  </td>

  <td>${p.callsign}</td>
  <td>${p.flight_plan.aircraft_faa || 'N/A'}</td>
  <td>${p.flight_plan.arrival || 'N/A'}</td>

  <td class="col-tobt">
  ${tobtCellHtml}
</td>

  <td class="col-toggle">
    <button
      class="toggle-btn"
      data-type="start"
      data-callsign="${p.callsign}"
      data-sector="${sectorKey}"
      ${disabledAttr}
    >⬜</button>
  </td>

  <td class="tsat-cell" data-callsign="${p.callsign}">
    <span class="tsat-time">—</span>
    ${CAN_EDIT ? `<button class="tsat-refresh" data-callsign="${p.callsign}" style="display:none;">⟳</button>` : ''}
  </td>

  <td class="col-route">${routeHtml}</td>
</tr>`;
}).join('');


 const content = `
  <section class="card dashboard-wide">

    <section class="card">

    <!-- TOP ROW HEADERS (aligned horizontally) -->
<div class="tsat-wrapper">    

${!isAerodromeController ? `
  <div class="icao-warning">
    ${canEdit ? `
      You are not connected as an ${pageIcao}_ position, but you can edit because you are an Admin.
    ` : `
      You are not connected as an ${pageIcao}_ position and therefore the following information is read-only.
    `}
  </div>
` : ``}
<div class="tsat-top-row three-cols">

  <!-- UPCOMING TSATs -->
  <div class="tsat-col">
    <h3 class="tsat-header">Upcoming TSATs</h3>
    <div class="table-scroll">
      <table class="departures-table" id="tsatQueueTable">
        <thead>
          <tr>
            <th>Callsign</th>
            <th>TSAT</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- RECENTLY STARTED -->
  <div class="tsat-col">
    <h3 class="tsat-header">Recently Started</h3>
    <div class="table-scroll">
      <table class="departures-table" id="recentlyStartedTable">
        <thead>
          <tr>
            <th>Callsign</th>
            <th>Started At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- UNASSIGNED TOBTs -->
  <div class="tsat-col">
    <h3 class="tsat-header">Available WF TOBT's</h3>
    <div class="table-scroll">
      <table class="departures-table" id="unassignedTobtTable">
  <thead>
    <tr>
      <th>TOBT</th>
      <th>Dest</th>
      <th>TOBT</th>
      <th>Dest</th>
    </tr>
  </thead>

        <tbody>
          <tr>
            <td colspan="4"><em>None Available</em></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

</div>


</div>
    </div>
    <!-- END TSAT TOP ROW -->


    <!-- SEARCH + TIMER + MAIN TABLE -->
    <input id="callsignSearch" placeholder="Search by callsign..." />
    
    <div class="table-scroll">
      <table class="departures-table" id="mainDeparturesTable">
        <thead>
          <tr>
            <th>Status</th>
            <th>Callsign</th>
            <th>Aircraft</th>
            <th>Dest</th>
            <th>TOBT</th>
            <th class="col-toggle">START</th>
            <th>TSAT</th>
            <th class="col-route">ATC Route</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

  </section>
</section>


  <!-- ALL scripts stay exactly the same -->
  <script>
  const CAN_EDIT = ${canEdit ? 'true' : 'false'};
</script>
  <script>
  

/* ----------------------------------------------------
   SEARCH FILTER
---------------------------------------------------- */
const searchInput = document.getElementById('callsignSearch');
const savedFilter = localStorage.getItem('callsignFilter') || '';
searchInput.value = savedFilter;
applyFilter(savedFilter);

function applyFilter(filter) {
  const upper = filter.toUpperCase();
  document.querySelectorAll('#mainDeparturesTable tbody tr').forEach(row => {

    const txt = row.children[1].innerText.toUpperCase();
    row.style.display = txt.includes(upper) ? '' : 'none';
  });
}

searchInput.addEventListener('input', function () {
  const val = this.value;
  localStorage.setItem('callsignFilter', val);
  applyFilter(val);
});

/* ----------------------------------------------------
   ROUTE EXPAND/COLLAPSE
---------------------------------------------------- */
function bindRouteExpanders() {
  document.querySelectorAll('.route-collapsed').forEach(el => {
    el.onclick = () => {
      const exp = el.nextElementSibling;
      if (!exp) return;

      const isExpanded = exp.style.display === 'block';

      if (isExpanded) {
        exp.style.display = 'none';
        el.textContent = 'Click to expand';
      } else {
        exp.style.display = 'block';
        el.textContent = 'Click to collapse';
      }
    };
  });
}


// Initial bind on page load
bindRouteExpanders();


/* ----------------------------------------------------
   REFRESH TIMER + SMART REFRESH
---------------------------------------------------- */
const icao = new URLSearchParams(window.location.search).get('icao');
let countdown = 20;

setInterval(() => {
  const timerEl = document.getElementById('refreshTimer');
  if (timerEl) {
    timerEl.innerText = 'Next auto-refresh in: ' + countdown + 's';
  }
  countdown = countdown <= 0 ? 20 : countdown - 1;
}, 1000);

setInterval(async () => {
  const res = await fetch('/departures/check-changes?icao=' + icao);
  const data = await res.json();
  if (data.changed) {
  refreshDeparturesTable();
}
}, 20000);

setInterval(() => {
  refreshDeparturesTable();
}, 120000);

</script>

<script src="/socket.io/socket.io.js"></script>

<script>
/* ============================================================
   TSAT → FULL ROW COLOURING HELPER
============================================================ */
/* ============================================================
   TSAT → FULL ROW COLOURING (CDM –10 / –5 / +5 / +10 LOGIC)
============================================================ */
function getRowColorClass(tsatStr) {
    if (!tsatStr || tsatStr === '—' || tsatStr === '----') return '';

    const now = new Date();
    now.setSeconds(0, 0);

    const [hh, mm] = tsatStr.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return '';

    const tsatDate = new Date(now);
    tsatDate.setHours(hh, mm, 0, 0);

    const diffMin = (tsatDate - now) / 60000;  // positive = TSAT in future

    // GREEN → TSAT ±5 minutes
    if (diffMin >= -5 && diffMin <= 5) return 'row-green';

    // AMBER → TSAT –10 to –6 OR +6 to +10
    if ((diffMin >= -10 && diffMin <= -6) || (diffMin >= 6 && diffMin <= 10)) {
        return 'row-amber';
    }

    // RED → anything earlier/later than these
    return 'row-red';
}


/* ----------------------------------------------------
   SOCKET INIT
---------------------------------------------------- */
const socket = io({
  query: { icao }
});



// Passive viewers: keep Upcoming TSATs in sync



function renderUnassignedTobtTable(data) {
  const tbody = document.querySelector('#unassignedTobtTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const MAX_ROWS = 6;
  const MAX_ITEMS = MAX_ROWS * 2;

  const visible = data.slice(0, MAX_ITEMS);

  if (!visible.length) {
    tbody.innerHTML =
      '<tr><td colspan="4"><em>None Available</em></td></tr>';
    return;
  }

  const half = Math.ceil(visible.length / 2);
  const left = visible.slice(0, half);
  const right = visible.slice(half);

  for (let i = 0; i < MAX_ROWS; i++) {
    const tr = document.createElement('tr');

    const leftItem = left[i];
    const rightItem = right[i];

    // Left column
    if (leftItem) {
      tr.innerHTML +=
        '<td>' + leftItem.tobt + '</td>' +
        '<td>' + leftItem.to + '</td>';
    } else {
      tr.innerHTML += '<td></td><td></td>';
    }

    // Right column
    if (rightItem) {
      tr.innerHTML +=
        '<td>' + rightItem.tobt + '</td>' +
        '<td>' + rightItem.to + '</td>';
    } else {
      tr.innerHTML += '<td></td><td></td>';
    }

    tbody.appendChild(tr);
  }
  
}





/* ----------------------------------------------------
   UPCOMING TSAT TABLE RENDERER
---------------------------------------------------- */
function renderUpcomingTSATTable(data) {
  const tbody = document.querySelector('#tsatQueueTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const MAX_ROWS = 5;

  // Render real TSAT rows first
  data.slice(0, MAX_ROWS).forEach(function (item) {
    const tr = document.createElement('tr');

const tsatValue = item.tsat || '—';
const rowClass = getRowColorClass(tsatValue);
if (rowClass) tr.classList.add(rowClass);

tr.innerHTML =
  '<td>' + item.callsign + '</td>' +
  '<td>' + tsatValue + '</td>' +
  '<td>' +
    '<input type="checkbox" class="tsat-started-check" data-callsign="' +
    item.callsign +
    '"' + (CAN_EDIT ? '' : ' disabled') + '>' +
  '</td>';



tbody.appendChild(tr);

  });

  // Pad remaining empty rows to force consistent height
  const missing = MAX_ROWS - Math.min(data.length, MAX_ROWS);

  for (let i = 0; i < missing; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>';
    tbody.appendChild(tr);
  }
}

/* ----------------------------------------------------
   UPCOMING TSAT EVENTS
---------------------------------------------------- */
socket.on('upcomingTSATUpdate', data => {
  renderUpcomingTSATTable(data);
});

socket.on('recentlyStartedUpdate', data => {
  renderRecentlyStartedTable(data);
});

socket.on('unassignedTobtUpdate', data => {
  renderUnassignedTobtTable(data);
});


socket.on('tsatStartedUpdated', started => {
  document.querySelectorAll('.tsat-started-check').forEach(cb => {
    const callsign = cb.dataset.callsign;
    cb.checked = !!started[callsign];
  });
});

/* Checkbox for Started / Unstarted */
document.addEventListener('change', function (e) {
  if (!CAN_EDIT) {
    e.target.checked = !e.target.checked;
    return;
  }

  if (!e.target.classList.contains('tsat-started-check')) return;


  const callsign = e.target.dataset.callsign;

  if (e.target.checked) {
    socket.emit('markTSATStarted', { callsign });
  } else {
    socket.emit('unmarkTSATStarted', { callsign });
  }
});



document.addEventListener('keydown', async e => {
  if (!e.target.classList.contains('callsign-input')) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    await saveCallsign(e.target);
    e.target.blur(); // optional: visually confirms save
  }
});

document.addEventListener('click', async e => {
  const btn = e.target.closest('.tobt-remove-btn');
  if (!btn) return;
  if (!CAN_EDIT) return;

  const slotKey = btn.dataset.slotkey;
  const callsign = btn.dataset.callsign;

  const ok = confirm(
    'Remove TOBT for ' + callsign + ' and release slot back to pool?'
  );
  if (!ok) return;

  const res = await fetch('/api/tobt/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ slotKey })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to remove TOBT');
    return;
  }

  location.reload();
});


  document.addEventListener('change', async e => {
  const select = e.target.closest('.tobt-select');
  if (!select || !select.value) return;

  const callsign = select.dataset.callsign;
  const slotKey = select.value; // IMPORTANT: already a full slotKey

  const res = await fetch('/api/tobt/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ slotKey, callsign })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to book TOBT');
    select.value = '';
    return;
  }

  location.reload();
});


/* ----------------------------------------------------
   RESTORE TOGGLES
---------------------------------------------------- */
socket.on('syncState', state => {
  Object.entries(state).forEach(([callsign, toggles]) => {
    if (!toggles.start) return;

    const btn = document.querySelector(
      '.toggle-btn[data-callsign="' + callsign + '"][data-type="start"]'
    );
    if (!btn) return;

    btn.innerText = '✅';
    btn.classList.add('active');
  });
});



socket.on('toggleUpdated', ({ callsign, type, value }) => {
  if (type !== 'start') return;

  const btn = document.querySelector(
    '.toggle-btn[data-callsign="' + callsign + '"][data-type="' + type + '"]'
  );
  if (!btn) return;

  btn.innerText = value ? '✅' : '⬜';
  btn.classList.toggle('active', value);
});

/* ----------------------------------------------------
   TSAT SYNC
---------------------------------------------------- */
socket.on('syncTSAT', data => {
  Object.entries(data).forEach(([callsign, tsat]) => {
    const cell = document.querySelector(
      '.tsat-cell[data-callsign="' + callsign + '"]'
    );
    if (!cell) return;

    const span = cell.querySelector('.tsat-time');
    const refreshBtn = cell.querySelector('.tsat-refresh');

    if (span) span.innerText = tsat || '—';
    if (refreshBtn) refreshBtn.style.display = tsat ? 'inline-block' : 'none';
  });
});

/* TSAT Live Update */
socket.on('tsatUpdated', ({ callsign, tsat }) => {
  const cell = document.querySelector(
    '.tsat-cell[data-callsign="' + callsign + '"]'
  );
  if (!cell) return;

  const span = cell.querySelector('.tsat-time');
  const refreshBtn = cell.querySelector('.tsat-refresh');

  if (span) span.innerText = tsat || '—';
  if (refreshBtn) refreshBtn.style.display = tsat ? 'inline-block' : 'none';
});

/* ----------------------------------------------------
   CLR / START BUTTON HANDLERS
---------------------------------------------------- */
document.addEventListener('click', function (e) {
  if (!CAN_EDIT) return;

  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;


  const callsign = btn.dataset.callsign;
  const type = btn.dataset.type;
  const sector = btn.getAttribute('data-sector') || null;

  const isActive = btn.classList.toggle('active');
  btn.innerText = isActive ? '✅' : '⬜';

  socket.emit('updateToggle', { callsign, type, value: isActive, sector });

  if (type === 'start') {
    const row = btn.closest('tr');
    const tsatCell = row?.querySelector('.tsat-cell[data-callsign="' + callsign + '"]');
    const span = tsatCell?.querySelector('.tsat-time');
    const refreshBtn = tsatCell?.querySelector('.tsat-refresh');

    if (isActive) {
      
    } else {
      if (span) span.innerText = '—';
      if (refreshBtn) refreshBtn.style.display = 'none';
      socket.emit('cancelTSAT', { callsign, sector });
    }
  }
});

/* ----------------------------------------------------
   TSAT REFRESH BUTTON
---------------------------------------------------- */
document.addEventListener('click', function (e) {
  if (!e.target.classList.contains('tsat-refresh')) return;

  const callsign = e.target.getAttribute('data-callsign');
  const row = e.target.closest('tr');
  if (!row) return;

  const startBtn = row.querySelector(
    '.toggle-btn[data-type="start"][data-callsign="' + callsign + '"]'
  );
  if (!startBtn) return;

  const sector = startBtn.getAttribute('data-sector');
  if (!sector) return;

  socket.emit('recalculateTSAT', { callsign, sector });
});
</script>

<script>
function renderRecentlyStartedTable(data) {
  const tbody = document.querySelector('#recentlyStartedTable tbody');
  tbody.innerHTML = '';
    const disabledAttr = CAN_EDIT ? '' : ' disabled';


  const MAX_ROWS = 5;

  data.slice(0, MAX_ROWS).forEach(item => {
    const tr = document.createElement('tr');

    tr.innerHTML =
  '<td>' + item.callsign + '</td>' +
  '<td>' + item.startedAt + '</td>' +
  '<td>' +
  '<button class="send-back-btn action-btn" data-callsign="' + item.callsign + '"' + disabledAttr + '>' +
    'Send Back' +
  '</button>' +
  '<button class="delete-started-btn action-btn" data-callsign="' + item.callsign + '" title="Delete entry"' + disabledAttr + '>' +
    '<svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="3 6 5 6 21 6"></polyline>' +
      '<path d="M19 6l-1 14H6L5 6"></path>' +
      '<path d="M10 11v6"></path>' +
      '<path d="M14 11v6"></path>' +
      '<path d="M9 6V4h6v2"></path>' +
    '</svg>' +
  '</button>' +
'</td>';


    tbody.appendChild(tr);
  });

  // Pad empty rows
  const missing = MAX_ROWS - data.length;

  for (let i = 0; i < missing; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>';
    tbody.appendChild(tr);
  }
}

/* Handle Send Back button in Recently Started */
document.addEventListener('click', e => {
  const btn = e.target.closest('.send-back-btn');
  if (!btn) return;
  if (btn.disabled || !CAN_EDIT) return;

  const callsign = btn.dataset.callsign;
  if (!callsign) return;

  socket.emit('sendBackToUpcoming', { callsign, icao });
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.delete-started-btn');
  if (!btn) return;
  if (btn.disabled || !CAN_EDIT) return;

  const callsign = btn.dataset.callsign;
  if (!callsign) return;

  const ok = confirm("Are you sure you want to permanently delete " + callsign + " from Recently Started?");
  if (!ok) return;

  socket.emit('deleteStartedEntry', { callsign });
});


</script>
<script>
async function refreshDeparturesTable() {
  const res = await fetch(window.location.href);
  const html = await res.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const newMain = doc.querySelector('#mainDeparturesTable tbody');
  const oldMain = document.querySelector('#mainDeparturesTable tbody');

  if (newMain && oldMain) {
    oldMain.innerHTML = newMain.innerHTML;
  }

  // Restore search filter
  const saved = localStorage.getItem('callsignFilter') || '';
  applyFilter(saved);

  // Re-bind "Click to expand" handlers on the new rows
  if (typeof bindRouteExpanders === 'function') {
    bindRouteExpanders();
  }

  // Allow DOM to finish updating BEFORE syncing toggle state
  setTimeout(() => {
    // Re-apply CLR / START states
    socket.emit('requestToggleStateSync');

    // Re-apply TSAT values in bottom table
    socket.emit('requestTSATSync');

    // Re-sync STARTED checkbox state in bottom table
    socket.emit('requestStartedStateSync');
  }, 150);
}


/* ============================================================
   PERIODIC ROW COLOUR REFRESH (1 min)
============================================================ */
setInterval(() => {
  document.querySelectorAll('#tsatQueueTable tbody tr').forEach(row => {
    const tsatCell = row.children[1];
    if (!tsatCell) return;

    const tsat = tsatCell.innerText.trim();
    const rowClass = getRowColorClass(tsat);

    row.classList.remove('row-green', 'row-amber', 'row-red');
    if (rowClass) row.classList.add(rowClass);
  });
}, 60000);

</script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  // IMPORTANT: listeners must already be defined ABOVE this
  socket.emit('requestSyncAllState', { icao });


});
</script>



`;

res.send(
  renderLayout({
    title: 'ATC Slot Management',
    user,
    isAdmin,
    layoutClass: 'dashboard-full',
    content
  })
);



});

app.post('/api/tobt/remove', async (req, res) => {
  const user = req.session?.user?.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user?.cid));
  const isATC = !!user?.controller;

  if (!isAdmin && !isATC) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { slotKey } = req.body;
  if (!slotKey) {
    return res.status(400).json({ error: 'Missing slotKey' });
  }

  // ✅ DB is source of truth
  const booking = await prisma.tobtBooking.findUnique({
    where: { slotKey }
  });

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // 🔒 Only ATC-assigned TOBTs (cid === null)
  if (booking.cid !== null) {
    return res.status(403).json({
      error: 'Pilot-booked TOBTs cannot be removed by ATC'
    });
  }

  await prisma.tobtBooking.delete({
    where: { slotKey }
  });

  delete tobtBookingsBySlot[slotKey];

  emitToIcao(booking.from, 'departures:update');


  res.json({ success: true });
});




app.get('/atc', requireLogin, (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  

  const content = `
    <section class="card">
      <h2>ATC Slot Management</h2>
      <p>Select an airport to manage ground departures.</p>

      <form action="/departures" method="GET" class="icao-search">
        <input
          type="text"
          name="icao"
          placeholder="Enter ICAO (e.g. EGLL)"
          maxlength="4"
          required
        />
        <button type="submit">Load Departures</button>
      </form>
    </section>
  `;

  res.send(
    renderLayout({
      title: 'ATC Slot Management',
      user,
      isAdmin,
      layoutClass: 'dashboard-full',
      content
    })
  );
});

app.get('/book', (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/auth/login');
  }

  const { from, to, depTimeUtc } = req.query;

  const preselectedKey =
    from && to && depTimeUtc
      ? `${from}-${to}-${depTimeUtc}`
      : null;


  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  const content = `
  <div id="bookingSuccessBanner" class="booking-banner success hidden">
  <span id="successMessage"></span>
  <button id="viewBookingsBtn" class="banner-action success">
    View my booked slots →
  </button>
</div>

<div id="bookingCancelBanner" class="booking-banner cancel hidden">
  <span id="cancelMessage"></span>
  <button id="viewBookingsBtnCancel" class="banner-action cancel">
    View my booked slots →
  </button>
</div>

<div id="bookingErrorBanner" class="booking-banner cancel hidden">
  <span id="errorMessage"></span>
</div>




  <section class="card card-full tobt-card">

      <h2>Make a Booking</h2>
<div class="tobt-controls">
  <label for="depSelect">Departure</label>
  <select id="depSelect" class="tobt-select">
        <option value="">Select a departure</option>
        ${adminSheetCache.map(s => {
  const value = `${s.from}-${s.to}-${s.dep_time_utc}`;
const selected = value === preselectedKey ? 'selected' : '';


  return `
    <option
      value="${value}"
      data-from="${s.from}"
      data-to="${s.to}"
      data-date="${s.date_utc}"
      data-dep="${s.dep_time_utc}"
      ${selected}
    >
      ${s.from} → ${s.to} | ${s.dep_time_utc}Z
    </option>
  `;
}).join('')}

      </select>
</div>
      <table class="tobt-table">
        <thead>
          <tr>
            <th>Off-Blocks Time</th><th>Book</th>
            <th>Off-Blocks Time</th><th>Book</th>
          </tr>
        </thead>
        <tbody id="tobtBody"></tbody>
      </table>
    </section>
    <script>
  const select = document.getElementById('depSelect');
  const body = document.getElementById('tobtBody');

  /* =========================
     LOAD TOBT SLOTS
     ========================= */
  async function isReservedTeamCallsign(callsign, cid) {
  const normalized = callsign.trim().toUpperCase();

  const team = await prisma.officialTeam.findFirst({
    where: {
      callsign: normalized,
      participatingWf26: true
    }
  });

  if (!team) {
    return { reserved: false };
  }

  if (Number(team.mainCid) !== Number(cid)) {
    return {
      reserved: true,
      allowed: false,
      teamName: team.teamName
    };
  }

  return {
    reserved: true,
    allowed: true
  };
}

  
     async function loadTobtSlots() {
    body.innerHTML = '';
    if (!select.value) return;

    const opt = select.selectedOptions[0];
    const params = new URLSearchParams({
      from: opt.dataset.from,
      to: opt.dataset.to,
      dateUtc: opt.dataset.date,
      depTimeUtc: opt.dataset.dep
    });

    const res = await fetch('/api/tobt/slots?' + params);
    const data = await res.json();

    if (data.noFlow) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'tobt-message';
      td.textContent = data.message;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    const slots = data;
    // 🔒 Detect if user already has a booking in this sector
let mySectorKey = null;

for (const slot of slots) {
  if (slot.byMe) {
    const parts = slot.slotKey.split('|');
    mySectorKey = parts.slice(0, 3).join('|'); // FROM-TO|date|dep
    break;
  }
}

    const half = Math.ceil(slots.length / 2);
    const leftCol = slots.slice(0, half);
    const rightCol = slots.slice(half);

    for (let i = 0; i < half; i++) {
      const tr = document.createElement('tr');

      [leftCol[i], rightCol[i]].forEach(slot => {
        if (!slot) {
          tr.innerHTML += '<td></td><td></td>';
          return;
        }

        let btn = '';

        const slotSectorKey = slot.slotKey.split('|').slice(0, 3).join('|');

if (slot.byMe) {
  // ✅ ALWAYS show Cancel for own booking
  btn =
    '<button class="tobt-btn cancel" data-action="cancel" data-slot-key="' +
    slot.slotKey + '">Cancel</button>';

} else if (mySectorKey && slotSectorKey === mySectorKey) {
  // 🔒 Same sector, but NOT my slot
  btn =
    '<button class="tobt-btn booked disabled" disabled>' +
    'Booked' +
    '</button>';

} else if (slot.booked) {
  btn =
    '<button class="tobt-btn booked" disabled>Booked</button>';

} else {
  btn =
    '<button class="tobt-btn book" data-action="book" data-slot-key="' +
    slot.slotKey + '">Book</button>';
}




        tr.innerHTML +=
          '<td>' + slot.tobt + '</td>' +
          '<td>' + btn + '</td>';
      });

      body.appendChild(tr);
    }
  }

  /* =========================
     DROPDOWN CHANGE
     ========================= */
  select.addEventListener('change', () => {
    loadTobtSlots();
  });

  /* =========================
     BUTTON HANDLING (BOOK / CANCEL)
     ========================= */
  body.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const action = btn.dataset.action;
    if (!action) return;

    const slotKey = btn.dataset.slotKey;
    const opt = select.selectedOptions[0];
    const tobt = btn.closest('td').previousElementSibling.textContent;

    let callsign;
    if (action === 'book') {
      callsign = await openCallsignModal();
      if (!callsign) return;
      callsign = callsign.trim().toUpperCase();
    }

    const res = await fetch('/api/tobt/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey, callsign })
    });

    if (!res.ok) {
  const err = await res.json();
  showBookingError(
    err.error || 'Booking failed. Please try again.'
  );
  return;
}


    if (action === 'book') {
      showBookingSuccess({
        from: opt.dataset.from,
        to: opt.dataset.to,
        tobt
      });
    }

    if (action === 'cancel') {
      showBookingCancelled({
        from: opt.dataset.from,
        to: opt.dataset.to,
        tobt
      });
    }

    loadTobtSlots();
  });

  /* =========================
     BANNERS
     ========================= */
  function hideBookingBanners() {
    const s = document.getElementById('bookingSuccessBanner');
    const c = document.getElementById('bookingCancelBanner');
    if (s) s.classList.add('hidden');
    if (c) c.classList.add('hidden');
  }

  function showBookingSuccess(data) {
    hideBookingBanners();
    const banner = document.getElementById('bookingSuccessBanner');
    const msg = document.getElementById('successMessage');
    if (!banner || !msg) return;

    msg.textContent =
      'You have successfully booked a slot for ' +
      data.from + ' → ' + data.to +
      ' at ' + data.tobt + ' UTC.';

    banner.classList.remove('hidden');
  }

  function showBookingCancelled(data) {
    hideBookingBanners();
    const banner = document.getElementById('bookingCancelBanner');
    const msg = document.getElementById('cancelMessage');
    if (!banner || !msg) return;

    msg.textContent =
      'Your slot for ' +
      data.from + ' → ' + data.to +
      ' at ' + data.tobt + ' UTC has been cancelled.';

    banner.classList.remove('hidden');
  }
</script>
<script>
  const viewBtn = document.getElementById('viewBookingsBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      window.location.href = '/my-slots';
    });
  }

  const viewBtnCancel = document.getElementById('viewBookingsBtnCancel');
  if (viewBtnCancel) {
    viewBtnCancel.addEventListener('click', () => {
      window.location.href = '/my-slots';
    });
  }
</script>
<script>
function showBookingError(message) {
  hideBookingBanners();
  const banner = document.getElementById('bookingErrorBanner');
  const msg = document.getElementById('errorMessage');
  if (!banner || !msg) return;

  msg.textContent = message;
  banner.classList.remove('hidden');
}
</script>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('depSelect');
  if (!select) return;

  // 🔑 AUTO-LOAD when arriving from "Book Slot" link
  if (select.value) {
    loadTobtSlots();
  }
});
</script>



  `;

  res.send(
    renderLayout({
      title: 'Book a Slot',
      user,
      isAdmin,
      layoutClass: 'dashboard-full', // ✅ ADD THIS
      content
    })
  );
});

app.get('/my-slots', requireLogin, (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/auth/login');
  }

  const user = req.session.user.data;
  const cid = Number(user.cid);

  const isAdmin = ADMIN_CIDS.includes(Number(cid));

  const mySlots = Array.from(tobtBookingsByCid[cid] || []);

  const rows = mySlots.map(slotKey => {
  const booking = tobtBookingsBySlot[slotKey];
  

  const [sectorKey, dateUtc, depTimeUtc, tobtTimeUtc] = slotKey.split('|');
  const [from, to] = sectorKey.split('-');

  const wfRow = adminSheetCache.find(
    r =>
      r.from === from &&
      r.to === to &&
      r.date_utc === dateUtc &&
      r.dep_time_utc === depTimeUtc
  );

  const wfSector = wfRow?.number || '—';
  const atcRoute = wfRow?.atc_route || '—';

  const [h, m] = booking.tobtTimeUtc.split(':').map(Number);

const hh = String(h).padStart(2, '0');
const mm = String(m).padStart(2, '0');
  const connectDate = new Date(Date.UTC(2000, 0, 1, hh, mm - 30));
  const connectBy =
    connectDate.getUTCHours().toString().padStart(2, '0') +
    ':' +
    connectDate.getUTCMinutes().toString().padStart(2, '0');

  const callsign = booking?.callsign || '';
 const [rawH, rawM] = booking.tobtTimeUtc.split(':');

const deph = rawH.padStart(2, '0');
const depm = rawM.padStart(2, '0');


const simbriefUrl =
  'https://dispatch.simbrief.com/options/custom' +
  '?orig=' + from +
  '&dest=' + to +
  '&callsign=' + encodeURIComponent(callsign) +
  '&deph=' + hh +
  '&depm=' + mm +
  '&route=' + encodeURIComponent(atcRoute || '') +
  '&manualrmk=' + encodeURIComponent(
    `WF TOBT [SLOT] ${hh}:${mm} UTC - Route validated from www.worldflight.center`
  );




  return {
    slotKey,
    callsign: booking?.callsign || '',
    wfSector,
    from,
    to,
    tobt: tobtTimeUtc,
    connectBy,
    atcRoute,
    simbriefUrl
  };
});



  const content = `
  <div id="bookingErrorBanner" class="booking-banner cancel hidden">
  <span id="errorMessage"></span>
</div>
  
  <section class="card card-full my-slots-card">
      <h2>My Slots</h2>

      ${rows.length === 0 ? `
        <p><em>You have no booked slots.</em></p>
      ` : `
        <div class="table-scroll my-slots-table-wrapper">
          <table class="my-slots-table">
           <thead>
              <tr>
                <th class="col-wf-sector">WF Sector</th>
                <th class="col-callsign">Callsign</th>
                <th class="col-departure">Departure</th>
                <th class="col-destination">Destination</th>
                <th class="col-tobt">TOBT</th>
                <th class="col-connect">Connect by</th>
                <th class="col-route">ATC Route</th>
                <th class="col-plan">Plan with SimBrief</th>
                <th class="col-actions">Actions</th>
              </tr>
          </thead>

            <tbody>
  ${rows.map(r => `
    <tr>
  <td class="col-wf-sector">${r.wfSector}</td>

  <td class="col-callsign">
    <input
      class="callsign-input"
      data-slotkey="${r.slotKey}"
      data-original="${r.callsign}"
      value="${r.callsign}">
  </td>

  <td class="col-departure">${r.from}</td>
  <td class="col-destination">${r.to}</td>

  <td class="col-tobt tobt-primary">${r.tobt}Z</td>
  <td class="col-connect">${r.connectBy}Z</td>

  <td class="col-route">
    <div class="route-box">
      ${r.atcRoute}
    </div>
  </td>

  <td class="col-plan">
    <a class="simbrief-btn"
       href="${r.simbriefUrl}"
       target="_blank"
       rel="noopener">
      <span class="simbrief-logo">SB</span>
      <span class="simbrief-text">Plan with SimBrief</span>
    </a>
  </td>

  <td class="col-actions">
    <button
      type="button"
      class="tobt-btn cancel cancel-slot-btn"
      data-slot-key="${r.slotKey}"
      data-callsign="${r.callsign}">
      Cancel Slot
    </button>
  </td>
</tr>


  `).join('')}
</tbody>

          </table>
        </div>
      `}
    </section>
    <script>
  function showBookingError(message) {
    const banner = document.getElementById('bookingErrorBanner');
    const msg = document.getElementById('errorMessage');
    if (!banner || !msg) return;

    msg.textContent = message;
    banner.classList.remove('hidden');
  }

  function hideBookingError() {
    const banner = document.getElementById('bookingErrorBanner');
    if (banner) banner.classList.add('hidden');
  }

  async function saveCallsign(input) {
    hideBookingError();

    const callsign = input.value.trim().toUpperCase();
    const slotKey = input.dataset.slotkey;

    const res = await fetch('/api/tobt/update-callsign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey, callsign })
    });

    if (!res.ok) {
  let errText = 'Failed to update callsign';
  try {
    const err = await res.json();
    if (err && err.error) errText = err.error;
  } catch {}

  // 🔁 revert input to last valid value
  input.value = input.dataset.original || '';

  showBookingError(errText);
  return false;
}


    // success
input.dataset.original = callsign;
return true;
  }

  // Save when user clicks away
  document.addEventListener('change', e => {
    if (!e.target.classList.contains('callsign-input')) return;
    saveCallsign(e.target);
  });

  // Save when user presses Enter
  document.addEventListener('keydown', async e => {
    if (!e.target.classList.contains('callsign-input')) return;
    if (e.key !== 'Enter') return;

    e.preventDefault();
    await saveCallsign(e.target);
    e.target.blur();
  });
</script>

<script>
  document.addEventListener('click', async e => {
    const btn = e.target.closest('.cancel-slot-btn');
    if (!btn) return;

    const slotKey = btn.dataset.slotKey;
    const callsign = btn.dataset.callsign || 'this booking';

    const confirmed = await openConfirmModal({
      title: 'Cancel Slot',
      message: 'Cancel TOBT booking for ' + callsign + '? This cannot be undone.'

    });

    if (!confirmed) return;

    const res = await fetch('/api/tobt/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey })
    });

    if (!res.ok) {
      let errText = 'Failed to cancel slot';
      try {
        const err = await res.json();
        if (err?.error) errText = err.error;
      } catch {}
      alert(errText);
      return;
    }

    location.reload();
  });
</script>



  `;

  res.send(
    renderLayout({
      title: 'My Slots',
      user,
      isAdmin,
      layoutClass: 'dashboard-full',
      content
    })
  );
});


/* ===== LOGOUT ===== */
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Logout failed');
    }

    // IMPORTANT: must match session name
    res.clearCookie('worldflight.sid', {
      path: '/'
    });

    return res.redirect('/');
  });
});


/* ===== SERVER START ===== */
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`WorldFlight CDM is running on ${port}`);
});