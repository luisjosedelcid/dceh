// GET /api/calendar-debug - shows what env vars are present + tries the refresh
'use strict';

module.exports = async (req, res) => {
  const cid = process.env.GOOGLE_CLIENT_ID || '';
  const csec = process.env.GOOGLE_CLIENT_SECRET || '';
  const rtok = process.env.GOOGLE_REFRESH_TOKEN || '';

  const out = {
    env: {
      GOOGLE_CLIENT_ID_present: !!cid,
      GOOGLE_CLIENT_ID_len: cid.length,
      GOOGLE_CLIENT_ID_endsWith: cid.slice(-30),
      GOOGLE_CLIENT_SECRET_present: !!csec,
      GOOGLE_CLIENT_SECRET_len: csec.length,
      GOOGLE_CLIENT_SECRET_startsWith: csec.slice(0, 7),
      GOOGLE_REFRESH_TOKEN_present: !!rtok,
      GOOGLE_REFRESH_TOKEN_len: rtok.length,
      GOOGLE_REFRESH_TOKEN_startsWith: rtok.slice(0, 6),
    },
  };

  try {
    const params = new URLSearchParams({
      client_id: cid,
      client_secret: csec,
      refresh_token: rtok,
      grant_type: 'refresh_token',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    out.refresh_response = {
      http_status: r.status,
      ok: r.ok,
      error: data.error,
      error_description: data.error_description,
      has_access_token: !!data.access_token,
      scope: data.scope,
    };
  } catch (e) {
    out.refresh_error = e.message;
  }

  res.status(200).json(out);
};
