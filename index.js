import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import axios from 'axios';
import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import dashboard from './dashboard.js';
import cron from 'node-cron';

import { createServer } from 'http';
import { Server } from 'socket.io';

/* ===== EXPRESS + HTTP SERVER ===== */
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

/* ===== SHARED STATE (GLOBAL) ===== */
const sharedToggles = {};      // { callsign: { clearance: bool, start: bool, sector?: "EGCC-EGLL" } }
const sharedDepFlows = {};     // { "EGCC-EGLL": 3, ... }  (per sector: FROM-TO)
const connectedUsers = {};     // { socketId: { cid, position } }
const sharedTSAT = {};         // { "BAW123": "14:32", ... }
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

function buildUpcomingTSATsForICAO(icao, vatsimPilots = []) {
  const list = [];

  for (const [callsign, tsat] of Object.entries(sharedTSAT)) {
    if (startedAircraft[callsign]) continue;

    // Try optional VATSIM enrichment BUT DO NOT FILTER BY IT
    let dest = '----';
    const pilot = vatsimPilots.find(p => p.callsign === callsign);

    if (pilot && pilot.flight_plan) {
      dest = pilot.flight_plan.arrival || '----';
    }

    // Only requirement: the callsign must belong to this airport
    // Use sector stored in toggles instead of VATSIM
    // Determine origin based on VATSIM flight plan if available
let fromICAO = null;

if (pilot && pilot.flight_plan) {
  fromICAO = pilot.flight_plan.departure?.toUpperCase() || null;
} else {
  // If VATSIM data missing, fall back to stored sector if available
  const sector = sharedToggles[callsign]?.sector || null;
  if (sector) fromICAO = sector.split('-')[0];
}

if (fromICAO !== icao) continue;


    list.push({ callsign, dest, tsat });
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

  sharedTSAT[callsign] = tsatStr;

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

/* ================= SOCKET.IO ================= */
io.on('connection', socket => {

  

socket.on('requestUpcomingTSAT', async ({ icao } = {}) => {
  try {
    if (!icao) {
      socket.emit('upcomingTSATUpdate', []);
      return;
    }

    const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const pilots = response.data.pilots;

    const upcoming = buildUpcomingTSATsForICAO(icao, pilots);
    socket.emit('upcomingTSATUpdate', upcoming);
  } catch (err) {
    console.error('Failed to build Upcoming TSAT list:', err.message);
    socket.emit('upcomingTSATUpdate', []);
  }
});



  console.log('Client connected:', socket.id);

  // Initial sync to client
  socket.emit('syncState', sharedToggles);
  socket.emit('syncDepFlows', sharedDepFlows);
  socket.emit('syncTSAT', sharedTSAT);
  socket.emit('connectedUsersUpdate', Object.values(connectedUsers));

  /* ===== SHARED CLR/START TOGGLE STATE ===== */
  socket.on('updateToggle', ({ callsign, type, value, sector }) => {
    if (!sharedToggles[callsign]) {
      sharedToggles[callsign] = {};
    }

    sharedToggles[callsign][type] = value;

    // Record sector if provided (for TSAT purposes)
    if (sector) {
      sharedToggles[callsign].sector = normalizeSectorKey(sector);
    }

    // If START is unticked, clear TSAT for this callsign
    if (type === 'start' && value === false) {
      const s =
        sector ||
        sharedToggles[callsign].sector ||
        null;
      if (s) {
        clearTSAT(s, callsign);
        io.emit('tsatUpdated', { callsign, tsat: '' });
      }
    }

    /* ===== TSAT STARTED FLAG ===== */



    io.emit('toggleUpdated', { callsign, type, value });
  });

  /* ===== DEP FLOW (PER SECTOR, FROM-TO) ===== */
  socket.on('updateDepFlow', ({ sector, value }) => {
    const sectorKey = normalizeSectorKey(sector);
    sharedDepFlows[sectorKey] = Number(value) || 0;

    io.emit('depFlowUpdated', {
      sector: sectorKey,
      value: sharedDepFlows[sectorKey]
    });
  });

  /* ===== CONNECTED USER TRACKING ===== */
  socket.on('registerUser', ({ cid, position }) => {
    connectedUsers[socket.id] = { cid, position };
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
  });

  /* ===== TSAT REQUEST / CANCEL / REFRESH ===== */
  socket.on('requestTSAT', async ({ callsign, sector }) => {
  if (!callsign || !sector) return;

  const tsat = assignTSAT(sector, callsign);
  io.emit('tsatUpdated', { callsign, tsat });

  const icao = sector.split('-')[0];

  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
  const upcoming = buildUpcomingTSATsForICAO(icao, response.data.pilots);

  io.emit('upcomingTSATUpdate', upcoming);
});



  socket.on('recalculateTSAT', ({ callsign, sector }) => {
    // Alias to requestTSAT behaviour, but kept as a distinct event.
    if (!callsign || !sector) return;

    const tsat = assignTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat });
  });

  // Backwards-compatible: direct TSAT update from client (not recommended, but kept)
  socket.on('updateTSAT', ({ callsign, tsat }) => {
    sharedTSAT[callsign] = tsat;
    io.emit('tsatUpdated', { callsign, tsat });
  });

  socket.on('cancelTSAT', async ({ callsign, sector }) => {
  if (!callsign || !sector) return;

  clearTSAT(sector, callsign);
  io.emit('tsatUpdated', { callsign, tsat: '' });

  const icao = sector.split('-')[0];

  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
  const upcoming = buildUpcomingTSATsForICAO(icao, response.data.pilots);

  io.emit('upcomingTSATUpdate', upcoming);
});


  socket.on('markTSATStarted', ({ callsign }) => {
  startedAircraft[callsign] = true;
  delete sharedTSAT[callsign];
  io.emit('tsatStartedUpdated', startedAircraft);
});

socket.on('unmarkTSATStarted', ({ callsign }) => {
  delete startedAircraft[callsign];
  io.emit('tsatStartedUpdated', startedAircraft);
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
app.use(session({
  name: 'worldflight.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

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
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Admin</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>

<header class="topbar">
  <div class="header-left"><img src="/logo.png" class="logo-large"/></div>
  <div class="header-center">Admin Control Panel</div>
  <div class="header-right"><a href="/dashboard" class="back-btn">← Back</a></div>
</header>

<main class="dashboard">
<section class="card">

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

<footer class="connected-users-footer">
  <strong>Connected Users:</strong>
  <div id="connectedUsersList">Loading...</div>
</footer>

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

</body>
</html>
`);
});

/* ===== DEPARTURES PAGE ===== */
app.get('/departures', async (req, res) => {
  const icao = req.query.icao?.toUpperCase();
  if (!icao || icao.length !== 4) return res.send('Invalid ICAO code.');

  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
  const pilots = response.data.pilots;

  const departures = pilots.filter(
    
    p => p.flight_plan && p.flight_plan.departure === icao && p.groundspeed < 5
  );

const upcomingTSATs = buildUpcomingTSATsForICAO(icao, pilots);

  
  const rowsHtml = departures.map(p => {
    const wf = getWorldFlightStatus(p);
    const sectorKey = `${p.flight_plan.departure}-${p.flight_plan.arrival}`;

    let wfCell = `<td></td>`;
    if (wf.isWF && wf.routeMatch) wfCell = `<td>✅</td>`;
    else if (wf.isWF && !wf.routeMatch)
      wfCell = `<td title="ATC route mismatch"><span class="wf-icons">✅ ⚠️</span></td>`;

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
    <button class="toggle-btn" data-type="clearance" data-callsign="${p.callsign}">
      ⬜
    </button>
  </td>
  <td class="col-toggle">
    <button
      class="toggle-btn"
      data-type="start"
      data-callsign="${p.callsign}"
      data-sector="${sectorKey}"
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




  res.send(`<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/styles.css"/>
  <style>
    .tsat-refresh {
      margin-left: 4px;
      border: none;
      background: none;
      cursor: pointer;
      color: #2ecc71; /* nice green */
      font-size: 0.9rem;
    }
    .tsat-refresh:hover {
      transform: scale(1.1);
    }
  </style>
</head>
<body>

<header class="topbar">
  <div class="header-left"><img src="/logo.png" class="logo-large"/></div>
  <div class="header-center">${icao} Ground Departures</div>
  <div class="header-right"><a href="/dashboard" class="back-btn">← Back</a></div>
</header>

<main class="dashboard">
<section class="card">

<h3 style="margin-bottom:10px;">Upcoming TSATs</h3>

<div class="tsat-top-row">
  <div class="tsat-top-left">
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
        <tr><td colspan="4"><em>No TSATs scheduled</em></td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <div class="tsat-top-right">
    <!-- empty for now – space reserved for future content -->
  </div>
</div>



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
<tbody>${rowsHtml}</tbody>
</table>
</div>

</section>
</main>

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
document.querySelectorAll('.route-collapsed').forEach(el => {
  el.onclick = () => {
    const exp = el.nextElementSibling;
    exp.style.display = exp.style.display === 'block' ? 'none' : 'block';
  };
});

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
  if (data.changed) location.reload();
}, 20000);

setInterval(() => location.reload(), 120000);
</script>

<script src="/socket.io/socket.io.js"></script>

<script>
/* ----------------------------------------------------
   SOCKET INIT
---------------------------------------------------- */
const socket = io();

// Re-use the ICAO already defined earlier on the page
socket.on('connect', () => {
  socket.emit('requestUpcomingTSAT', { icao });
});




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
    tr.innerHTML =
      '<td>' + item.callsign + '</td>' +
      '<td>' + (item.tsat || '\u2014') + '</td>' +
      '<td>' +
        '<input type="checkbox" class="tsat-started-check" data-callsign="' +
        item.callsign +
        '">' +
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

socket.on('tsatStartedUpdated', started => {
  document.querySelectorAll('.tsat-started-check').forEach(cb => {
    const callsign = cb.dataset.callsign;
    cb.checked = !!started[callsign];
  });
});

/* Checkbox for Started / Unstarted */
document.addEventListener('change', function (e) {
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
      socket.emit('requestTSAT', { callsign, sector });
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


</body>
</html>`);
});

/* ===== LOGOUT ===== */
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ===== SERVER START ===== */
httpServer.listen(port, () => {
  console.log(`WorldFlight CDM running on http://localhost:${port}`);
});
