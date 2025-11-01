import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set } from 'firebase/database';
import fetch from 'node-fetch';

// --- KONFIGURASI FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyCCV7FD5FQqVW1WnP-Zu6UWAhAz19dthso",
  authDomain: "analisahamku.firebaseapp.com",
  databaseURL: "https://analisahamku-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "analisahamku",
  storageBucket: "analisahamku.firebasestorage.app",
  messagingSenderId: "503947258604",
  appId: "1:503947258604:web:f5b10c998ce395405413c9"
};

// --- KONFIGURASI LAIN ---
const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = 'gemini-pro';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const GOOGLE_SEARCH_TOOL = { "google_search": {} };

const STOCK_TICKERS_FOR_CRON = ['BBCA.JK', 'BBRI.JK', 'TLKM.JK'];
const CRYPTO_TICKERS_FOR_CRON = ['BTC-USD', 'ETH-USD'];
const ALL_CRON_TICKERS = [...STOCK_TICKERS_FOR_CRON, ...CRYPTO_TICKERS_FOR_CRON];

// --- INISIALISASI SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

app.use(cors());
app.use(express.json());

// =============================================================
// 🔍 FUNGSI: Ambil harga saham / crypto dari Yahoo Finance
// =============================================================
async function getAssetPriceData(ticker) {
  try {
    // --- Coba ambil dari endpoint quoteSummary ---
    const url1 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
    const res1 = await fetch(url1, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res1.ok) {
      const json1 = await res1.json();
      const result = json1?.quoteSummary?.result?.[0]?.price;
      if (result) {
        return {
          symbol: result.symbol,
          shortName: result.shortName || result.longName || result.symbol,
          currency: result.currency,
          regularMarketPrice: result.regularMarketPrice?.raw ?? null,
          regularMarketChangePercent: result.regularMarketChangePercent?.fmt ?? null,
        };
      }
    }

    // --- Jika gagal, fallback ke chart API ---
    const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?region=ID&lang=en-US&interval=1d&range=1d`;
    const res2 = await fetch(url2, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res2.ok) throw new Error(`Yahoo chart API gagal untuk ${ticker}`);
    const json2 = await res2.json();
    const meta = json2?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error(`Meta tidak ditemukan di chart API untuk ${ticker}`);

    return {
      symbol: meta.symbol,
      shortName: meta.instrumentDisplayName || meta.symbol,
      currency: meta.currency || 'IDR',
      regularMarketPrice: meta.regularMarketPrice ?? null,
      regularMarketChangePercent: meta.chartPreviousClose
        ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2) + '%'
        : null,
    };
  } catch (error) {
    console.error(`Gagal mengambil data harga untuk ${ticker}:`, error);
    return null;
  }
}

// =============================================================
// 🤖 FUNGSI: Ambil ringkasan AI dari Gemini
// =============================================================
async function getAiAnalysis(assetName, isCrypto) {
  let prompt = isCrypto
    ? `Berikan ringkasan singkat (maksimal 2 kalimat) mengenai sentimen pasar dan volatilitas terkini untuk aset crypto ${assetName}.`
    : `Berikan ringkasan singkat (maksimal 2 kalimat) mengenai sentimen pasar terkini untuk saham ${assetName}.`;

  try {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [GOOGLE_SEARCH_TOOL]
    };

    const res = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) return "Analisis AI tidak tersedia.";
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada analisis.";
  } catch (e) {
    console.error("Gagal mendapatkan analisis AI:", e);
    return "Gagal memuat analisis AI.";
  }
}

// =============================================================
// 🔁 MESIN SCRAPER (dijalankan otomatis setiap jam)
// =============================================================
async function runAnalysisEngine() {
  console.log(`[${new Date().toLocaleString('id-ID')}] Menjalankan analisis otomatis...`);
  for (const ticker of ALL_CRON_TICKERS) {
    const isCrypto = ticker.endsWith('-USD');
    const data = await getAssetPriceData(ticker);
    if (!data) continue;

    const aiSummary = await getAiAnalysis(data.shortName, isCrypto);
    const finalData = {
      ...data,
      aiAnalysis: aiSummary,
      lastUpdated: new Date().toISOString()
    };

    try {
      const path = `stock_analysis/${ticker.replace('.', '_').replace('-', '_')}`;
      await set(ref(database, path), finalData);
      console.log(`✅ ${ticker} berhasil disimpan ke Firebase.`);
    } catch (error) {
      console.error(`❌ Gagal menyimpan ${ticker}:`, error);
    }
  }
  console.log("Siklus analisis selesai.\n");
}

// =============================================================
// 🌐 ENDPOINT API
// =============================================================

// Ambil data 1 simbol (real-time)
app.get("/api/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const isCrypto = symbol.endsWith('-USD');
  const priceData = await getAssetPriceData(symbol);

  if (!priceData) {
    return res.status(404).json({ error: `Data tidak ditemukan: ${symbol}` });
  }

  const aiSummary = await getAiAnalysis(priceData.shortName, isCrypto);
  res.json({
    ...priceData,
    aiAnalysis: aiSummary
  });
});

// Tes koneksi
app.get("/", (req, res) => {
  res.send("✅ Server Scraper & Gemini Proxy aktif!");
});

// =============================================================
// ⏱️ JADWAL OTOMATIS + MULAI SERVER
// =============================================================
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  runAnalysisEngine(); // Jalankan langsung saat start
  cron.schedule('0 * * * *', runAnalysisEngine); // Setiap 1 jam
});
