import crypto from 'crypto';
import querystring from 'querystring';

export default function vatsimLogin(req, res) {
  const baseAuthUrl = 'https://auth-dev.vatsim.net';

  // Generate PKCE verifier
  const codeVerifier = crypto.randomBytes(32).toString('hex');

  // Generate PKCE challenge
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Store verifier in session
  req.session.pkce = codeVerifier;

  // FORCE session to be saved BEFORE redirect
  req.session.save(() => {
    const params = querystring.stringify({
      client_id: process.env.VATSIM_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.VATSIM_REDIRECT_URI,
      scope: 'full_name email vatsim_details',
      state: 'worldflight',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    res.redirect(`${baseAuthUrl}/oauth/authorize?${params}`);
  });
}
