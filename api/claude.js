// Claude proxy. Accepts either x-admin-token (preferred, from dce-auth.js)
// or legacy x-dashboard-auth === DASHBOARD_PASSWORD.

const { verifyAdminToken } = require('./_admin-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  const adminTok = req.headers['x-admin-token'];
  const dashAuth = req.headers['x-dashboard-auth'];

  let authed = false;
  if (adminTok && ADMIN_TOKEN_SECRET && verifyAdminToken(adminTok, ADMIN_TOKEN_SECRET)) {
    authed = true;
  } else if (dashAuth && process.env.DASHBOARD_PASSWORD && dashAuth === process.env.DASHBOARD_PASSWORD) {
    authed = true;
  }
  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', response.status, JSON.stringify(data));
    }

    return res.status(response.ok ? 200 : response.status).json(data);

  } catch (error) {
    console.error('Proxy error:', error.message);
    return res.status(500).json({ error: 'Proxy error', detail: error.message });
  }
};
