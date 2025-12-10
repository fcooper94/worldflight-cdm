export default (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  const user = req.session.user;

  res.send(`
    <h1>Dashboard</h1>
    <p>Welcome, ${user.full_name}</p>
    <p>VATSIM CID: ${user.vatsim_details?.id}</p>
    <a href="/logout">Logout</a>
  `);
};
