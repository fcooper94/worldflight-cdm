export default function renderLayout({
  title,
  user,
  isAdmin,
  content,
  layoutClass = ''
}) {

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>

  <!-- ===== SIDEBAR ===== -->
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

      <a href="/atc" class="nav-item atc-only" data-path="/atc">
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

  <!-- ===== TOPBAR ===== -->
  <header class="topbar">
    <div class="header-center">${title}</div>
    <div class="header-right">
      ${user?.personal?.name_full || 'Unknown User'}
    </div>
  </header>

  <!-- ===== PAGE CONTENT ===== -->
  <main class="dashboard ${layoutClass}">

    ${content}
  </main>

  <script>
    (() => {
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
        localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
      };

      const path = window.location.pathname;
      document.querySelectorAll('.nav-item').forEach(link => {
        if (path.startsWith(link.dataset.path)) link.classList.add('active');
      });
    })();
  </script>

</body>
</html>`;
}
