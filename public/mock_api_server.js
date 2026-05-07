const http = require('http');

const PORT = 8766;

const MOCK_JOURNAL = {
  decisions: [
    {
      id: 'dec1',
      ticker: 'LULU',
      type: 'BUY',
      date: '2023-03-15',
      price: 312.50,
      thesis_summary: 'Premium athletic wear with pricing power and international expansion runway.',
      next_review_date: '2026-02-01'
    }
  ],
  total: 1, buy: 1, sell: 0, pass: 0, hold: 0, pending_reviews: 1
};

const MOCK_REUNDERWRITING = [
  {
    id: 'reund1',
    ticker: 'LULU',
    doc_type: '10-K',
    period_end: '2026-02-01',
    filed_at: '2026-03-20',
    days_overdue: 51,
    source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=LULU',
    status: 'pending'
  }
];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url.startsWith('/api/journal')) {
    res.writeHead(200);
    res.end(JSON.stringify(MOCK_JOURNAL));
  } else if (req.url.startsWith('/api/reunderwriting-due')) {
    res.writeHead(200);
    res.end(JSON.stringify(MOCK_REUNDERWRITING));
  } else if (req.url.startsWith('/api/premortems')) {
    res.writeHead(200);
    res.end(JSON.stringify({ items: [] }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => console.log(`Mock API running on :${PORT}`));
