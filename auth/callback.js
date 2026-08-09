import axios from 'axios';
import querystring from 'querystring';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function vatsimCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(401).send('Authentication cancelled or denied');
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  if (!req.session.pkce) {
    console.error('Missing PKCE verifier in session');
    return res.status(400).send('Missing PKCE verifier');
  }

  const baseAuthUrl = process.env.VATSIM_AUTH_BASE_URL || 'https://auth.vatsim.net';

  try {
    const tokenPayload = {
      grant_type: 'authorization_code',
      client_id: process.env.VATSIM_CLIENT_ID,
      client_secret: process.env.VATSIM_CLIENT_SECRET,  // IMPORTANT
      redirect_uri: process.env.VATSIM_REDIRECT_URI,
      code,
      code_verifier: req.session.pkce
    };

    console.log('Token payload being sent to VATSIM:', tokenPayload);

    const tokenResponse = await axios.post(
      `${baseAuthUrl}/oauth/token`,
      querystring.stringify(tokenPayload),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const userResponse = await axios.get(
      `${baseAuthUrl}/api/user`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    delete req.session.pkce;

    req.session.user = userResponse.data;

    // Persist the logged-in user's name so other pages (e.g. Team Bookings
    // pilot dropdown) can resolve CID → Name without an authenticated VATSIM
    // lookup, which is only available via the user's own OAuth session.
    //
    // The email is stored for the same reason: VATSIM only hands it over
    // during this user's own login, so without capturing it here we have no
    // way to contact a team/affiliate member later (e.g. a Discord invite).
    // Kept nullable — a user who declines the email scope still logs in fine.
    try {
      const u = userResponse.data?.data || {};
      const cidNum = Number(u.cid);
      const name = (u.personal?.name_full || [u.personal?.name_first, u.personal?.name_last].filter(Boolean).join(' ')).trim();
      const rawEmail = String(u.personal?.email || '').trim().toLowerCase();
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail.slice(0, 200) : null;
      if (cidNum && name) {
        await prisma.user.upsert({
          where: { cid: cidNum },
          // Never overwrite a stored address with null - if VATSIM omits the
          // email on one login, the one we already have stays put.
          update: email ? { name, email } : { name },
          create: email ? { cid: cidNum, name, email } : { cid: cidNum, name }
        });
      }
    } catch (e) {
      console.warn('[AUTH] User upsert failed:', e?.message || e);
    }

    const redirectTo = req.session.returnTo || '/';
delete req.session.returnTo;

return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Logging In...</title>
  <link rel="stylesheet" href="/styles.css" />
  <style>
    .login-overlay-screen {
      position: fixed;
      inset: 0;
      background: var(--bg, #0b1220);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .login-overlay-screen img {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      margin-bottom: 20px;
    }
    .login-overlay-screen h2 {
      color: var(--text, #e2e8f0);
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    .login-overlay-screen p {
      color: var(--muted, #94a3b8);
      font-size: 14px;
    }
    .login-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: var(--accent, #3b82f6);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-top: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="login-overlay-screen">
    <img src="/logo.png" alt="WorldFlight" />
    <h2>Logging In...</h2>
    <p>Welcome back, ${req.session.user?.data?.personal?.name_full || 'pilot'}.</p>
    <div class="login-spinner"></div>
  </div>
  <script>setTimeout(function(){ window.location.href = ${JSON.stringify(redirectTo)}; }, 800);</script>
</body>
</html>`);


  } catch (err) {
    console.error('VATSIM CALLBACK FAILURE:');
    console.error('Status:', err.response?.status);
    console.error('Data:', err.response?.data);
    console.error('Message:', err.message);

    return res.status(500).send('Authentication failed');
  }
}
