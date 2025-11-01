import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set } from 'firebase/database';
import fetch from 'node-fetch';

// --- KONFIGURASI ---

const firebaseConfig = {
  apiKey: "AIzaSyCCV7FD5FQqVW1WnP-Zu6UWAhAz19dthso",
  authDomain: "analisahamku.firebaseapp.com",
  projectId: "analisahamku",
  storageBucket: "analisahamku.appspot.com",
  messagingSenderId: "503947258604",
  appId: "1:503947258604:web:f5b10c998ce395405413c9",
  databaseURL: "https://analisahamku-default-rtdb.asia-southeast1.firebasedatabase.app"
};

const STOCK_TICKERS_FOR_CRON = ['BBCA.JK', 'BBRI.JK', 'TLKM.JK'];
const CRYPTO_TICKERS_FOR_CRON = ['BTC-USD', 'ETH-USD', 'BNB-USD', 'SOL-USD'];
const ALL_CRON_TICKERS = [...STOCK_TICKERS_FOR_CRON, ...CRYPTO_TICKERS_FOR_CRON];

const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = 'gemini-pro';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// --- INISIALISASI ---
const app = express();
const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

app.use(cors());
app.use(express.json());

// --- SCRAPER HARGA SAHAM / CRYPTO ---

async function getAssetPriceData(ticker) {
  try {
    // Untuk saham gunakan quoteSummary
    const isCrypto = ticker.endsWith('-USD');
    let result = null;

    if (!isCrypto) {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await res.json();
      result = json?.quoteSummary?.result?.[0]?.price;
    } else {
      // Untuk crypto, gunakan endpoint chart (lebih stabil)
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;

      if (meta) {
        result = {
          symbol: meta.symbol,
          shortName: meta.instrumentDisplayName || ticker,
          currency: meta.currency,
          regularMarketPrice: { raw: meta.regularMarketPrice },
          regularMarketChangePercent: { fmt: meta.regularMarketChangePercent || null }
        };
      }
    }

    if (!result || !result.regularMarketPrice) {
      console.warn(`[WARNING] Data harga kosong untuk ticker: ${ticker}`);
      return null;
    }

    return {
      symbol: result.symbol,
      shortName: result.shortName || result.symbol,
      currency: result.currency,
      regularMarketPrice: result.regularMarketPrice.raw ?? null,
      regularMarketChangePercent: result.regularMarketChangePercent?.fmt ?? null,
    };
  } catch (error) {
    console.error(`Gagal mengambil data harga untuk ${ticker}:`, error);
    return null;
  }
}

// --- ANALISIS AI ---
async function getAiAnalysis(assetName, isCrypto) {
  const prompt = isCrypto
    ? `Ringkas dalam 2 kalimat sentimen pasar dan volatilitas terkini untuk crypto ${assetName}.`
    : `Ringkas dalam 2 kalimat sentimen pasar terkini untuk saham ${assetName}.`;

  try {
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Analisis tidak tersedia.";
  } catch (error) {
    console.error(`Gagal menganalisis ${assetName}:`, error);
    return "Gagal memuat analisis AI.";
  }
}

// --- MESIN ANALISIS ---
async function runAnalysisEngine() {
  console.log(`[${new Date().toLocaleString('id-ID')}] Mulai scrape...`);

  for (const ticker of ALL_CRON_TICKERS) {
    const isCrypto = ticker.endsWith('-USD');
    const priceData = await getAssetPriceData(ticker);
    if (!priceData) continue;

    const aiSummary = await getAiAnalysis(priceData.shortName, isCrypto);
    const combinedData = {
      ...priceData,
      aiAnalysis: aiSummary,
      lastUpdated: new Date().toISOString()
    };

    try {
      const dbRef = ref(database, 'stock_analysis/' + ticker.replace('.', '_').replace('-', '_'));
      await set(dbRef, combinedData);
      console.log(`✅ ${ticker} disimpan ke Firebase.`);
    } catch (error) {
      console.error(`❌ Gagal menyimpan ${ticker}:`, error);
    }
  }

  console.log("✅ Siklus scrape selesai.");
}

// --- ENDPOINT API ---
app.get('/api/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const isCrypto = symbol.endsWith('-USD');
  const priceData = await getAssetPriceData(symbol);
  if (!priceData) return res.status(404).json({ error: `Data tidak ditemukan: ${symbol}` });

  const aiSummary = await getAiAnalysis(priceData.shortName, isCrypto);
  res.json({ ...priceData, aiAnalysis: aiSummary, lastUpdated: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('✅ Server Scraper Saham & Kripto Aktif!');
});

// --- CRON ---
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
  runAnalysisEngine();
  cron.schedule('0 * * * *', runAnalysisEngine); // setiap jam
});
