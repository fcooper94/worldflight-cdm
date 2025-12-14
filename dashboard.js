export default (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const details = req.session.user?.data;
  const isAdmin = [10000010, 1303570, 10000005].includes(Number(details?.cid));

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>WorldFlight CDM</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>

  <!-- ===== SIDEBAR ===== -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <a href="/dashboard" aria-label="Dashboard">
        <img src="/logo.png" alt="WorldFlight Logo" class="sidebar-logo" />
      </a>
    </div>

    <div class="sidebar-header">
      <span class="sidebar-title">Navigation</span>
      <button id="sidebarToggle" aria-label="Toggle sidebar">☰</button>
    </div>

    <nav class="sidebar-nav">
      <a href="/dashboard" class="nav-item" data-path="/dashboard">
        <span class="icon">🏠</span>
        <span class="label">Home</span>
      </a>

      <a href="/book" class="nav-item pilot-only" data-path="/book">
        <span class="icon">🗓</span>
        <span class="label">Book a Slot</span>
      </a>

      <a href="/my-slots" class="nav-item pilot-only" data-path="/my-slots">
        <span class="icon">✈️</span>
        <span class="label">My Slots</span>
      </a>

      <a href="/departures" class="nav-item atc-only" data-path="/departures">
        <span class="icon">🧭</span>
        <span class="label">ATC Slot Management</span>
      </a>

      ${isAdmin ? `
      <a href="/admin" class="nav-item admin-only" data-path="/admin">
        <span class="icon">🛠</span>
        <span class="label">Admin</span>
      </a>` : ``}
    </nav>
  </aside>

  <!-- ===== HEADER ===== -->
  <header class="topbar">
    <div class="header-center">WorldFlight CDM</div>
    <div class="header-right">
      Welcome Back, ${details?.personal?.name_full || 'Unknown User'}
    </div>
  </header>

  <!-- ===== DASHBOARD BODY ===== -->
  <main class="dashboard">
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

    <section class="card">
      <h2>Status</h2>
      <div class="status ${details?.callsign ? 'online' : 'offline'}">
        ${details?.callsign ? 'ATC Online' : 'Offline'}
      </div>
    </section>
  </main>

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

<script>
(() => {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebarToggle');
  const isMobile = window.matchMedia('(max-width: 900px)').matches;

  let collapsed = localStorage.getItem('sidebarCollapsed');
  if (collapsed === null) collapsed = isMobile ? 'true' : 'false';

  if (collapsed === 'true') {
    sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
  }

  toggleBtn?.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem(
      'sidebarCollapsed',
      sidebar.classList.contains('collapsed')
    );
  });

  const path = window.location.pathname;
  document.querySelectorAll('.nav-item').forEach(link => {
    if (path.startsWith(link.dataset.path)) link.classList.add('active');
  });
})();
</script>

</body>
</html>`);
};
