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

  <!-- Leaflet (global, safe) -->
  <link
  rel="stylesheet"
  href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
/>

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
      <a href="/wf-schedule" class="nav-item">
        <span class="icon">🛠️</span>
        <span class="label">WF Schedule / Flow</span>
      </a>
      <a href="/official-teams" class="nav-item">
        <span class="icon">👥</span>
        <span class="label">Official Teams / Affiliates</span>
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

  ${user ? `
    <div class="user-menu">
      <button id="userMenuToggle" class="user-trigger">
        Welcome, ${user.personal?.name_full}
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
  ` : `
    <a href="/auth/login" class="login-btn">
      Login with VATSIM
    </a>
  `}
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
      <h3 id="modalTitle">Enter Callsign</h3>
<p id="modalHelp" class="modal-help">
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

  <script>
function openConfirmModal({ title, message }) {
  return new Promise(resolve => {
    const modal = document.getElementById('callsignModal');
    const titleEl = document.getElementById('modalTitle');
    const helpEl = document.getElementById('modalHelp');
    const input = document.getElementById('callsignModalInput');
    const confirm = document.getElementById('callsignConfirm');
    const cancel = document.getElementById('callsignCancel');

    titleEl.textContent = title;
    helpEl.textContent = message;

    input.style.display = 'none'; // no input for confirm
    modal.classList.remove('hidden');

    function close(result) {
      modal.classList.add('hidden');
      input.style.display = '';
      confirm.removeEventListener('click', onConfirm);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }

    function onConfirm() { close(true); }
    function onCancel() { close(false); }

    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', onCancel);
  });
}
</script>

<script>
  function openConfirmModal({ title, message }) {
    return new Promise(resolve => {
      const modal = document.getElementById('callsignModal');
      const card = modal.querySelector('.modal-card');

      // Reuse existing elements
      const h3 = card.querySelector('h3');
      const help = card.querySelector('.modal-help');
      const input = document.getElementById('callsignModalInput');
      const confirm = document.getElementById('callsignConfirm');
      const cancel = document.getElementById('callsignCancel');

      // Set confirm content
      if (h3) h3.textContent = title || 'Confirm';
      if (help) help.textContent = message || '';

      // Hide input for confirmations
      input.style.display = 'none';

      modal.classList.remove('hidden');
      cancel.focus();

      function close(result) {
        modal.classList.add('hidden');
        input.style.display = ''; // restore
        confirm.removeEventListener('click', onConfirm);
        cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }

      function onConfirm() { close(true); }
      function onCancel() { close(false); }

      function onKey(e) {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      }

      confirm.addEventListener('click', onConfirm);
      cancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }
</script>



  <!-- existing scripts follow -->
  <script>
    (() => {
      const sidebar = document.getElementById('sidebar');
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
<!-- Leaflet JS -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="/icao-map.js"></script>

<div id="mapModal" class="map-modal hidden">
  <div class="map-modal-backdrop"></div>

  <div class="map-modal-panel">
    <div class="map-modal-header">
      <span id="mapModalTitle">Airport Map</span>
      <button id="closeMapModal" aria-label="Close map">✕</button>
    </div>

    <div id="mapModalMap"></div>
  </div>
</div>


</body>
</html>`;
}