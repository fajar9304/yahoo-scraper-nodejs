import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, set } from 'firebase/database';
import fetch from 'node-fetch';

// --- KONFIGURASI FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyCCV7FD5FQqVW1WnP-Zu6UWAhAz19dthso",
  authDomain: "analisahamku.firebaseapp.com",
  databaseURL: "https://analisahamku-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "analisahamku",
  storageBucket: "analisahamku.appspot.com",
  messagingSenderId: "503947258604",
  appId: "1:503947258604:web:f5b10c998ce395405413c9"
};

// --- KONFIGURASI GEMINI ---
const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = "gemini-pro";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// --- INISIALISASI ---
const app = express();
const PORT = process.env.PORT || 3000;

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

app.use(cors());
app.use(express.json());

// === LOGIN ANONIM KE FIREBASE ===
async function ensureFirebaseAuth() {
  if (!auth.currentUser) {
    try {
      await signInAnonymously(auth);
      console.log("✅ Server berhasil login anonim ke Firebase");
    } catch (error) {
      console.error("❌ Gagal login anonim:", error.message);
    }
  }
}

// === SCRAPER DATA SAHAM & CRYPTO ===
async function getAssetPriceData(ticker) {
  try {
    const isCrypto = ticker.endsWith("-USD");
    let result;

    if (isCrypto) {
      // Endpoint chart untuk crypto
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const data = await response.json();
      const meta = data?.chart?.result?.[0]?.meta;

      if (!meta?.regularMarketPrice) return null;

      result = {
        symbol: meta.symbol,
        shortName: meta.instrumentDisplayName || ticker,
        currency: meta.currency || "USD",
        regularMarketPrice: meta.regularMarketPrice,
        regularMarketChangePercent: meta.regularMarketChangePercent || null
      };
    } else {
      // Endpoint price untuk saham
      const response = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=price`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const data = await response.json();
      const price = data?.quoteSummary?.result?.[0]?.price;
      if (!price?.regularMarketPrice?.raw) return null;

      result = {
        symbol: price.symbol,
        shortName: price.shortName || price.longName || ticker,
        currency: price.currency || "IDR",
        regularMarketPrice: price.regularMarketPrice.raw,
        regularMarketChangePercent: price.regularMarketChangePercent?.fmt || null
      };
    }

    return result;
  } catch (error) {
    console.error(`Gagal ambil data ${ticker}:`, error.message);
    return null;
  }
}

// === ANALISIS DENGAN GEMINI ===
async function getAiAnalysis(assetName, isCrypto) {
  const prompt = isCrypto
    ? `Buat ringkasan singkat (maks 2 kalimat) tentang sentimen pasar crypto ${assetName} hari ini.`
    : `Buat ringkasan singkat (maks 2 kalimat) tentang sentimen pasar saham ${assetName} hari ini.`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const json = await response.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text || "Analisis tidak tersedia.";
  } catch (error) {
    console.error(`Gagal analisis AI untuk ${assetName}:`, error.message);
    return "Gagal memuat analisis AI.";
  }
}

// === PROSES PENYIMPANAN KE FIREBASE ===
const STOCKS = ['BBCA.JK', 'BBRI.JK', 'TLKM.JK'];
const CRYPTOS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD'];

async function runScraper() {
  await ensureFirebaseAuth();
  console.log(`[${new Date().toLocaleString('id-ID')}] Menjalankan scraper...`);

  for (const ticker of [...STOCKS, ...CRYPTOS]) {
    const isCrypto = ticker.endsWith("-USD");
    const data = await getAssetPriceData(ticker);
    if (!data) continue;

    const aiSummary = await getAiAnalysis(data.shortName, isCrypto);
    const payload = { ...data, aiAnalysis: aiSummary, updatedAt: new Date().toISOString() };

    try {
      const path = isCrypto
        ? `crypto_analysis/${ticker.replace('.', '_').replace('-', '_')}`
        : `stock_analysis/${ticker.replace('.', '_').replace('-', '_')}`;

      await set(ref(database, path), payload);
      console.log(`✅ ${ticker} disimpan ke ${path}`);
    } catch (err) {
      console.error(`❌ Gagal simpan ${ticker}:`, err.message);
    }
  }

  console.log("✅ Selesai scraping.\n");
}

// === ENDPOINT API ===
app.get("/", (req, res) => res.send("✅ Server Scraper Saham & Crypto Aktif!"));
app.get("/api/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const data = await getAssetPriceData(symbol);
  if (!data) return res.status(404).json({ error: `Data tidak ditemukan: ${symbol}` });

  const ai = await getAiAnalysis(data.shortName, symbol.endsWith("-USD"));
  res.json({ ...data, aiAnalysis: ai });
});

// === CRON JOB & START SERVER ===
app.listen(PORT, async () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
  await ensureFirebaseAuth();
  await runScraper();
  cron.schedule("0 * * * *", runScraper);
});
