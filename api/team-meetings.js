// GET /api/team-meetings
//   Reads upcoming Google Calendar events (next 7 days) and filters to only
//   ones with at least one @dceholdings.com attendee. Returns the same shape
//   the static /data/team_meetings.json used, so the cockpit renderer works.
//
// Auth: uses OAuth refresh token to mint access tokens on demand.
// Env:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//
// Caching: 5 min in-memory per lambda instance.

'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = null;
let cachedAt = 0;

async function mintAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`token refresh failed: ${data.error || r.status} ${data.error_description || ''}`);
  }
  return data.access_token;
}

async function listEvents(accessToken) {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: in7d.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`calendar.events.list failed: ${data.error?.message || r.status}`);
  }
  return data.items || [];
}

function hasDceAttendee(event) {
  const attendees = event.attendees || [];
  return attendees.some(a => (a.email || '').toLowerCase().endsWith('@dceholdings.com'));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtTime(iso, isAllDay) {
  if (isAllDay) return 'All day';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${dd} ${mon}`;
}

function daysUntil(iso) {
  const start = new Date(iso);
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((start - today) / (24 * 3600 * 1000));
}

function normalize(event) {
  const startIso = event.start?.dateTime || event.start?.date;
  const endIso = event.end?.dateTime || event.end?.date;
  const isAllDay = !!event.start?.date;
  const attendees = (event.attendees || [])
    .filter(a => !a.resource)
    .map(a => ({
      email: a.email,
      display_name: a.displayName || (a.email || '').split('@')[0],
      is_dce: (a.email || '').toLowerCase().endsWith('@dceholdings.com'),
      response: a.responseStatus || 'needsAction',
    }));
  const startDate = new Date(startIso);
  const endTimeLabel = endIso && !isAllDay ? fmtTime(endIso, false) : '';
  const timeLabel = isAllDay ? 'All day' : (endTimeLabel ? `${fmtTime(startIso, false)}–${endTimeLabel}` : fmtTime(startIso, false));
  return {
    id: event.id,
    title: event.summary || '(no title)',
    start: startIso,
    end: endIso,
    is_all_day: isAllDay,
    weekday: WEEKDAYS[startDate.getDay()],
    date_label: fmtDate(startIso),
    time_label: timeLabel,
    days_until: daysUntil(startIso),
    location: event.location || null,
    hangout_link: event.hangoutLink || null,
    html_link: event.htmlLink || null,
    organizer_email: event.organizer?.email || null,
    attendees,
    attendee_count: attendees.length,
    dce_attendee_count: attendees.filter(a => a.is_dce).length,
  };
}

async function fetchTeamMeetings() {
  const accessToken = await mintAccessToken();
  const events = await listEvents(accessToken);
  const filtered = events.filter(hasDceAttendee).map(normalize);
  return {
    source: 'google_calendar',
    filter: 'attendees with @dceholdings.com domain',
    window_days: 7,
    fetched_at: new Date().toISOString(),
    events: filtered,
  };
}

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json(cached);
      return;
    }
    const payload = await fetchTeamMeetings();
    cached = payload;
    cachedAt = now;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(payload);
  } catch (e) {
    console.error('team-meetings failed:', e.message);
    res.status(500).json({
      source: 'google_calendar',
      error: e.message,
      events: [],
      fetched_at: new Date().toISOString(),
    });
  }
};
