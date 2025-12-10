import 'dotenv/config';
import express from 'express';
import session from 'express-session';

import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import dashboard from './dashboard.js';

const app = express();
const port = process.env.PORT || 3000;

// Session middleware
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

app.use(express.static('public'));

app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/dashboard', dashboard);

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(port, () => {
  console.log(`WorldFlight CDM running on http://localhost:${port}`);
  console.log('ENV check:', {
    VATSIM_CLIENT_ID: process.env.VATSIM_CLIENT_ID,
    VATSIM_REDIRECT_URI: process.env.VATSIM_REDIRECT_URI
  });
});
