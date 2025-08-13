// app.js
// Full-stack (single file): serves UI + backend API with Yahoo fallbacks.
// Node.js >= 18 recommended (has global fetch).

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// fetch setup for Node < 18
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(morgan('dev'));

// Utility: perform fetch with sane headers
async function httpGet(url) {
  const r = await _fetch(url, {
    headers: {
      "User-Agent": process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      "Referer": "https://finance.yahoo.com/"
    },
  });
  return r;
}

// Assemble a normalized payload from available Yahoo endpoints
function normalizeFromQuote(q) {
  if (!q) return null;
  return {
    symbol: q.symbol || null,
    shortName: q.shortName || q.longName || null,
    currency: q.currency || null,
    regularMarketPrice: q.regularMarketPrice?.toLocaleString?.('en-US', { maximumFractionDigits: 6 }) ?? (q.regularMarketPrice ?? null),
    regularMarketChangePercent: (typeof q.regularMarketChangePercent === 'number')
      ? `${q.regularMarketChangePercent.toFixed(2)}%` : (q.regularMarketChangePercent ?? null),
    regularMarketPreviousClose: q.regularMarketPreviousClose ?? null,
    regularMarketDayRange: (q.regularMarketDayLow != null && q.regularMarketDayHigh != null)
      ? `${q.regularMarketDayLow} - ${q.regularMarketDayHigh}` : null,
    fiftyTwoWeekRange: (q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh != null)
      ? `${q.fiftyTwoWeekLow} - ${q.fiftyTwoWeekHigh}` : (q.fiftyTwoWeekRange ?? null),
    regularMarketVolume: q.regularMarketVolume ?? q.volume ?? null,
    marketCap: q.marketCap ?? null,
  };
}

function normalizeFromChart(meta) {
  if (!meta) return null;
  const fmt = (n) => (typeof n === 'number') ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : n;
  return {
    symbol: meta.symbol || null,
    shortName: `${meta.exchangeName || ''} | ${meta.instrumentType || ''}`.trim() || null,
    currency: meta.currency || null,
    regularMarketPrice: fmt(meta.regularMarketPrice),
    regularMarketChangePercent: null,
    regularMarketPreviousClose: fmt(meta.chartPreviousClose),
    regularMarketDayRange: (meta.regularMarketDayLow != null && meta.regularMarketDayHigh != null)
      ? `${fmt(meta.regularMarketDayLow)} - ${fmt(meta.regularMarketDayHigh)}` : null,
    fiftyTwoWeekRange: null,
    regularMarketVolume: meta.regularMarketVolume ?? null,
    marketCap: null,
  };
}

// API endpoint with fallbacks
app.get('/api/quote', async (req, res) => {
  try {
    const rawTicker = (req.query.ticker || '').trim();
    const ticker = rawTicker.toUpperCase();
    if (!ticker) return res.status(400).json({ error: "Parameter 'ticker' wajib diisi, contoh: BBRI.JK" });
    if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker)) return res.status(400).json({ error: "Format ticker tidak valid." });

    // 1) Try quoteSummary (rich data)
    const url1 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price,summaryDetail,priceHint`;
    let r1 = await httpGet(url1);
    if (r1.ok) {
      const j1 = await r1.json();
      const result = j1?.quoteSummary?.result?.[0];
      if (result) {
        const price = result.price || {};
        const detail = result.summaryDetail || {};
        const payload = {
          symbol: price.symbol,
          shortName: price.shortName || price.longName,
          currency: price.currency,
          regularMarketPrice: price.regularMarketPrice?.fmt ?? null,
          regularMarketChangePercent: price.regularMarketChangePercent?.fmt ?? null,
          regularMarketPreviousClose: price.regularMarketPreviousClose?.fmt ?? null,
          regularMarketDayRange: price.regularMarketDayRange?.fmt ?? (detail.dayLow?.fmt && detail.dayHigh?.fmt ? `${detail.dayLow.fmt} - ${detail.dayHigh.fmt}` : null),
          fiftyTwoWeekRange: detail.fiftyTwoWeekRange?.fmt ?? ((detail.fiftyTwoWeekLow?.fmt && detail.fiftyTwoWeekHigh?.fmt) ? `${detail.fiftyTwoWeekLow.fmt} - ${detail.fiftyTwoWeekHigh.fmt}` : null),
          regularMarketVolume: price.regularMarketVolume?.fmt ?? detail.volume?.fmt ?? null,
          marketCap: price.marketCap?.fmt ?? detail.marketCap?.fmt ?? null,
        };
        return res.json(payload);
      }
    }

    // 2) Fallback: v7 quote (usually open)
    const url2 = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
    const r2 = await httpGet(url2);
    if (r2.ok) {
      const j2 = await r2.json();
      const q = j2?.quoteResponse?.result?.[0];
      if (q) {
        const payload = normalizeFromQuote(q);
        return res.json(payload);
      }
    }

    // 3) Fallback: v8 chart meta (last resort for price/basic)
    const url3 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const r3 = await httpGet(url3);
    if (r3.ok) {
      const j3 = await r3.json();
      const meta = j3?.chart?.result?.[0]?.meta;
      if (meta) {
        const payload = normalizeFromChart(meta);
        return res.json(payload);
      }
    }

    // If reached here, forward meaningful status from first attempt
    const status = r1?.status || r2?.status || r3?.status || 502;
    return res.status(status).json({ error: `Yahoo request failed (status ${status}).` });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Serve minimal UI
app.get('/', (req, res) => {
  res.type('html').send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Yahoo Finance Scraper (Full-Stack)</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  .pos{color:#059669}.neg{color:#dc2626}
</style>
</head>
<body class="bg-gray-100 min-h-screen flex items-center justify-center">
  <div class="bg-white p-6 rounded-2xl shadow w-full max-w-xl">
    <h1 class="text-2xl font-bold text-center">Yahoo Finance Scraper (API)</h1>
    <div class="mt-4 flex gap-2">
      <input id="t" placeholder="Contoh: BBRI.JK" class="flex-1 border rounded-lg px-3 py-2"/>
      <button id="b" class="bg-indigo-600 text-white rounded-lg px-4 py-2 hover:bg-indigo-700">Ambil Data</button>
    </div>
    <p id="e" class="text-red-600 text-sm mt-2 hidden"></p>
    <div id="out" class="mt-5 hidden">
      <div class="text-lg font-semibold" id="name"></div>
      <div class="text-gray-500" id="sym"></div>
      <div class="grid sm:grid-cols-2 gap-3 mt-3">
        <div><span class="font-medium">Harga:</span> <span id="price"></span></div>
        <div><span class="font-medium">Perubahan:</span> <span id="chg"></span></div>
        <div><span class="font-medium">Prev Close:</span> <span id="prev"></span></div>
        <div><span class="font-medium">Day Range:</span> <span id="day"></span></div>
        <div><span class="font-medium">52W Range:</span> <span id="yr"></span></div>
        <div><span class="font-medium">Volume:</span> <span id="vol"></span></div>
        <div><span class="font-medium">Market Cap:</span> <span id="cap"></span></div>
      </div>
    </div>
  </div>
<script>
const $ = (id)=>document.getElementById(id);
$('b').addEventListener('click', run);
$('t').addEventListener('keypress', e=>{ if(e.key==='Enter') run() });

async function run(){
  const t = $('t').value.trim().toUpperCase();
  $('e').classList.add('hidden'); $('out').classList.add('hidden');
  if(!t){ $('e').textContent='Masukkan kode saham'; $('e').classList.remove('hidden'); return; }
  try{
    const r = await fetch('/api/quote?ticker=' + encodeURIComponent(t));
    const d = await r.json();
    if(!r.ok || d.error){ throw new Error(d.error || 'HTTP '+r.status); }
    $('name').textContent = d.shortName || t;
    $('sym').textContent = t;
    $('price').textContent = d.regularMarketPrice ?? 'N/A';
    const chg = d.regularMarketChangePercent ?? 'N/A';
    $('chg').textContent = chg;
    $('chg').className = chg.startsWith && chg.startsWith('-') ? 'neg' : 'pos';
    $('prev').textContent = d.regularMarketPreviousClose ?? 'N/A';
    $('day').textContent = d.regularMarketDayRange ?? 'N/A';
    $('yr').textContent = d.fiftyTwoWeekRange ?? 'N/A';
    $('vol').textContent = d.regularMarketVolume ?? 'N/A';
    $('cap').textContent = d.marketCap ?? 'N/A';
    $('out').classList.remove('hidden');
  }catch(err){
    $('e').textContent = 'Gagal mengambil data: ' + err.message;
    $('e').classList.remove('hidden');
  }
}
</script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ Full-stack app running at http://localhost:${PORT}`);
  console.log(`   Try UI in browser, or API: http://localhost:${PORT}/api/quote?ticker=BBRI.JK`);
});
