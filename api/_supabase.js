// Tiny helper for Supabase REST (PostgREST) calls.
// Uses the service-role key so RLS is bypassed.

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function sbBaseUrl() {
  return process.env.SUPABASE_URL + '/rest/v1';
}

async function sbInsert(table, row) {
  const r = await fetch(`${sbBaseUrl()}/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`sbInsert ${table} failed: ${r.status} ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function sbSelect(table, query = '') {
  const url = `${sbBaseUrl()}/${table}${query ? '?' + query : ''}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`sbSelect ${table} failed: ${r.status} ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function sbUpdate(table, query, patch) {
  const url = `${sbBaseUrl()}/${table}?${query}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`sbUpdate ${table} failed: ${r.status} ${t.slice(0, 300)}`);
  }
  return r.json();
}

module.exports = { sbInsert, sbSelect, sbUpdate, sbHeaders, sbBaseUrl };
