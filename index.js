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

/* ===== SHARED TOGGLE STATE (GLOBAL) ===== */
const sharedToggles = {};
const sharedDepFlows = {};
const connectedUsers = {};

const sharedTSAT = {};  
// Format:
// { "BAW123": "14:32", "EZY45": "14:36" }


/* ===== ADMIN CID WHITELIST ===== */
const ADMIN_CIDS = [10000010, 1303570, 10000005];

/* ===== GOOGLE SHEET ===== */
const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];
let lastDepartureSnapshot = new Set();

const port = process.env.PORT || 3000;

/* ================= SOCKET.IO ================= */
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  socket.emit('syncState', sharedToggles);
  socket.emit('syncDepFlows', sharedDepFlows);

  socket.on('updateToggle', ({ callsign, type, value }) => {
    if (!sharedToggles[callsign]) sharedToggles[callsign] = {};
    sharedToggles[callsign][type] = value;
    io.emit('toggleUpdated', { callsign, type, value });
  });

  socket.on('updateDepFlow', ({ wfNumber, value }) => {
    sharedDepFlows[wfNumber] = value;
    io.emit('depFlowUpdated', { wfNumber, value });
  });

  /* ✅ FIXED CONNECTED USER TRACKING */
  socket.on('registerUser', ({ cid, position }) => {
    connectedUsers[socket.id] = { cid, position };
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
    console.log('Client disconnected:', socket.id);
  });
  // Send TSAT state to new clients
socket.emit('syncTSAT', sharedTSAT);

// Receive TSAT updates
socket.on('updateTSAT', ({ callsign, tsat }) => {
  sharedTSAT[callsign] = tsat;
  io.emit('tsatUpdated', { callsign, tsat });
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

  const adminRoute = (match.atc_route || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const liveRoute = route.replace(/\s+/g, ' ').trim().toUpperCase();

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
<table class="departures-table">
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
${adminSheetCache.map(r => `
<tr>
  <td>${r.number}</td>
  <td>${r.from}</td>
  <td><input class="dep-flow-input" type="number" data-wf="${r.number}" placeholder="Rate" style="width:70px;"/></td>
  <td>${r.to}</td>
  <td>${r.date_utc}</td>
  <td>${r.dep_time_utc}</td>
  <td>${r.arr_time_utc}</td>
  <td class="col-route">${r.atc_route}</td>
</tr>`).join('')}
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
/* ===== DEP FLOW COLOUR LOGIC (RESTORED) ===== */
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

/* ===== APPLY COLOUR ON LOAD ===== */
socket.on('syncDepFlows', flows => {
  Object.entries(flows).forEach(([wf, value]) => {
    const input = document.querySelector('.dep-flow-input[data-wf="' + wf + '"]');
    if (input) {
      input.value = value;
      applyDepFlowStyle(input);
    }
  });
});

/* ===== APPLY COLOUR ON LIVE UPDATE ===== */
socket.on('depFlowUpdated', ({ wfNumber, value }) => {
  const input = document.querySelector('.dep-flow-input[data-wf="' + wfNumber + '"]');
  if (input) {
    input.value = value;
    applyDepFlowStyle(input);
  }
});

/* ===== APPLY COLOUR ON LOCAL EDIT ===== */
document.querySelectorAll('.dep-flow-input').forEach(input => {
  input.addEventListener('input', () => {
    applyDepFlowStyle(input);

    socket.emit('updateDepFlow', {
      wfNumber: input.dataset.wf,
      value: input.value
    });
  });
});


/* ✅ FIXED ADMIN REGISTRATION */
socket.emit('registerUser', {
  cid: "${req.session.user?.data?.cid || 'UNKNOWN'}",
  position: "${req.session.user?.data?.controller?.callsign || 'UNKNOWN'}"
});

/* ✅ CONNECTED USERS */
socket.on('connectedUsersUpdate', users => {
  const container = document.getElementById('connectedUsersList');
  if (!users.length) {
    container.innerHTML = '<em>No users connected</em>';
    return;
  }
  container.innerHTML = users
    .map(u => \`CID \${u.cid} — \${u.position}\`)
    .join('<br>');
});

/* ✅ DEP FLOW */
socket.on('syncDepFlows', flows => {
  Object.entries(flows).forEach(([wf, value]) => {
    const input = document.querySelector('.dep-flow-input[data-wf="' + wf + '"]');
    if (input) input.value = value;
  });
});

socket.on('depFlowUpdated', ({ wfNumber, value }) => {
  const input = document.querySelector('.dep-flow-input[data-wf="' + wfNumber + '"]');
  if (input) input.value = value;
});

socket.on('syncDepFlows', flows => {
  window.sharedFlowRates = flows;   // Makes flow visible to TSAT calculator
});


document.querySelectorAll('.dep-flow-input').forEach(input => {
  input.addEventListener('input', () => {
    socket.emit('updateDepFlow', { wfNumber: input.dataset.wf, value: input.value });
  });
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

  const rowsHtml = departures.map(p => {
    const wf = getWorldFlightStatus(p);

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
  <td class="col-toggle"><button class="toggle-btn" data-type="clearance" data-callsign="${p.callsign}">⬜</button></td>
  <td class="col-toggle"><button class="toggle-btn" data-type="start" data-callsign="${p.callsign}">⬜</button></td>
  <td class="tsat-cell" data-callsign="${p.callsign}">—</td>
  <td class="col-route">${routeHtml}</td>
</tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="/styles.css"/></head>
<body>

<header class="topbar">
  <div class="header-left"><img src="/logo.png" class="logo-large"/></div>
  <div class="header-center">${icao} Ground Departures</div>
  <div class="header-right"><a href="/dashboard" class="back-btn">← Back</a></div>
</header>

<main class="dashboard">
<section class="card">

<input id="callsignSearch" placeholder="Search by callsign..." />
<div id="refreshTimer">Next auto-refresh in: 20s</div>

<div class="table-scroll">
<table class="departures-table">
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
const searchInput = document.getElementById('callsignSearch');
const savedFilter = localStorage.getItem('callsignFilter') || '';
searchInput.value = savedFilter; applyFilter(savedFilter);

function applyFilter(filter) {
  const upper = filter.toUpperCase();
  document.querySelectorAll('.departures-table tbody tr').forEach(row => {
    const txt = row.children[1].innerText.toUpperCase();
    row.style.display = txt.includes(upper) ? '' : 'none';
  });
}

searchInput.addEventListener('input', function () {
  const val = this.value;
  localStorage.setItem('callsignFilter', val);
  applyFilter(val);
});

document.querySelectorAll('.route-collapsed').forEach(el => {
  el.onclick = () => {
    const exp = el.nextElementSibling;
    exp.style.display = exp.style.display === 'block' ? 'none' : 'block';
  };
});

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
const socket = io();

socket.on('syncState', state => {
  Object.entries(state).forEach(([callsign, toggles]) => {
    Object.entries(toggles).forEach(([type, value]) => {
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
  const btn = document.querySelector(
    '.toggle-btn[data-callsign="' + callsign + '"][data-type="' + type + '"]'
  );
  if (!btn) return;
  btn.innerText = value ? '✅' : '⬜';
  btn.classList.toggle('active', value);
});
socket.on('syncTSAT', data => {
  Object.entries(data).forEach(([callsign, tsat]) => {
    const cell = document.querySelector(
      '.tsat-cell[data-callsign="' + callsign + '"]'
    );
    if (cell) cell.innerText = tsat;
  });
});

socket.on('tsatUpdated', ({ callsign, tsat }) => {
  const cell = document.querySelector(
    '.tsat-cell[data-callsign="' + callsign + '"]'
  );
  if (cell) cell.innerText = tsat;
});



document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const callsign = btn.dataset.callsign;
    const type = btn.dataset.type;

    const isActive = btn.classList.toggle('active');
    btn.innerText = isActive ? '✅' : '⬜';

    socket.emit('updateToggle', { callsign, type, value: isActive });

    /* ===== ✅ STEP 6: TSAT GENERATION WHEN START IS TICKED ===== */
    if (type === 'start' && isActive) {
      const tsat = calculateTSAT();

      const tsatCell = document.querySelector(
  '.tsat-cell[data-callsign="' + callsign + '"]'
);
      if (tsatCell) tsatCell.innerText = tsat;

      socket.emit('updateTSAT', { callsign, tsat });
    }
  });
});

/* ===== TSAT CALCULATION ===== */

function getFlowDelayMinutes() {
  // Find the corresponding WF number row
  const wfCell = document.querySelector('.departures-table tbody tr td:first-child');
  if (!wfCell) return 1;

  const wfNumber = wfCell.innerText.trim();
  return window.sharedFlowRates?.[wfNumber]
    ? Math.max(1, Math.ceil(60 / Number(window.sharedFlowRates[wfNumber])))
    : 1;
}

function calculateTSAT() {
  const now = new Date();
  const delayMins = getFlowDelayMinutes();
  now.setMinutes(now.getMinutes() + Math.max(1, delayMins));

  return now.toTimeString().slice(0, 5);
}

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
