import axios from 'axios';
import querystring from 'querystring';

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

  const baseAuthUrl = 'https://auth-dev.vatsim.net';

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

    return res.redirect('/dashboard');

  } catch (err) {
    console.error('VATSIM CALLBACK FAILURE:');
    console.error('Status:', err.response?.status);
    console.error('Data:', err.response?.data);
    console.error('Message:', err.message);

    return res.status(500).send('Authentication failed');
  }
}
