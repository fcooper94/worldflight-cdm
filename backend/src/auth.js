import express from 'express';
import jwt from 'jsonwebtoken';
const router = express.Router();
// Simple mock login for demo
router.get('/vatsim/mock', (req, res) => {
const demoUser = { id: 1, vatsim_id: 9999, callsign: 'WF101', name: 'Demo
Pilot' };
const token = jwt.sign(demoUser, process.env.JWT_SECRET || 'secret');
res.cookie('wf_token', token, { httpOnly: true });
res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
});
// skeleton for real VATSIM Connect
router.get('/vatsim', (req, res) => {
if (process.env.USE_VATSIM_MOCK === 'true') return res.redirect('/auth/
vatsim/mock');
const state = 'replace-with-csrf-state';
const clientId = process.env.VATSIM_CLIENT_ID;
const redirectUri = process.env.VATSIM_REDIRECT_URI;
const scope = 'read:members read:flightplans';
const url = `https://auth.vatsim.net/oauth/authorize?
response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=$
{encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=$
{encodeURIComponent(state)}`;
res.redirect(url);
});
// callback (note: real app must exchange code for token and fetch profile)
router.get('/vatsim/callback', async (req, res) => {
if (process.env.USE_VATSIM_MOCK === 'true') return res.redirect('/auth/
vatsim/mock');
const { code } = req.query;
// exchange code at token endpoint - skeleton only
// POST to https://auth.vatsim.net/api/token with client_id, client_secret,
grant_type=authorization_code, code, redirect_uri
// then fetch member profile and create user session
res.send('VATSIM callback received (implement token exchange)');
});
export { router as authRouter };
