import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import axios from 'axios';
import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import dashboard from './dashboard.js';
import cron from 'node-cron';


/* ===== ADMIN CID WHITELIST (ADDED) ===== */
const ADMIN_CIDS = [10000010, 1303570];

const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];


const app = express();
const port = process.env.PORT || 3000;

async function refreshAdminSheet() {
  try {
    const res = await axios.get(GOOGLE_SHEET_CSV_URL);

    const lines = res.data
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const headers = lines[0]
      .split(',')
      .map(h => h.replace(/"/g, '').trim());

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
        departure_name: cols[idx.departure_name] || '',
        to: cols[idx.to] || '',
        destination_name: cols[idx.destination_name] || '',
        date_utc: cols[idx.date_utc] || '',
        dep_time_utc: cols[idx.dep_time_utc] || '',
        arr_time_utc: cols[idx.arr_time_utc] || '',
        atc_route: cols[idx.atc_route] || ''
      };
    }).filter(r =>
      r.number || r.from || r.destination_name || r.atc_route
    );

    console.log(
      '✅ Admin Sheet refreshed correctly:',
      adminSheetCache.length,
      'rows'
    );

  } catch (err) {
    console.error('❌ Failed to refresh Admin Sheet:', err.message);
  }
}


// Run once at startup
refreshAdminSheet();

// Run every 24 hours at midnight UTC
cron.schedule('0 0 * * *', refreshAdminSheet);



// Session middleware
app.use(session({
  name: 'worldflight.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax'
  }
}));

/* ===== ADMIN AUTH MIDDLEWARE (ADDED) ===== */
function requireAdmin(req, res, next) {
  const cid = req.session?.user?.data?.cid;

  if (!cid || !ADMIN_CIDS.includes(Number(cid))) {
    return res.status(403).send('Access Denied: Admins Only');
  }

  next();
}

app.use(express.static('public'));

app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/dashboard', dashboard);

/* ===== ADMIN ROUTE (ADDED) ===== */
app.get('/admin', requireAdmin, (req, res) => {
  const name = req.session.user?.data?.personal?.name_full || 'Admin';

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Admin Panel</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>

<header class="topbar">
  <div class="header-left">
    <img src="/logo.png" class="logo-large" />
  </div>

  <div class="header-center">
    Admin Control Panel
  </div>

  <div class="header-right">
    <a href="/dashboard" class="back-btn">← Back</a>
  </div>
</header>

<main class="dashboard">

<section class="card">
  <h2>WorldFlight Admin Schedule</h2>

<div style="margin-bottom:18px;">
  <button id="refreshScheduleBtn"
    style="
      padding:10px 18px;
      border-radius:10px;
      border:none;
      background:#16a34a;
      color:white;
      font-weight:700;
      cursor:pointer;
      box-shadow:0 0 16px rgba(22,163,74,.45);
    ">
    ⟳ Force Refresh Schedule
  </button>
</div>

<script>
document.getElementById('refreshScheduleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshScheduleBtn');
  btn.innerText = 'Refreshing...';
  btn.disabled = true;

  try {
    const res = await fetch('/admin/refresh-schedule', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      location.reload();
    } else {
      alert('Refresh failed.');
    }
  } catch (e) {
    alert('Refresh failed.');
  }

  btn.innerText = '⟳ Force Refresh Schedule';
  btn.disabled = false;
});
</script>


  <div class="table-scroll">
    <table class="departures-table">
      <thead>
        <tr>
  <th class="col-wf-sector">Sector</th>
  <th class="col-from">From</th>
  <th class="col-to">To</th>
  <th class="col-date">Date (UTC)</th>
  <th class="col-time">Dep (UTC)</th>
  <th class="col-time">Arr (UTC)</th>
  <th class="col-route">ATC Route</th>
</tr>

      </thead>
      <tbody>

        ${adminSheetCache.map(r => `
  <tr>
    <td class="col-wf-sector">${r.number}</td>
    <td class="col-from">${r.from}</td>
    <td class="col-to">${r.to}</td>
    <td class="col-date">${r.date_utc}</td>
    <td class="col-time">${r.dep_time_utc}</td>
    <td class="col-time">${r.arr_time_utc}</td>
    <td class="col-route">${r.atc_route}</td>
  </tr>
`).join('')}


      </tbody>
    </table>
  </div>
</section>



</main>

</body>
</html>
  `);
});

app.post('/admin/refresh-schedule', requireAdmin, async (req, res) => {
  try {
    await refreshAdminSheet();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});



app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ===== YOUR EXISTING DEPARTURES ROUTE (UNCHANGED) ===== */
app.get('/departures', async (req, res) => {
  const icao = req.query.icao?.toUpperCase();

  if (!icao || icao.length !== 4) {
    return res.send('Invalid ICAO code.');
  }

  try {
    const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const pilots = response.data.pilots;

    // ✅ Aircraft on ground at the selected airport
    const departures = pilots.filter(p =>
      p.flight_plan &&
      p.flight_plan.departure === icao &&
      p.groundspeed < 5
    );

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${icao} Departures</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>

<header class="topbar">
  <div class="header-left">
    <img src="/logo.png" class="logo-large" />
  </div>

  <div class="header-center">
    ${icao} Ground Departures
  </div>

  <div class="header-right">
    <a href="/dashboard" class="back-btn">← Back</a>
  </div>
</header>

<main class="dashboard">

  <section class="card">
    <div class="table-scroll">
  <table class="departures-table">
    <thead>
      <tr>
        <th class="col-callsign">Callsign</th>
        <th class="col-aircraft">Aircraft</th>
        <th class="col-destination">Destination</th>
        <th class="col-route">ATC Route</th>
      </tr>
    </thead>
    <tbody>

      ${departures.map(p => `
        <tr>
          <td class="col-callsign">${p.callsign}</td>
          <td class="col-aircraft">${p.flight_plan.aircraft_faa || 'N/A'}</td>
          <td class="col-destination">${p.flight_plan.arrival || 'N/A'}</td>
          <td class="col-route">${p.flight_plan.route || 'N/A'}</td>
        </tr>
      `).join('')}

    </tbody>
  </table>
</div>


    ${departures.length === 0 ? `<p style="text-align:center; padding:20px;">No aircraft on ground.</p>` : ''}

  </section>

</main>

</body>
</html>
    `);

  } catch (err) {
    console.error(err);
    res.send('Failed to load VATSIM data.');
  }
});

app.listen(port, () => {
  console.log(`WorldFlight CDM running on http://localhost:${port}`);
  console.log('ENV check:', {
    VATSIM_CLIENT_ID: process.env.VATSIM_CLIENT_ID,
    VATSIM_REDIRECT_URI: process.env.VATSIM_REDIRECT_URI
  });
});
