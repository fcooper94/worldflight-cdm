import 'dotenv/config';
import express from 'express';
import session from 'express-session';

import authLogin from './auth/login.js';
import authCallback from './auth/callback.js';
import dashboard from './dashboard.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(session({
  name: 'worldflight.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true
  }
}));

// Serve static files
app.use(express.static('public'));

// Routes
app.get('/auth/login', authLogin);
app.get('/auth/callback', authCallback);
app.get('/dashboard', dashboard);

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(port, () => {
  console.log(`WorldFlight CDM running on port ${port}`);
});
