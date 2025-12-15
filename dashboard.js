import renderLayout from './layout.js';

export default (req, res) => {
  /* ===============================
     AUTH GUARD
  =============================== */
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  /* ===============================
     USER CONTEXT
  =============================== */
  const user = req.session.user.data;
  const isAdmin = [10000010, 1303570, 10000005].includes(Number(user.cid));
  const isATC = !!user.callsign;

  /* ===============================
     DASHBOARD CONTENT
  =============================== */
  const content = `
  <section class="card">
    <h2>Session Info</h2>

    <div class="stat">
      <span>VATSIM ID</span>
      <strong>${user.cid}</strong>
    </div>

    <div class="stat">
      <span>Controller Callsign</span>
      <strong>${user.callsign || 'Not Connected'}</strong>
    </div>
  </section>

  <section class="card">
    <h2>Status</h2>
    <div class="status ${isATC ? 'online' : 'offline'}">
      ${isATC ? 'ATC Online' : 'Offline'}
    </div>
  </section>


  <a href="/logout" class="logout-link">Logout</a>
</div>

`;


  /* ===============================
     RENDER WITH SHARED LAYOUT
  =============================== */
  res.send(
    renderLayout({
      title: 'WorldFlight CDM',
      user,
      isAdmin,
      content
    })
  );
};
