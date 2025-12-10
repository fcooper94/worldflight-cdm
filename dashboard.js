export default (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const details = req.session.user?.data;

  const isAdmin = [10000010, 1303570].includes(Number(details?.cid));


  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>WorldFlight CDM</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>

  <!-- ===== HEADER ===== -->
  <header class="topbar">
    <div class="header-left">
      <img src="/logo.png" alt="WorldFlight CDM Logo" class="logo-large" />
    </div>

    <div class="header-center">
      WorldFlight CDM
    </div>

    <div class="header-right">
    ${isAdmin ? `<a href="/admin" class="back-btn">Admin</a>` : ``}

      Welcome Back, ${details?.personal?.name_full || 'Unknown User'}
    </div>
  </header>

  <!-- ===== DASHBOARD BODY ===== -->
  <main class="dashboard">

    <!-- SESSION INFO CARD -->
    <section class="card">
      <h2>Session Info</h2>

      <div class="stat">
        <span>VATSIM ID</span>
        <strong>${details?.cid || 'N/A'}</strong>
      </div>

      <div class="stat">
        <span>Controller Callsign</span>
        <strong>${details?.callsign || 'Not Connected'}</strong>
      </div>
    </section>

    <!-- STATUS CARD -->
    <section class="card">
      <h2>Status</h2>

      <div class="status ${details?.callsign ? 'online' : 'offline'}">
        ${details?.callsign ? 'ATC Online' : 'Offline'}
      </div>

    </section>

  </main>

  <!-- ===== FOOTER ===== -->
    <!-- ===== FOOTER ===== -->
  <footer>

    <form action="/departures" method="GET" class="icao-search">
      <input 
        type="text" 
        name="icao" 
        placeholder="Enter ICAO (e.g. EGLL)" 
        maxlength="4" 
        required
      />
      <button type="submit">Search Departures</button>
    </form>

    <br />

    <a href="/logout">Logout</a>
  </footer>


</body>
</html>
  `);
};
