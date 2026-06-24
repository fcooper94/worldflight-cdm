export default function renderLayout({
  title,
  user,
  isAdmin,
  isMaster = false,
  isTeamMember = false,
  isAffiliate = false,
  isWfAtc = false,
  canManageAffiliateMembers = false,
  content,
  layoutClass = '',
  pageVisibility = {},
  hideSidebar = false,
  siteBanner = { enabled: false, text: '' },
  loginOverlay = false,
  activeEvent = null
}) {
  // pageVisibility[key] is a string mode: 'visible' | 'hidden' | 'admin-only'.
  // Show in nav when visible to all, or when admin-only and viewer is an admin.
  // 'hidden' means hidden from the nav for everyone (admin can still URL-navigate).
  const pv = (key) => {
    const m = pageVisibility[key];
    if (m === undefined || m === 'visible' || m === true) return true;  // default visible
    if (m === 'admin-only') return isAdmin;
    return false; // 'hidden' or false (legacy boolean)
  };

  // Lucide-style line icons. fill=none, stroke=currentColor so they pick up nav-item colours.
  const svg = (paths) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const icons = {
    home:        svg('<path d="M3 9.5 12 2l9 7.5V21a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>'),
    calendar:    svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    building:    svg('<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>'),
    map:         svg('<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>'),
    star:        svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    pin:         svg('<path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
    ticket:      svg('<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>'),
    bulb:        svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.5 1 2.3v1h6v-1c0-.8.3-1.7 1-2.3A7 7 0 0 0 12 2Z"/>'),
    headphones:  svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z"/>'),
    globe:       svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>'),
    users:       svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    clipboard:   svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="14" y2="16"/>'),
    briefcase:   svg('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
    settings:    svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>')
  };

  const sidebarHtml = `<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <img src="/logo.png" class="sidebar-logo" />
    <button id="sidebarToggle" class="sidebar-toggle" aria-label="Toggle sidebar">
  ☰
</button>
  </div>

  <nav class="sidebar-nav">
    <div class="nav-section">
      <a href="/" class="nav-item" data-tooltip="Dashboard">
        <span class="icon">${icons.home}</span>
        <span class="label">Dashboard</span>
      </a>
      ${pv('schedule') ? `<a href="/schedule" class="nav-item" data-tooltip="Full Schedule">
        <span class="icon">${icons.calendar}</span>
        <span class="label">Full Schedule</span>
      </a>` : ''}
      ${pv('worldflight-challenge') ? `<a href="/worldflight-challenge" class="nav-item" data-tooltip="WF Challenge">
        <span class="icon">${icons.star}</span>
        <span class="label">WF Challenge</span>
      </a>` : ''}

      <a href="/airport-portal" class="nav-item" data-tooltip="Airport Portal">
        <span class="icon">${icons.building}</span>
        <span class="label">Airport Portal</span>
      </a>

      ${pv('world-map') ? `<a href="/route-map" class="nav-item" data-tooltip="Route Map">
        <span class="icon">${icons.map}</span>
        <span class="label">Route Map</span>
      </a>` : ''}
      <a href="/previous-destinations" class="nav-item" data-tooltip="Previous Destinations">
        <span class="icon">${icons.pin}</span>
        <span class="label">Past Destinations</span>
      </a>
      ${pv('my-slots') ? `<a href="/my-slots" class="nav-item" data-tooltip="My Slots / Bookings">
        <span class="icon">${icons.ticket}</span>
        <span class="label">My Slots / Bookings</span>
      </a>` : ''}
      ${pv('suggest-airport') ? `<a href="/suggest-airport" class="nav-item" data-tooltip="Suggest Airport">
        <span class="icon">${icons.bulb}</span>
        <span class="label">Suggest Airport</span>
      </a>` : ''}
    </div>

    ${pv('atc') || pv('airspace') || pv('sector-planning') ? `<div class="nav-section">
      <div class="nav-title">Planning</div>
      ${pv('atc') ? `<a href="/atc" class="nav-item" data-tooltip="WF Flow Control">
        <span class="icon">${icons.headphones}</span>
        <span class="label">WF Flow Control</span>
      </a>` : ''}
      ${pv('airspace') ? `<a href="/airspace" class="nav-item" data-tooltip="Staffing Overview">
        <span class="icon">${icons.globe}</span>
        <span class="label">Staffing Overview</span>
      </a>` : ''}
      ${pv('sector-planning') ? `<a href="/sector-planning" class="nav-item" data-tooltip="Sector Planning">
        <span class="icon">${icons.clipboard}</span>
        <span class="label">Sector Planning</span>
      </a>` : ''}
    </div>` : ''}

    ${isWfAtc && pv('vatcan-codes') ? `<div class="nav-section">
      <div class="nav-title">WF ATC</div>
      <a href="/wf-atc/vatcan-codes" class="nav-item" data-tooltip="VATCAN Codes">
        <span class="icon">${icons.headphones}</span>
        <span class="label">VATCAN Codes</span>
      </a>
    </div>` : ''}

    ${isTeamMember ? `
    <div class="nav-section">
      <div class="nav-title">Team Member</div>
      <a href="/team/management" class="nav-item" data-tooltip="Team Management">
        <span class="icon">${icons.users}</span>
        <span class="label">Team Management</span>
      </a>
      <a href="/team/bookings" class="nav-item" data-tooltip="Our Bookings">
        <span class="icon">${icons.clipboard}</span>
        <span class="label">Our Bookings</span>
      </a>
    </div>
    ` : ''}

    ${isAffiliate ? `
    <div class="nav-section">
      <div class="nav-title">WF Affiliate</div>
      <a href="/affiliates/hq" class="nav-item" data-tooltip="Affiliate HQ">
        <span class="icon">${icons.briefcase}</span>
        <span class="label">Affiliate HQ</span>
      </a>
      ${canManageAffiliateMembers ? `<a href="/affiliates/my-members" class="nav-item" data-tooltip="My Members">
        <span class="icon">${icons.users}</span>
        <span class="label">My Members</span>
      </a>` : ''}
    </div>
    ` : ''}

    ${isAdmin ? `
    <div class="nav-section nav-admin">
      <div class="nav-title">Admin</div>
      <a href="/admin/control-panel" class="nav-item" data-tooltip="Admin Panel">
        <span class="icon">${icons.settings}</span>
        <span class="label">
          Admin Panel
          <span id="adminBadge" class="nav-badge hidden"></span>
        </span>
      </a>
    </div>

    ` : ''}
  </nav>
</aside>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('wf-theme') || 'dark');</script>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <link rel="icon" type="image/png" href="/logo.png" />
  <link rel="apple-touch-icon" href="/logo.png" />
  <link rel="stylesheet" href="/styles.css" />

  <!-- Leaflet (global, safe) -->
  <!-- Leaflet (global, safe) -->
<link
  rel="stylesheet"
  href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
/>
<script
  src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  defer
></script>
<script src="/leaflet.polylineDecorator.js" defer></script>
<!-- Leaflet JS -->
<script src="/icao-map.js"></script>
<script src="/wf-world-map.js"></script>
<script src="/socket.io/socket.io.js"></script>
<script src="/slot-banners.js" defer></script>


</head>

<body class="${[hideSidebar ? 'no-sidebar' : '', layoutClass.includes('map-layout') ? 'map-layout-page' : ''].filter(Boolean).join(' ')}">
  ${hideSidebar ? '' : `<script>
    (function(){
      var m = window.innerWidth <= 900;
      var c = m || (localStorage.getItem('sidebarCollapsed') === null ? false : localStorage.getItem('sidebarCollapsed') === 'true');
      if (c) document.body.classList.add('sidebar-collapsed');
      document.documentElement.classList.add('sidebar-ready');
    })();
  </script>`}

  ${hideSidebar ? '' : sidebarHtml}




  <!-- ===== TOPBAR ===== -->
  <header class="topbar">

  ${hideSidebar ? `
  <div class="topbar-mobile-logo">
    <img src="/logo.png" alt="WorldFlight" />
  </div>` : `<button type="button" class="topbar-mobile-logo" id="mobileMenuBtn" aria-label="Menu">
    <img src="/logo.png" alt="WorldFlight" />
    <span class="mobile-menu-icon">☰</span>
  </button>`}

  ${hideSidebar ? `
  <a href="/" class="header-brand">
    <img src="/logo.png" alt="WorldFlight" class="header-brand-logo" />
    <div class="header-brand-text">
      <span class="header-brand-name">WorldFlight</span>
      <span class="header-brand-sub">Planning Portal</span>
    </div>
  </a>
  <div class="header-center header-center-mobile-only">Planning Portal</div>
  ` : `<div class="header-center">${title}</div>`}

  <div class="header-right">

  <div id="utcClock" class="utc-clock">00:00:00 UTC</div>

  ${user ? `
    <div class="user-menu">
      <button id="userMenuToggle" class="user-trigger">
        <span class="hide-mobile">Welcome, </span>${user.personal?.name_full}
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
      <span class="login-full">${process.env.DEV_MODE === 'true' ? 'Login Offline' : 'Login with VATSIM'}</span>
      <span class="login-short">Login</span>
    </a>
  `}
</div>

</header>

  ${siteBanner.enabled && siteBanner.text ? `
  <div class="site-banner">
    <span class="site-banner-text">${siteBanner.text}</span>
  </div>
  ` : ''}

  ${isAdmin ? '<div id="adminAlertBanner" class="admin-alert-banner"></div>' : ''}

  <!-- ===== PAGE CONTENT ===== -->
  <main class="dashboard ${layoutClass}${loginOverlay ? ' has-login-overlay' : ''}">
    ${content}
    ${loginOverlay ? `
    <div class="login-overlay-gate" role="dialog" aria-modal="true" aria-label="Login required">
      <div class="login-overlay-card">
        <div class="login-overlay-icon">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h2 class="login-overlay-title">Login required</h2>
        <p class="login-overlay-desc">Sign in to access this page.</p>
        <a href="/auth/login" class="login-overlay-btn">${process.env.DEV_MODE === 'true' ? 'Login Offline' : 'Login with VATSIM'}</a>
      </div>
    </div>
    ` : ''}
  </main>

  <footer class="admin-connected-footer">
    ${isAdmin ? `
      <span class="admin-footer-label">Connected Users</span>
      <span id="connectedUsersList" class="admin-footer-users">Loading...</span>
    ` : ''}
    <div class="site-policy-links">
      <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme"></button>
      <span class="policy-sep" aria-hidden="true">·</span>
      <a href="/privacy">Privacy Policy</a>
      <span class="policy-sep" aria-hidden="true">·</span>
      <a href="/data-handling">Data Handling</a>
    </div>
  </footer>

     <!-- ===== CID VERIFICATION MODAL ===== -->
  <div id="callsignModal" class="modal hidden" style="z-index:20000;">
    <div class="modal-backdrop"></div>
    <div class="modal-card card">
      <h3 id="modalTitle">Confirm Your CID</h3>
<p id="modalHelp" class="modal-help">
        Please re-enter your VATSIM CID to confirm this booking.
      </p>

      <input
        id="callsignModalInput"
        type="text"
        placeholder="Enter CID"
        maxlength="10"
        autocomplete="off"
      />
      <p class="modal-hint">Your booking will be tied to your CID. You can connect with any callsign.</p>
      <p id="modalError" class="modal-error hidden"></p>

      <div class="modal-actions">
        <button id="callsignCancel" class="action-btn">Cancel</button>
        <button id="callsignConfirm" class="action-btn primary">Confirm</button>
      </div>
    </div>
  </div>
<div id="airportPortalModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-dialog">
    <h3>Open Airport Portal</h3>

    <form id="airportPortalForm">
      <input
        type="text"
        id="airportPortalIcao"
        placeholder="Enter ICAO (e.g. EGCC)"
        maxlength="4"
        required
        autocomplete="off"
      />

      <div class="modal-actions">
        <button type="button" id="closeAirportPortal" class="modal-btn">
          Cancel
        </button>
        <button type="submit" class="modal-btn modal-btn-submit">
          Open
        </button>
      </div>
    </form>
  </div>
</div>
<!-- ===== UPLOAD DOCUMENTATION MODAL ===== -->
<div id="uploadDocModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-card card">
    <h3>Upload Airport Document</h3>

    <form id="uploadDocForm">
      <input type="hidden" id="uploadDocIcao" name="icao">

      <label>
    File name
    <input type="text" placeholder="Pilot Brief 2026" name="filename" required>
  </label>

  <label>
    Document validity
    <select name="eventId" id="uploadDocEventId">
      <option value="">Permanent (always visible)</option>
      ${activeEvent && activeEvent.id ? `<option value="${activeEvent.id}">${activeEvent.name || 'Active event'} only</option>` : ''}
    </select>
  </label>

  <label>
    File
    <input type="file" name="file" required>
  </label>

      <div class="modal-actions">
        <button
          type="button"
          id="uploadDocCancel"
          class="action-btn"
        >
          Cancel
        </button>

        <button
          type="submit"
          class="action-btn primary"
        >
          Upload
        </button>
      </div>
    </form>
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
          const value = input.value.trim();
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

      // Hide input and hint for confirmations
      input.style.display = 'none';
      const hint = card.querySelector('.modal-hint');
      if (hint) hint.style.display = 'none';
      const error = card.querySelector('.modal-error');
      if (error) error.classList.add('hidden');

      modal.classList.remove('hidden');
      cancel.focus();

      function close(result) {
        modal.classList.add('hidden');
        input.style.display = '';
        if (hint) hint.style.display = '';
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
<script>
function openConfirmModalAsync({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm }) {
  const modal = document.getElementById('callsignModal');
  const card = modal.querySelector('.modal-card');

  const h3 = card.querySelector('h3');
  const help = card.querySelector('.modal-help');
  const input = document.getElementById('callsignModalInput');
  const confirm = document.getElementById('callsignConfirm');
  const cancel = document.getElementById('callsignCancel');

  if (h3) h3.textContent = title || 'Confirm';
  if (help) help.textContent = message || '';

  // hide input and hint for confirmations
  if (input) input.style.display = 'none';
  const hint = card.querySelector('.modal-hint');
  if (hint) hint.style.display = 'none';
  const error = card.querySelector('.modal-error');
  if (error) error.classList.add('hidden');

  // reset buttons
  confirm.textContent = confirmText;
  cancel.textContent = cancelText;
  cancel.style.display = '';

  modal.classList.remove('hidden');

  function cleanup() {
    confirm.removeEventListener('click', onConfirmClick);
    cancel.removeEventListener('click', onCancelClick);
    document.removeEventListener('keydown', onKey);
    if (input) input.style.display = ''; // restore for callsign usage
  }

  function closeModal() {
    modal.classList.add('hidden');
    cleanup();
  }

  function showState(newTitle, newMessage, okText) {
    if (h3) h3.textContent = newTitle;
    if (help) help.textContent = newMessage;
    confirm.textContent = okText || 'OK';
    cancel.style.display = 'none';
  }

  async function onConfirmClick() {
    // prevent double-submit
    confirm.disabled = true;
    cancel.disabled = true;

    // optional: show sending state
    showState(title || 'Confirm', 'Submitting request...', 'Submitting...');

    try {
      const result = await onConfirm({
        set: (t, m) => showState(t, m, 'OK'),
        close: closeModal,
        showOk: (t, m) => {
          showState(t, m, 'OK');
          confirm.disabled = false;
          confirm.onclick = closeModal; // OK closes modal
        }
      });

      // If handler returns true/false and didn't explicitly showOk/close, default to OK-close
      if (result === true) {
        confirm.disabled = false;
        confirm.onclick = closeModal;
      } else if (result === false) {
        // allow retry
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.textContent = confirmText;
        cancel.style.display = '';
      }
    } catch (err) {
      // show error and allow retry
      if (h3) h3.textContent = 'Request failed';
      if (help) help.textContent = 'Unable to submit access request. Please try again.';
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = 'Retry';
      cancel.style.display = '';
    }
  }

  function onCancelClick() {
    closeModal();
  }

  function onKey(e) {
    if (e.key === 'Escape') onCancelClick();
  }

  confirm.onclick = null; // remove any prior inline onclick
  confirm.addEventListener('click', onConfirmClick);
  cancel.addEventListener('click', onCancelClick);
  document.addEventListener('keydown', onKey);
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

  // Create mobile backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  document.body.appendChild(backdrop);

  function isMobile() {
    return window.innerWidth <= 900;
  }

  if (sidebar && toggle) {
    function setCollapsed(collapsed) {
      sidebar.classList.toggle('collapsed', collapsed);
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      localStorage.setItem('sidebarCollapsed', collapsed);

      // Mobile: toggle slide-in class, backdrop, and body scroll lock
      if (isMobile()) {
        sidebar.classList.toggle('mobile-open', !collapsed);
        backdrop.classList.toggle('visible', !collapsed);
        document.body.classList.toggle('sidebar-open', !collapsed);
      } else {
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('visible');
        document.body.classList.remove('sidebar-open');
      }

      window.dispatchEvent(new Event('sidebar:toggle'));
    }

    // Wide screens: restore saved state, mobile: always start collapsed
    if (isMobile()) {
      setCollapsed(true);
    } else {
      const saved = localStorage.getItem('sidebarCollapsed');
      if (saved !== null) {
        setCollapsed(saved === 'true');
      } else {
        setCollapsed(false);
      }
    }

    // Re-enable transitions now that sidebar state is set
    requestAnimationFrame(() => {
      document.documentElement.classList.add('sidebar-ready');
    });

    toggle.addEventListener('click', () => {
      setCollapsed(!sidebar.classList.contains('collapsed'));
    });

    backdrop.addEventListener('click', () => {
      setCollapsed(true);
    });

    // Mobile logo = menu toggle
    const mobileBtn = document.getElementById('mobileMenuBtn');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => {
        setCollapsed(!sidebar.classList.contains('collapsed'));
      });
    }

    window.addEventListener('resize', () => {
      if (isMobile()) {
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('visible');
        setCollapsed(true);
      }
    });
  }

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

  // ===== SIDEBAR TOOLTIPS =====
  const tip = document.createElement('div');
  tip.className = 'sidebar-tooltip';
  document.body.appendChild(tip);

  document.querySelectorAll('.nav-item[data-tooltip]').forEach(item => {
    item.addEventListener('mouseenter', () => {
      if (!sidebar || !sidebar.classList.contains('collapsed')) return;
      const rect = item.getBoundingClientRect();
      tip.textContent = item.dataset.tooltip;
      tip.style.left = (rect.right + 12) + 'px';
      tip.style.top = (rect.top + rect.height / 2) + 'px';
      tip.style.transform = 'translateY(-50%)';
      tip.classList.add('visible');
    });
    item.addEventListener('mouseleave', () => {
      tip.classList.remove('visible');
    });
  });

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
<script>
document.getElementById('refreshSceneryLinksBtn')?.addEventListener('click', async () => {
  const ok = confirm('Regenerate scenery links file from the current WF schedule?');
  if (!ok) return;

  const res = await fetch('/admin/scenery/refresh-links', { method: 'POST' });
  const data = await res.json();

  if (!res.ok || !data.success) {
    alert('Failed to refresh scenery links');
    return;
  }

  alert('Scenery links refreshed for ' + data.count + ' WF airports');
});
</script>

<script>
document.addEventListener('DOMContentLoaded', function () {
  const openBtn  = document.getElementById('openAirportPortal');
  const modal    = document.getElementById('airportPortalModal');
  const closeBtn = document.getElementById('closeAirportPortal');
  const form     = document.getElementById('airportPortalForm');
  const input    = document.getElementById('airportPortalIcao');

  if (!openBtn || !modal || !form || !input) return;

  function openModal() {
    modal.classList.remove('hidden');
    input.value = '';
    input.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  openBtn.addEventListener('click', function (e) {
    e.preventDefault();
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);

  var backdrop = modal.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeModal);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var raw = input.value.trim().toUpperCase();
var icao = null;

// 3-letter US shorthand → assume K prefix
if (/^[A-Z]{3}$/.test(raw)) {
  icao = 'K' + raw;
}
// Full ICAO
else if (/^[A-Z]{4}$/.test(raw)) {
  icao = raw;
}
else {
  alert('Please enter a valid ICAO (e.g. LAX or KLAX)');
  return;
}

window.location.href = '/icao/' + icao;

  });
});
</script>





<div id="flightPlanModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-card">
<div class="fp-strip">

  <!-- HEADER -->
  <div class="fp-strip-header">
  <div class="fp-callsign-group">
    <span class="fp-callsign" id="fpCallsign"></span>
    <span
  id="fpRouteWarning"
  class="fp-route-warning hidden"
  title="Filed route does not match WorldFlight ATC route"
  aria-label="Route mismatch warning"
>
  <svg
    class="fp-warning-icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    role="img"
    aria-hidden="true"
  >
    <path
      d="M12 2L1 22h22L12 2z"
      fill="currentColor"
    />
    <rect x="11" y="8" width="2" height="7" fill="#0b1220" />
    <rect x="11" y="17" width="2" height="2" fill="#0b1220" />
  </svg>
</span>

  </div>

  <span class="fp-aircraft" id="fpAircraft"></span>
  <span class="fp-status" id="fpStatus"></span>
</div>



  <!-- NAVIGATION / FILING -->
  <div class="fp-strip-row">
    <span class="fp-label">DEP</span>
    <span class="fp-value" id="fpDep"></span>

    <span class="fp-label">DEST</span>
    <span class="fp-value" id="fpDest"></span>
  </div>

  <div class="fp-strip-row">
  <span class="fp-label">RULES</span>
  <span class="fp-value" id="fpRules"></span>

  <span class="fp-label">REG</span>
  <span class="fp-value" id="fpReg"></span>
</div>

<div class="fp-strip-row">
  <span class="fp-label">A/C TYPE</span>
  <span class="fp-value" id="fpType"></span>
</div>


  <!-- PERFORMANCE -->
  <div class="fp-strip-row">
    <span class="fp-label">WAKE</span>
    <span class="fp-value" id="fpWake"></span>

    <span class="fp-label">CRZ LVL</span>
    <span class="fp-value" id="fpCruise"></span>
  </div>

  <div class="fp-strip-row">
    <span class="fp-label">TAS</span>
    <span class="fp-value" id="fpTasGs"></span>
  </div>

  <!-- PILOT -->
  <div class="fp-strip-row">
    <span class="fp-label">PILOT</span>
    <span class="fp-value" id="fpPilot"></span>
  </div>

  <div class="fp-strip-row">
    <span class="fp-label">CID</span>
    <span class="fp-value" id="fpCid"></span>
  </div>

  <!-- TIME -->
  <div class="fp-strip-row">
    <span class="fp-label">TCT</span>
    <span class="fp-value" id="fpTobt"></span>

    <span class="fp-label">TSAT</span>
    <span class="fp-value" id="fpTsat"></span>
  </div>

  <!-- ROUTE (NORMAL) -->
  <div id="fpRouteNormalBlock" class="fp-route-block">
    <div class="fp-route-label">ATC ROUTE</div>
    <pre class="fp-route" id="fpRoute"></pre>
  </div>

  <!-- ROUTE MISMATCH (clickable) -->
  <div id="fpRouteFiledBlock" class="fp-route-block hidden">
    <button id="fpRouteWarningBtn" class="fp-route-alert" style="width:100%;cursor:pointer;border:none;">
      <span class="fp-route-alert-icon">⚠</span>
      <span class="fp-route-alert-text">WF ROUTE VALIDATION FAILED — Click for details</span>
    </button>
  </div>

  <!-- ACTIONS -->
  <div class="fp-actions">
    <button id="closeFpModal" class="fp-close">CLOSE</button>
  </div>

</div>

  </div>
</div>
<script>
async function openFlightPlanModal(callsign) {
  const res = await fetch('/api/atc/flight/' + callsign);
  if (!res.ok) {
    const modal = document.getElementById('flightPlanModal');
    const strip = modal.querySelector('.fp-strip');
    const origHtml = strip.innerHTML;
    strip.innerHTML = '<div style="text-align:center;padding:48px 24px;">'
      + '<div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;">' + callsign + '</div>'
      + '<p style="color:var(--muted);font-size:14px;margin:12px 0 24px;">No data received from VATSIM</p>'
      + '<button id="fpNoDataClose" style="padding:8px 24px;background:var(--accent);color:#020617;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;">Close</button>'
      + '</div>';
    modal.classList.remove('hidden');
    document.getElementById('fpNoDataClose').addEventListener('click', function() {
      modal.classList.add('hidden');
      strip.innerHTML = origHtml;
    });
    modal.querySelector('.modal-backdrop').addEventListener('click', function() {
      modal.classList.add('hidden');
      strip.innerHTML = origHtml;
    }, { once: true });
    return;
  }

  const d = await res.json();

  document.getElementById('fpCallsign').textContent = d.callsign;
  const statusEl = document.getElementById('fpStatus');
statusEl.textContent = d.wfStatus;
statusEl.className = 'fp-status'; // reset
if (d.wfStatus === 'WF – BOOKED') {
  statusEl.classList.add('fp-status-booked');
}

  document.getElementById('fpAircraft').textContent = d.aircraft || '—';

  const tas = Number(d.filedTas);
  document.getElementById('fpTasGs').textContent =
    Number.isFinite(tas) && tas > 0 ? tas + ' / —' : '—';

  document.getElementById('fpDep').textContent = d.dep;
  document.getElementById('fpDest').textContent = d.dest;
  document.getElementById('fpCruise').textContent = d.cruiseLevel;

  document.getElementById('fpPilot').textContent = d.pilotName;
  document.getElementById('fpCid').textContent = d.pilotCid;

  document.getElementById('fpTobt').textContent = d.tobt;
  document.getElementById('fpTsat').textContent = d.tsat;

  const rulesMap = {
  I: 'IFR',
  V: 'VFR',
  S: 'SVFR'
};

const ruleCode = (d.flightRules || '').toUpperCase();

document.getElementById('fpRules').textContent =
  rulesMap[ruleCode] || ruleCode || '—';

  document.getElementById('fpReg').textContent = d.registration || '—';
  document.getElementById('fpType').textContent = d.aircraftType || '—';
  document.getElementById('fpWake').textContent = d.wake || '—';

  const normalBlock = document.getElementById('fpRouteNormalBlock');
  const filedBlock = document.getElementById('fpRouteFiledBlock');
  const warningIcon = document.getElementById('fpRouteWarning');

  if (d.wfStatus === 'WF – ROUTE') {
    normalBlock.classList.add('hidden');
    filedBlock.classList.remove('hidden');
    warningIcon.classList.remove('hidden');

    // Wire up the warning button to open the route mismatch modal
    var warnBtn = document.getElementById('fpRouteWarningBtn');
    if (warnBtn) {
      warnBtn.onclick = function() {
        // Close the FP modal first
        document.getElementById('flightPlanModal').classList.add('hidden');
        // Find the matching warning icon in the departures table and click it
        var icon = document.querySelector('.route-warning-icon[data-callsign="' + d.callsign + '"]');
        if (icon) icon.click();
      };
    }

  } else {
    filedBlock.classList.add('hidden');
    normalBlock.classList.remove('hidden');
    warningIcon.classList.add('hidden');

    document.getElementById('fpRoute').textContent = d.route;
  }

  // ✅ THIS MUST BE INSIDE THE FUNCTION
  document
    .getElementById('flightPlanModal')
    .classList.remove('hidden');
}
</script>

<script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#closeFpModal');
  if (!btn) return;

  const modal = document.getElementById('flightPlanModal');
  if (modal) {
    modal.classList.add('hidden');
  }
});
</script>
<script>
(async function updateAdminBadge() {
  try {
    const badge = document.getElementById('adminBadge');
    const alertBanner = document.getElementById('adminAlertBanner');
    if (!badge && !alertBanner) return;

    // Quick check: if no badge, test if user is admin before fetching
    if (!badge) {
      const probe = await fetch('/admin/api/staff-access-requests/pending-count', { credentials: 'same-origin' }).catch(() => null);
      if (!probe || !probe.ok) return; // not admin
      const { count } = await probe.json();
      if (count > 0 && alertBanner) {
        alertBanner.innerHTML = '<a href="/admin/access-management" class="admin-alert-link">\uD83D\uDD11 ' + count + ' pending staff access request' + (count > 1 ? 's' : '') + ' \u2014 View Access Management \u2192</a>';
      }
      return;
    }

    let total = 0;

    const [sceneryRes, docRes, airacRes, staffRes] = await Promise.all([
      fetch('/api/admin/scenery/pending-count').catch(() => null),
      fetch('/admin/api/documentation-access-requests/pending-count').catch(() => null),
      fetch('/api/admin/airac/status').catch(() => null),
      fetch('/admin/api/staff-access-requests/pending-count').catch(() => null)
    ]);

    if (sceneryRes && sceneryRes.ok) {
      const { count } = await sceneryRes.json();
      total += count;
    }
    if (docRes && docRes.ok) {
      const { count } = await docRes.json();
      total += count;
    }
    if (airacRes && airacRes.ok) {
      const data = await airacRes.json();
      if (data.alert) total += 1;
    }
    let staffCount = 0;
    if (staffRes && staffRes.ok) {
      const { count } = await staffRes.json();
      staffCount = count;
      total += count;
    }

    if (total > 0) {
      badge.textContent = total;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Show admin alert banner for pending notifications
    if (alertBanner) {
      const alerts = [];
      if (staffCount > 0) alerts.push('🔑 ' + staffCount + ' pending staff access request' + (staffCount > 1 ? 's' : ''));
      if (alerts.length) {
        alertBanner.innerHTML = '<a href="/admin/access-management" class="admin-alert-link">' + alerts.join(' &nbsp;&bull;&nbsp; ') + ' — View Access Management →</a>';
      }
    }
  } catch (err) {
    console.error('Failed to load admin badge', err);
  }
})();

</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.book-slot-btn');
  if (!btn) return;

  const isArrival = btn.classList.contains('arrival');
  const isDeparture = btn.classList.contains('departure');

  const callsign = await openCallsignModal();
  if (!callsign) return;

  if (isArrival) {
    bookArrivalSlot(callsign);
  } else if (isDeparture) {
    bookDepartureSlot(callsign);
  }
});
</script>


<style>
  .admin-connected-footer {
    position: fixed;
    bottom: 0;
    left: var(--sidebar-expanded);
    right: 0;
    height: 32px;
    padding: 0 24px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 12px;
    z-index: 50;
    transition: left .25s ease;
  }
  body.sidebar-collapsed .admin-connected-footer {
    left: var(--sidebar-collapsed);
  }
  .admin-connected-footer * {
    font-size: 12px;
    line-height: 1;
  }
  .admin-footer-label {
    color: var(--muted);
    font-weight: 600;
    margin: 0; padding: 0;
  }
  .admin-footer-users { color: var(--text); margin: 0; padding: 0; }
  .cu-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--success);
    vertical-align: middle;
    margin-right: 4px;
  }
  .cu-entry { margin-left: 12px; }

  .site-policy-links {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .site-policy-links a {
    color: var(--muted);
    text-decoration: none;
    transition: color .15s;
  }
  .site-policy-links a:hover { color: var(--accent); text-decoration: underline; }
  .site-policy-links .policy-sep { opacity: 0.6; }

  @media (max-width: 900px) {
    .admin-connected-footer {
      left: 0 !important;
      right: 0;
      padding: 6px 12px calc(6px + env(safe-area-inset-bottom, 0px));
      height: auto;
      min-height: 32px;
      flex-wrap: wrap;
      row-gap: 4px;
      column-gap: 10px;
    }
    body.sidebar-collapsed .admin-connected-footer { left: 0 !important; }
    .site-policy-links { margin-left: auto; }
    /* Reserve space under content on mobile so the fixed footer doesn't
       cover cards. Must live on main.dashboard, not body — body has
       height:100dvh + box-sizing:border-box, so padding-bottom on body
       stays inside the fixed viewport-sized box and creates no extra
       scroll room. main grows with its content, so padding on main
       actually extends the scrollable area. */
    main.dashboard { padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px)) !important; }
  }
</style>
${isAdmin ? `
<style>/* admin connected-users socket block wrapper */</style>
<script>
(function() {
  var container = document.getElementById('connectedUsersList');
  if (!container) return;

  var sock = typeof io !== 'undefined' ? io({ query: { icao: '' } }) : null;
  if (!sock) return;

  sock.emit('registerUser', {
    cid: '${user?.cid || ''}',
    name: '${user?.personal?.name_full || 'Unknown'}'
  });

  sock.on('connectedUsersUpdate', function(data) {
    var users = data.users || [];
    var guests = data.guests || 0;
    var parts = [];
    if (users.length) {
      parts.push(users.map(function(u) {
        return '<span class="cu-entry"><span class="cu-dot"></span>' + u.cid + ' — ' + (u.name || 'Unknown') + '</span>';
      }).join(''));
    }
    if (guests > 0) {
      parts.push('<span class="cu-entry" style="color:var(--muted);"><span class="cu-dot" style="background:var(--muted);"></span>' + guests + ' guest' + (guests !== 1 ? 's' : '') + '</span>');
    }
    container.innerHTML = parts.length ? parts.join('') : '<span class="label" style="color:var(--muted);font-size:11px;">No users online</span>';
  });
})();
</script>
` : ''}

<script>
(function() {
  const saved = localStorage.getItem('wf-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);

  // Global tile URL helper for Leaflet maps
  window.wfTileUrl = function() {
    var t = document.documentElement.getAttribute('data-theme') || 'dark';
    return t === 'light'
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  };

  // Track all tile layers so we can swap them on theme change
  window._wfTileLayers = [];
  window.wfAddTileLayer = function(map, opts) {
    var layer = L.tileLayer(window.wfTileUrl(), Object.assign({ subdomains: 'abcd' }, opts || {}));
    layer.addTo(map);
    window._wfTileLayers.push({ map: map, layer: layer, opts: opts || {} });
    return layer;
  };

  function updateLabel() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    btn.textContent = current === 'dark' ? 'Light Mode' : 'Dark Mode';
  }
  updateLabel();

  function swapTiles() {
    var url = window.wfTileUrl();
    (window._wfTileLayers || []).forEach(function(entry) {
      entry.map.removeLayer(entry.layer);
      entry.layer = L.tileLayer(url, Object.assign({ subdomains: 'abcd' }, entry.opts));
      entry.layer.addTo(entry.map);
    });
  }

  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', function() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.dataset.mapTheme = next;
    localStorage.setItem('wf-theme', next);
    updateLabel();
    swapTiles();
  });
})();
</script>

</body>
</html>`;
}