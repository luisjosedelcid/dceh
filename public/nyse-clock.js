/**
 * DCE — NYSE mini clock
 * Auto-inject a small "NY HH:MM · STATUS" chip into any element with .hnav.
 *
 * Primary data: BellHour public API (free, no key, CORS-enabled, edge cached).
 * Fallback: hardcoded NYSE 2026-2027 holiday table + local Intl.DateTimeFormat.
 *
 * Include once per page:
 *   <script src="/nyse-clock.js" defer></script>
 */
(function () {
  'use strict';

  // ── NYSE holidays 2026-2027 (fallback only) ─────────────────────────────
  const NYSE_HOLIDAYS = {
    // full closures
    '2026-01-01': 'closed', '2026-01-19': 'closed', '2026-02-16': 'closed',
    '2026-04-03': 'closed', '2026-05-25': 'closed', '2026-06-19': 'closed',
    '2026-07-03': 'closed', '2026-09-07': 'closed', '2026-11-26': 'closed',
    '2026-12-25': 'closed',
    '2027-01-01': 'closed', '2027-01-18': 'closed', '2027-02-15': 'closed',
    '2027-03-26': 'closed', '2027-05-31': 'closed', '2027-06-18': 'closed',
    '2027-07-05': 'closed', '2027-09-06': 'closed', '2027-11-25': 'closed',
    '2027-12-24': 'closed',
    // early closes at 13:00 ET
    '2026-11-27': 'early', '2026-12-24': 'early',
    '2027-11-26': 'early', '2027-12-23': 'early',
  };

  function fallbackStatus() {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const hhmm = `${parts.hour}:${parts.minute}`;
    const minutes = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const wd = parts.weekday;
    const isWeekend = (wd === 'Sat' || wd === 'Sun');
    const holiday = NYSE_HOLIDAYS[dateKey];
    let status = 'closed';
    let label = 'CLOSED';
    if (isWeekend) { status = 'closed'; label = 'CLOSED'; }
    else if (holiday === 'closed') { status = 'closed'; label = 'HOLIDAY'; }
    else if (holiday === 'early') {
      if (minutes < 240) { status = 'closed'; label = 'CLOSED'; }
      else if (minutes < 570) { status = 'pre-market'; label = 'PRE-MKT'; }
      else if (minutes < 780) { status = 'open'; label = 'OPEN'; }         // 09:30-13:00
      else if (minutes < 1200) { status = 'after-hours'; label = 'AFTER'; }// 13:00-20:00
      else { status = 'closed'; label = 'CLOSED'; }
    } else {
      if (minutes < 240) { status = 'closed'; label = 'CLOSED'; }          // <04:00
      else if (minutes < 570) { status = 'pre-market'; label = 'PRE-MKT'; }// 04:00-09:30
      else if (minutes < 960) { status = 'open'; label = 'OPEN'; }         // 09:30-16:00
      else if (minutes < 1200) { status = 'after-hours'; label = 'AFTER'; }// 16:00-20:00
      else { status = 'closed'; label = 'CLOSED'; }
    }
    return { status, label, localTime: hhmm };
  }

  function render(el, { status, label, localTime }) {
    if (!el) return;
    const colors = {
      'open':        '#4ade80',
      'pre-market':  '#facc15',
      'after-hours': '#fb923c',
      'closed':      'rgba(255,255,255,0.45)',
      'holiday':     'rgba(255,255,255,0.45)',
      'lunch-break': '#facc15',
    };
    const color = colors[status] || 'rgba(255,255,255,0.45)';
    el.innerHTML =
      '<span style="color:rgba(255,255,255,0.4)">NY</span> ' +
      '<span style="color:rgba(255,255,255,0.85);font-weight:600">' + localTime + '</span> ' +
      '<span style="color:rgba(255,255,255,0.2);margin:0 3px">·</span> ' +
      '<span style="color:' + color + ';font-weight:700;letter-spacing:0.18em">' + label + '</span>';
    el.style.display = '';
  }

  async function fetchLive() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch('https://bellhour.com/api/markets/nyse', { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('http ' + r.status);
      const d = await r.json();
      let time24 = d.localTime;
      const m = String(d.localTime || '').match(/(\d{1,2}):(\d{2}):\d{2}\s*(AM|PM)?/i);
      if (m) {
        let hh = parseInt(m[1], 10);
        const mm = m[2];
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && hh < 12) hh += 12;
        if (ampm === 'AM' && hh === 12) hh = 0;
        time24 = String(hh).padStart(2, '0') + ':' + mm;
      }
      const labelMap = {
        'open':        'OPEN',
        'pre-market':  'PRE-MKT',
        'after-hours': 'AFTER',
        'closed':      d.holidayName ? 'HOLIDAY' : 'CLOSED',
        'holiday':     'HOLIDAY',
        'lunch-break': 'LUNCH',
      };
      return {
        status: d.status || 'closed',
        label: labelMap[d.status] || String(d.status || 'CLOSED').toUpperCase(),
        localTime: time24,
      };
    } catch (err) {
      return fallbackStatus();
    }
  }

  function ensureChip() {
    // Inject chip into each .hnav that does not already have one
    const navs = document.querySelectorAll('.hnav');
    const chips = [];
    navs.forEach(nav => {
      let chip = nav.querySelector('.h-nyse');
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'h-nyse';
        chip.title = 'NYSE market status';
        chip.style.cssText =
          'display:none;font-size:9px;letter-spacing:0.14em;' +
          'color:rgba(255,255,255,0.55);margin-left:10px;padding-left:10px;' +
          'border-left:1px solid rgba(255,255,255,0.15);white-space:nowrap;' +
          'font-variant-numeric:tabular-nums';
        nav.appendChild(chip);
      }
      chips.push(chip);
    });
    return chips;
  }

  function tick() {
    const chips = ensureChip();
    if (!chips.length) return;
    // Instant render with local fallback (no wait)
    const localState = fallbackStatus();
    chips.forEach(el => render(el, localState));
    // Async refresh with API
    fetchLive().then(state => {
      chips.forEach(el => render(el, state));
    });
  }

  function init() {
    tick();
    setInterval(tick, 30000); // refresh every 30s
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
