// GET /api/slack-debug - temporary debug endpoint to see what the bot can access
'use strict';

const SLACK = 'https://slack.com/api';

async function slack(method, params = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  const qs = new URLSearchParams(params).toString();
  const url = `${SLACK}/${method}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  return { http_status: r.status, ...data };
}

module.exports = async (req, res) => {
  try {
    const auth = await slack('auth.test');
    const convos = await slack('conversations.list', {
      types: 'im,mpim,public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    const summary = (convos.channels || []).map(c => ({
      id: c.id,
      name: c.name || null,
      is_im: !!c.is_im,
      is_mpim: !!c.is_mpim,
      is_channel: !!c.is_channel,
      is_private: !!c.is_private,
      is_member: !!c.is_member,
    }));
    res.status(200).json({
      auth: { ok: auth.ok, user_id: auth.user_id, bot_id: auth.bot_id, team: auth.team, error: auth.error },
      convos_ok: convos.ok,
      convos_error: convos.error,
      convos_count: (convos.channels || []).length,
      convos: summary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
