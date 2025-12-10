import crypto from 'crypto';
import querystring from 'querystring';

export default function vatsimLogin(req, res) {
  const isSandbox = process.env.VATSIM_ENV === 'sandbox';

  const baseAuthUrl = isSandbox
    ? 'https://auth-dev.vatsim.net'
    : 'https://auth.vatsim.net';

  // Generate PKCE values
  const codeVerifier = crypto.randomBytes(32).toString('hex');

  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Store verifier in session
  req.session.pkce = codeVerifier;

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
}
