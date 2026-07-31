// GET /api/slack-inbox
//   Reads recent Slack DMs, group DMs, and mentions in channels where the
//   DCE Cockpit bot has been invited. Returns the same shape the static
//   /data/slack_highlights.json used, so the cockpit renderer keeps working.
//
// Auth: open read (matches other read endpoints on the cockpit).
// Env:  SLACK_BOT_TOKEN  (Bot User OAuth Token, xoxb-...)
//
// Caching: 60s in-memory (per lambda instance) to avoid hammering Slack.

'use strict';

const SLACK = 'https://slack.com/api';
const CACHE_TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;

async function slack(method, params = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  const qs = new URLSearchParams(params).toString();
  const url = `${SLACK}/${method}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const err = data.error || `HTTP ${r.status}`;
    throw new Error(`slack.${method} failed: ${err}`);
  }
  return data;
}

function unixToIso(ts) {
  // Slack ts is "seconds.microseconds"
  const secs = Math.floor(Number(String(ts).split('.')[0]));
  return new Date(secs * 1000).toISOString();
}
function unixToHuman(ts) {
  const secs = Math.floor(Number(String(ts).split('.')[0]));
  return new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

async function loadUsers() {
  const map = {};
  try {
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const data = await slack('users.list', cursor ? { cursor, limit: '200' } : { limit: '200' });
      for (const u of data.members || []) {
        map[u.id] = {
          name: u.profile?.display_name_normalized || u.real_name || u.name || u.id,
          is_bot: !!(u.is_bot || u.id === 'USLACKBOT'),
        };
      }
      cursor = data.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
  } catch (e) {
    console.error('slack users.list failed:', e.message);
  }
  return map;
}

async function loadDMs(users) {
  // conversations.list only for DMs (im) and group DMs (mpim)
  const out = [];
  try {
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const data = await slack('conversations.list', {
        types: 'im,mpim',
        exclude_archived: 'true',
        limit: '100',
        ...(cursor ? { cursor } : {}),
      });
      for (const c of data.channels || []) {
        out.push({
          id: c.id,
          is_im: !!c.is_im,
          is_mpim: !!c.is_mpim,
          user: c.user || null, // for IMs
        });
      }
      cursor = data.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
  } catch (e) {
    console.error('slack conversations.list failed:', e.message);
  }
  return out;
}

async function historyMessages(channel, users, cutoffTs) {
  const out = [];
  try {
    const data = await slack('conversations.history', {
      channel,
      limit: '10',
      oldest: String(cutoffTs),
      inclusive: 'false',
    });
    for (const m of data.messages || []) {
      // Skip system/messages without user
      if (m.subtype && m.subtype !== 'bot_message') continue;
      const userId = m.user || m.bot_id || null;
      const uinfo = userId ? users[userId] : null;
      out.push({
        channel_id: channel,
        user_id: userId,
        user_name: uinfo?.name || (m.username || 'unknown'),
        is_bot: uinfo?.is_bot ?? !!m.bot_id,
        text: (m.text || '(mensaje sin texto)').slice(0, 400),
        ts: m.ts,
        ts_iso: unixToIso(m.ts),
        ts_human: unixToHuman(m.ts),
      });
    }
  } catch (e) {
    console.error(`slack conversations.history(${channel}) failed:`, e.message);
  }
  return out;
}

async function fetchInbox() {
  const users = await loadUsers();
  const dms = await loadDMs(users);

  // Look back 14 days
  const cutoffTs = Math.floor((Date.now() - 14 * 24 * 3600 * 1000) / 1000);
  const buckets = await Promise.all(dms.map(dm => historyMessages(dm.id, users, cutoffTs).then(msgs => ({ dm, msgs }))));

  const messages = [];
  for (const { dm, msgs } of buckets) {
    for (const m of msgs) {
      let channel_label = 'DM';
      if (dm.is_im && dm.user && users[dm.user]) channel_label = `DM · ${users[dm.user].name}`;
      else if (dm.is_mpim) channel_label = 'Group DM';
      messages.push({
        channel_id: m.channel_id,
        channel_label,
        user_name: m.user_name,
        user_id: m.user_id,
        is_bot: m.is_bot,
        text: m.text,
        ts: m.ts,
        ts_human: m.ts_human,
        permalink: null,
      });
    }
  }

  messages.sort((a, b) => Number(b.ts) - Number(a.ts));
  return {
    source: 'slack_inbox',
    query: 'DMs + group DMs (last 14 days)',
    scope: 'DCE Cockpit bot inbox',
    fetched_at: new Date().toISOString(),
    messages: messages.slice(0, 20),
  };
}

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json(cached);
      return;
    }
    const inbox = await fetchInbox();
    cached = inbox;
    cachedAt = now;
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).json(inbox);
  } catch (e) {
    console.error('slack-inbox failed:', e.message);
    res.status(500).json({
      source: 'slack_inbox',
      error: e.message,
      messages: [],
      fetched_at: new Date().toISOString(),
    });
  }
};
