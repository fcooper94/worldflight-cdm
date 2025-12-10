import axios from 'axios';
import querystring from 'querystring';

export default async function vatsimCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(401).send('Authentication failed');
  }

  if (!code || !req.session.pkce) {
    return res.status(400).send('Missing PKCE or authorization code');
  }

  const isSandbox = process.env.VATSIM_ENV === 'sandbox';

  const baseAuthUrl = isSandbox
    ? 'https://auth-dev.vatsim.net'
    : 'https://auth.vatsim.net';

  try {
    const tokenPayload = {
      grant_type: 'authorization_code',
      client_id: process.env.VATSIM_CLIENT_ID,
      redirect_uri: process.env.VATSIM_REDIRECT_URI,
      code,
      code_verifier: req.session.pkce
    };

    if (!isSandbox) {
      tokenPayload.client_secret = process.env.VATSIM_CLIENT_SECRET;
    }

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

    // Clean up PKCE
    delete req.session.pkce;

    req.session.user = userResponse.data;
    res.redirect('/dashboard');

  } catch (err) {
    console.error('VATSIM SSO error:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
}
