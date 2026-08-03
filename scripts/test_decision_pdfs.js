// Local render for the three decision PDF flavors (BUY, PASS, FOLLOW).
// Bypasses auth by calling the handler with a pre-baked admin token
// header. Writes files under /tmp/dceh-pdf-tests/*.pdf.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const handler = require('../api/decision-pdf.js');

const OUT_DIR = '/tmp/dceh-pdf-tests';
fs.mkdirSync(OUT_DIR, { recursive: true });

// Cases to render. id numbers come from the DB.
const cases = [
  { id: 1, name: 'buy_msft' },     // BUY (v3.2)
  { id: 8, name: 'pass_test' },    // PASS with reason fields
  { id: 9, name: 'follow_test' },  // FOLLOW with watchlist fields
];

// Fake req/res shim. Handler resolves when the res stream ends.
function invoke(id) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = new PassThrough();
    res.setHeader = () => {};
    res.status = (code) => { res._code = code; return res; };
    res.end = (data) => {
      if (data) chunks.push(Buffer.from(data));
      res.emit('finish');
    };
    res.on('data', (c) => chunks.push(c));
    res.on('finish', () => resolve({ code: res._code || 200, body: Buffer.concat(chunks) }));
    res.on('error', reject);
    const req = {
      method: 'GET',
      url: `/api/decision-pdf?id=${id}&_tok=x`,
      query: { id: String(id), _tok: 'x' },
      headers: {
        'x-admin-token': process.env.ADMIN_TOKEN || '',
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  for (const c of cases) {
    try {
      const { code, body } = await invoke(c.id);
      const outPath = path.join(OUT_DIR, `${c.name}.pdf`);
      fs.writeFileSync(outPath, body);
      console.log(`${c.name} id=${c.id} status=${code} size=${body.length} -> ${outPath}`);
    } catch (e) {
      console.error(`${c.name} id=${c.id} FAILED:`, e.message);
    }
  }
})();
