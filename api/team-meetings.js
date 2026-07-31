// GET /api/team-meetings
//   Reads upcoming Google Calendar events (next 7 days) and filters to only
//   ones with at least one @dceholdings.com attendee. Returns the same shape
//   the static /data/team_meetings.json used, so the cockpit renderer works.
//
// Auth: uses OAuth refresh token to mint access tokens on demand.
// Env:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//
// Caching: 60s in-memory per lambda instance.

'use strict';

const CACHE_TTL_MS = 60 * 1000;
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

const TZ = 'Europe/Madrid';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function partsInTz(iso) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    weekday: parts.weekday, // e.g. 'Tue'
    monthName: MONTHS[parseInt(parts.month, 10) - 1],
  };
}

function fmtTime(iso, isAllDay) {
  if (isAllDay) return 'All day';
  const p = partsInTz(iso);
  return `${p.hour}:${p.minute}`;
}

function fmtDate(iso) {
  const p = partsInTz(iso);
  return `${p.day} ${p.monthName}`;
}

function fmtWeekday(iso) {
  const p = partsInTz(iso);
  return p.weekday;
}

function daysUntil(iso) {
  // Compare dates in Madrid TZ
  const startP = partsInTz(iso);
  const todayP = partsInTz(new Date().toISOString());
  const startDate = new Date(`${startP.year}-${startP.month}-${startP.day}T00:00:00Z`);
  const todayDate = new Date(`${todayP.year}-${todayP.month}-${todayP.day}T00:00:00Z`);
  return Math.round((startDate - todayDate) / (24 * 3600 * 1000));
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
  const endTimeLabel = endIso && !isAllDay ? fmtTime(endIso, false) : '';
  const timeLabel = isAllDay ? 'All day' : (endTimeLabel ? `${fmtTime(startIso, false)}–${endTimeLabel}` : fmtTime(startIso, false));
  return {
    id: event.id,
    title: event.summary || '(no title)',
    start: startIso,
    end: endIso,
    is_all_day: isAllDay,
    weekday: fmtWeekday(startIso),
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
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json(cached);
      return;
    }
    const payload = await fetchTeamMeetings();
    cached = payload;
    cachedAt = now;
    res.setHeader('Cache-Control', 'public, max-age=60');
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
