import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import axios from 'axios';
import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import dashboard from './dashboard.js';
import cron from 'node-cron';
import renderLayout from './layout.js';

import { createServer } from 'http';
import { Server } from 'socket.io';

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


/* ===== EXPRESS + HTTP SERVER ===== */
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});



/* ===== SHARED STATE (GLOBAL) ===== */
const sharedToggles = {};      // { callsign: { clearance: bool, start: bool, sector?: "EGCC-EGLL" } }
const sharedDepFlows = {};     // { "EGCC-EGLL": 3, ... }  (per sector: FROM-TO)
const connectedUsers = {};     // { socketId: { cid, position } }

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

function canEditIcao(user, pageIcao) {
  if (!user) return false;
  if (ADMIN_CIDS.includes(Number(user.cid))) return true;

  const cs = user.callsign || '';
  return cs.startsWith(pageIcao + '_') && !cs.endsWith('_OBS');
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

  // Skip aircraft that have already started
  if (startedAircraft[callsign]) continue;

  // Authoritative: determine FROM airport from stored sector
  const tsatIcao = tsatObj.icao;
if (tsatIcao !== icao) continue;


  // Optional: enrich dest from VATSIM if available
  let dest = '----';
  const pilot = vatsimPilots.find(p => p.callsign === callsign);
  if (pilot && pilot.flight_plan) {
    dest = pilot.flight_plan.arrival || dest;
  }

  const tsatStr = tsatObj?.tsat || '----';
  list.push({ callsign, dest, tsat: tsatStr });
}

return list
  .sort((a, b) => a.tsat.localeCompare(b.tsat))
  .slice(0, 5);

}

/* ===== ADMIN CID WHITELIST ===== */
const ADMIN_CIDS = [10000010, 1303570, 10000005];

/* ===== GOOGLE SHEET ===== */
const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];
let lastDepartureSnapshot = new Set();

const port = process.env.PORT || 3000;

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

  const earliest = new Date(now.getTime() + 1 * 60000); // +1 minute minimum

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

await refreshPilots();
setInterval(refreshPilots, 60000);

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

// ✅ Rebuild TSATs for late joiners (keep this)
if (icaoFromQuery) rebuildTSATStateForICAO(icaoFromQuery);

// ✅ These can stay as-is
socket.emit('syncState', sharedToggles);
socket.emit('syncDepFlows', sharedDepFlows);

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

  // 🔑 Ensure TSATs exist for already-started aircraft
  rebuildTSATStateForICAO(icao);

  // ICAO-scoped tables
  socket.emit(
    'upcomingTSATUpdate',
    buildUpcomingTSATsForICAO(icao, cachedPilots)
  );

  socket.emit(
    'recentlyStartedUpdate',
    buildRecentlyStartedForICAO(icao)
  );

  // Global state
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
    if (!callsign || !type) return;
    if (!canEditSector(sector)) return;

    if (!sharedToggles[callsign]) sharedToggles[callsign] = {};
    sharedToggles[callsign][type] = value;

    if (sector) {
      sharedToggles[callsign].sector = normalizeSectorKey(sector);
    }

    const activeSector = sector || sharedToggles[callsign].sector;
    const icao = activeSector?.split('-')[0];

    if (type === 'start' && value === true && activeSector) {
      const tsat = assignTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat });
      io.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icao, cachedPilots));
    }

    if (type === 'start' && value === false && activeSector) {
      clearTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat: '' });
      io.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icao, cachedPilots));
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
    io.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icao, cachedPilots));
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
      sharedTSAT[callsign] = { tsat: entry.tsat };
    }

    delete recentlyStarted[callsign];
    delete startedAircraft[callsign];

    io.emit('tsatStartedUpdated', startedAircraft);
    io.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(entry.icao, cachedPilots));
    io.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(entry.icao, cachedPilots));
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

  socket.on('updateDepFlow', ({ sector, value }) => {
    const key = normalizeSectorKey(sector);
    sharedDepFlows[key] = Number(value) || 0;
    io.emit('depFlowUpdated', { sector: key, value: sharedDepFlows[key] });
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

/* ===== ADMIN AUTH ===== */
function requireAdmin(req, res, next) {
  const cid = req.session?.user?.data?.cid;
  if (!cid || !ADMIN_CIDS.includes(Number(cid))) {
    return res.status(403).send('Access Denied: Admins Only');
  }
  next();
}

/* ===== WF STATUS ===== */
function getWorldFlightStatus(pilot) {
  if (!pilot.flight_plan) return { isWF: false, routeMatch: false };

  const from = pilot.flight_plan.departure;
  const to = pilot.flight_plan.arrival;
  const route = (pilot.flight_plan.route || '').trim();

  const match = adminSheetCache.find(wf => wf.from === from && wf.to === to);
  if (!match) return { isWF: false, routeMatch: false };

  const adminRoute = (match.atc_route || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const liveRoute = route
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  return { isWF: true, routeMatch: adminRoute === liveRoute };
}

app.use(express.static('public'));

app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/dashboard', dashboard);

/* ===== ADMIN MANUAL REFRESH ===== */
app.post('/admin/refresh-schedule', requireAdmin, async (req, res) => {
  await refreshAdminSheet();
  res.json({ success: true });
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
app.get('/admin', requireAdmin, (req, res) => {
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
  <td class="col-route">${r.atc_route}</td>
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
  await fetch('/admin/refresh-schedule', { method: 'POST' });
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
`;
res.send(
  renderLayout({
    title: 'Admin',
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

  const rowsHtml = departures.map(p => {
    const wf = getWorldFlightStatus(p);
    const sectorKey = `${p.flight_plan.departure}-${p.flight_plan.arrival}`;

    let wfCell = `<td></td>`;
    if (wf.isWF && wf.routeMatch) wfCell = `<td>✅</td>`;
    else if (wf.isWF && !wf.routeMatch)
      wfCell = `<td title="ATC route mismatch"><span class="wf-icons">✅ ⚠️</span></td>`;

// after canEdit logic


const departuresHtml = `
  <button class="start-btn" ${disabledAttr}>START</button>
`;


    const routeHtml = p.flight_plan.route
      ? `<span class="route-collapsed">Click to expand</span><span class="route-expanded" style="display:none;">${p.flight_plan.route}</span>`
      : 'N/A';

    return `
<tr>
  ${wfCell}
  <td>${p.callsign}</td>
  <td>${p.flight_plan.aircraft_faa || 'N/A'}</td>
  <td>${p.flight_plan.arrival || 'N/A'}</td>
  <td class="col-toggle">
    <button
  class="toggle-btn"
  data-type="clearance"
  data-callsign="${p.callsign}"
  ${disabledAttr}
>
  ⬜
</button>

  </td>
  <td class="col-toggle">
    <button
  class="toggle-btn"
  data-type="start"
  data-callsign="${p.callsign}"
  data-sector="${sectorKey}"
  ${disabledAttr}
>
  ⬜
</button>

  </td>
  <td class="tsat-cell" data-callsign="${p.callsign}">
    <span class="tsat-time">—</span>
    <button
      class="tsat-refresh"
      data-callsign="${p.callsign}"
      style="display:none;"
    >
      ⟳
    </button>
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
<div class="tsat-top-row">
      <!-- LEFT COLUMN -->
      <div class="tsat-top-left">
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
            <tbody>
              <tr>
                <td colspan="3"><em>No TSATs scheduled</em></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- RIGHT COLUMN -->
      <div class="tsat-top-right">
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
            <tbody>
              <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
              <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
              <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
              <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
              <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
            </tbody>
          </table>
        </div>
      </div>
</div>
    </div>
    <!-- END TSAT TOP ROW -->


    <!-- SEARCH + TIMER + MAIN TABLE -->
    <input id="callsignSearch" placeholder="Search by callsign..." />
    <div id="refreshTimer">Next auto-refresh in: 20s</div>

    <div class="table-scroll">
      <table class="departures-table" id="mainDeparturesTable">
        <thead>
          <tr>
            <th>WF</th>
            <th>Callsign</th>
            <th>Aircraft</th>
            <th>Dest</th>
            <th class="col-toggle">CLR</th>
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
      exp.style.display = exp.style.display === 'block' ? 'none' : 'block';
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
  document.getElementById('refreshTimer').innerText =
    'Next auto-refresh in: ' + countdown + 's';
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
'" ' + (${canEdit} ? '' : 'disabled') + '>'
 +
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

/* ----------------------------------------------------
   RESTORE TOGGLES
---------------------------------------------------- */
socket.on('syncState', state => {
  Object.entries(state).forEach(([callsign, toggles]) => {
    Object.entries(toggles).forEach(([type, value]) => {
      if (type !== 'clearance' && type !== 'start') return;
      const btn = document.querySelector(
        '.toggle-btn[data-callsign="' + callsign + '"][data-type="' + type + '"]'
      );
      if (btn) {
        btn.innerText = value ? '✅' : '⬜';
        btn.classList.toggle('active', value);
      }
    });
  });
});


socket.on('toggleUpdated', ({ callsign, type, value }) => {
  if (type !== 'clearance' && type !== 'start') return;
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

  const MAX_ROWS = 5;

  data.slice(0, MAX_ROWS).forEach(item => {
    const tr = document.createElement('tr');

    tr.innerHTML =
  '<td>' + item.callsign + '</td>' +
  '<td>' + item.startedAt + '</td>' +
  '<td>' +
    '<button class="send-back-btn action-btn" data-callsign="' + item.callsign + '">' +
      'Send Back' +
    '</button>' +
    '<button class="delete-started-btn action-btn" data-callsign="' + item.callsign + '" title="Delete entry">' +
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
  if (!e.target.classList.contains('send-back-btn')) return;
  const callsign = e.target.dataset.callsign;
  if (!callsign) return;

  socket.emit('sendBackToUpcoming', { callsign, icao });
});
/* Handle DELETE button for Recently Started */
document.addEventListener('click', e => {
  if (!e.target.classList.contains('delete-started-btn')) return;

  const callsign = e.target.dataset.callsign;
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
socket.emit('requestSyncAllState', { icao});
</script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  // IMPORTANT: listeners must already be defined ABOVE this
  socket.emit('requestSyncAllState', { icao, cachedPilots});

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

app.get('/atc', (req, res) => {
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



/* ===== LOGOUT ===== */
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ===== SERVER START ===== */
httpServer.listen(port, () => {
  console.log(`WorldFlight CDM running on http://localhost:${port}`);
});