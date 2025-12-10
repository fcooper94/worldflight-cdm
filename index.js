import 'dotenv/config';
import express from 'express';
import session from 'express-session';

import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import dashboard from './dashboard.js';

const app = express();
const port = process.env.PORT || 3000;

// Session middleware (MUST be before routes)
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

// Static assets
app.use(express.static('public'));

// Routes
app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/dashboard', dashboard);

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Start server
app.listen(port, () => {
  console.log(`WorldFlight CDM running on http://localhost:${port}`);
});
