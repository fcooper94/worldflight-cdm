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

  <aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <img src="/logo.png" class="sidebar-logo" />
    <button id="sidebarToggle" class="sidebar-toggle" aria-label="Toggle sidebar">
  ☰
</button>


  </div>

  <nav class="sidebar-nav">
    <div class="nav-section">
      <div class="nav-title">Pilots</div>
      <a href="/dashboard" class="nav-item">
        <span class="icon">🏠</span>
        <span class="label">Home</span>
      </a>
      <a href="/book" class="nav-item">
        <span class="icon">🗓️</span>
        <span class="label">Book a Slot</span>
      </a>
      <a href="/my-slots" class="nav-item">
        <span class="icon">✈️</span>
        <span class="label">My Slots</span>
      </a>
    </div>

    <div class="nav-section">
      <div class="nav-title">Controllers</div>
      <a href="/atc" class="nav-item">
        <span class="icon">🎧</span>
        <span class="label">ATC Slot Management</span>
      </a>
    </div>

    ${isAdmin ? `
    <div class="nav-section nav-admin">
      <div class="nav-title">Admin</div>
      <a href="/admin" class="nav-item">
        <span class="icon">🛠️</span>
        <span class="label">Admin</span>
      </a>
    </div>
    ` : ''}
  </nav>
</aside>




  <!-- ===== TOPBAR ===== -->
  <header class="topbar">

  <div class="header-center">${title}</div>

  <div class="header-right">
    <div class="user-menu">
      <button id="userMenuToggle" class="user-trigger">
        Welcome, ${user?.personal?.name_full || 'User'}
        <span class="chevron">▾</span>
      </button>

      <div id="userMenu" class="user-dropdown">
        <a href="/logout" class="logout-btn compact">
          <svg
            class="logout-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 2v10" />
            <path d="M6.2 5.2a9 9 0 1 0 11.6 0" />
          </svg>
          <span class="logout-text">Logout</span>
        </a>
      </div>
    </div>
  </div>

</header>


  <!-- ===== PAGE CONTENT ===== -->
  <main class="dashboard ${layoutClass}">

    ${content}
  </main>

  <script>
(() => {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');

  function setCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('sidebarCollapsed', collapsed);
  }

  // Restore previous state
  const saved = localStorage.getItem('sidebarCollapsed') === 'true';
  if (saved !== null) {
  setCollapsed(saved === 'true');
} else {
  setCollapsed(window.innerWidth < 900);
}


  toggle.addEventListener('click', () => {
    setCollapsed(!sidebar.classList.contains('collapsed'));
  });

  window.addEventListener('resize', () => {
    setCollapsed(window.innerWidth < 900);
  });
  // ===== USER MENU DROPDOWN =====
const userToggle = document.getElementById('userMenuToggle');
const userMenu = document.getElementById('userMenu');

if (userToggle && userMenu) {
  userToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenu.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    userMenu.classList.remove('open');
  });
}

})();
</script>

</body>
</html>`;
}
