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

  <div id="utcClock" class="utc-clock">00:00:00 UTC</div>

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

  <!-- ===== CALLSIGN MODAL ===== -->
  <div id="callsignModal" class="modal hidden">
    <div class="modal-backdrop"></div>

    <div class="modal-card card">
      <h3>Enter Callsign</h3>
      <p class="modal-help">
        This callsign will be used for your TOBT and SimBrief planning.
      </p>

      <input
        id="callsignModalInput"
        type="text"
        placeholder="e.g. BAW47C"
        maxlength="10"
        autocomplete="off"
      />

      <div class="modal-actions">
        <button id="callsignCancel" class="action-btn">Cancel</button>
        <button id="callsignConfirm" class="action-btn primary">Confirm</button>
      </div>
    </div>
  </div>

    <!-- ===== CALLSIGN MODAL ===== -->
  <div id="callsignModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-card card">
      <h3>Enter Callsign</h3>
      <p class="modal-help">
        This callsign will be used for your TOBT and SimBrief planning.
      </p>

      <input
        id="callsignModalInput"
        type="text"
        placeholder="e.g. BAW47C"
        maxlength="10"
        autocomplete="off"
      />

      <div class="modal-actions">
        <button id="callsignCancel" class="action-btn">Cancel</button>
        <button id="callsignConfirm" class="action-btn primary">Confirm</button>
      </div>
    </div>
  </div>

  <!-- ===== CALLSIGN MODAL LOGIC ===== -->
  <script>
    function openCallsignModal() {
      return new Promise(resolve => {
        const modal = document.getElementById('callsignModal');
        const input = document.getElementById('callsignModalInput');
        const confirm = document.getElementById('callsignConfirm');
        const cancel = document.getElementById('callsignCancel');

        modal.classList.remove('hidden');
        input.value = '';
        input.focus();

        function close(result) {
          modal.classList.add('hidden');
          confirm.removeEventListener('click', onConfirm);
          cancel.removeEventListener('click', onCancel);
          input.removeEventListener('keydown', onKey);
          resolve(result);
        }

        function onConfirm() {
          const value = input.value.trim().toUpperCase();
          if (!value) return;
          close(value);
        }

        function onCancel() {
          close(null);
        }

        function onKey(e) {
          if (e.key === 'Enter') onConfirm();
          if (e.key === 'Escape') onCancel();
        }

        confirm.addEventListener('click', onConfirm);
        cancel.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
      });
    }
  </script>

  <!-- existing scripts follow -->
  <script>
    (() => {
      const sidebar = document.getElementById('sidebar');
      ...
    })();
  </script>


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
<script>
(function () {
  function updateUtcClock() {
    const now = new Date();

    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');

    const el = document.getElementById('utcClock');
    if (el) {
      el.textContent = hh + ':' + mm + ':' + ss + ' UTC';
    }
  }

  updateUtcClock();
  setInterval(updateUtcClock, 1000);
})();
</script>

</body>
</html>`;
}