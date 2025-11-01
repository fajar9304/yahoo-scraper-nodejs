// === ANALISAHAMKU v3 ===
// Full Stable Build: Scraper Saham + Crypto + AI Analysis + KeepAlive

import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

// --- KONFIGURASI FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyCCV7FD5FQqVW1WnP-Zu6UWAhAz19dthso",
  authDomain: "analisahamku.firebaseapp.com",
  projectId: "analisahamku",
  storageBucket: "analisahamku.appspot.com",
  messagingSenderId: "503947258604",
  appId: "1:503947258604:web:f5b10c998ce395405413c9",
  databaseURL:
    "https://analisahamku-default-rtdb.asia-southeast1.firebasedatabase.app",
};

const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = "gemini-pro";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// --- LIST SAHAM & KRIPTO ---
const STOCK_TICKERS = ["BBCA.JK", "BBRI.JK", "TLKM.JK"];
const CRYPTO_TICKERS = ["BTC-USD", "ETH-USD"];
const ALL_TICKERS = [...STOCK_TICKERS, ...CRYPTO_TICKERS];

// --- INISIALISASI SERVER & FIREBASE ---
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// --- UTILS ---
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- SCRAPER YAHOO FINANCE ---
async function getAssetPriceData(ticker) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=price`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn(`[WARNING] Yahoo API gagal: ${ticker}`);
      return null;
    }

    const json = await res.json();
    const result = json?.quoteSummary?.result?.[0]?.price;
    if (!result) return null;

    return {
      symbol: result.symbol,
      shortName: result.shortName || result.longName || result.symbol,
      currency: result.currency,
      regularMarketPrice: result.regularMarketPrice?.raw ?? null,
      regularMarketChangePercent: result.regularMarketChangePercent?.fmt ?? null,
    };
  } catch (e) {
    console.error(`[ERROR] Fetch harga gagal untuk ${ticker}:`, e);
    return null;
  }
}

// --- ANALISIS AI (GEMINI) ---
async function getAiAnalysis(name, isCrypto) {
  const prompt = isCrypto
    ? `Ringkas sentimen pasar terkini untuk aset kripto ${name} (maksimal 2 kalimat).`
    : `Ringkas sentimen pasar terkini untuk saham ${name} (maksimal 2 kalimat).`;

  try {
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    const res = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[AI SKIP] ${name} gagal dianalisis.`);
      return `Analisis AI tidak tersedia untuk ${name}.`;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || `Analisis AI tidak tersedia untuk ${name}.`;
  } catch (e) {
    console.error(`[AI ERROR] ${name}:`, e);
    return `Gagal memuat analisis untuk ${name}.`;
  }
}

// --- ENGINE UTAMA ---
async function runAnalysisEngine() {
  console.log(
    `[${new Date().toLocaleString(
      "id-ID"
    )}] 🚀 Memulai analisis otomatis saham & crypto...`
  );

  for (const ticker of ALL_TICKERS) {
    const isCrypto = ticker.endsWith("-USD");
    const data = await getAssetPriceData(ticker);
    if (!data) {
      console.warn(`[SKIP] Data tidak ditemukan: ${ticker}`);
      continue;
    }

    const aiText = await getAiAnalysis(data.shortName, isCrypto);
    const combined = {
      ...data,
      aiAnalysis: aiText,
      lastUpdated: new Date().toISOString(),
    };

    try {
      const path = `stock_analysis/${ticker
        .replace(".", "_")
        .replace("-", "_")}`;
      await set(ref(db, path), combined);
      console.log(`✅ ${ticker} berhasil disimpan ke Firebase.`);
    } catch (err) {
      console.error(`❌ Gagal menyimpan ${ticker}:`, err.message);
    }

    await delay(2500); // beri jeda antar permintaan AI
  }

  console.log("✅ Siklus analisis selesai.\n");
}

// --- API REALTIME ---
app.get("/api/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const isCrypto = symbol.endsWith("-USD");

  const price = await getAssetPriceData(symbol);
  if (!price)
    return res.status(404).json({ error: `Data tidak ditemukan: ${symbol}` });

  const ai = await getAiAnalysis(price.shortName, isCrypto);
  res.json({
    ...price,
    aiAnalysis: ai,
    lastUpdated: new Date().toISOString(),
  });
});

// --- KEEP ALIVE UNTUK RENDER ---
setInterval(() => {
  fetch("https://stock-api-server-28ng.onrender.com/")
    .then(() => console.log("[PING] Render server tetap aktif"))
    .catch(() => console.log("[PING] Gagal menjaga koneksi aktif."));
}, 12 * 60 * 1000); // setiap 12 menit

// --- START SERVER ---
app.get("/", (req, res) =>
  res.send("✅ Server Analisa Saham & Crypto v3 Aktif!")
);

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  runAnalysisEngine(); // langsung jalan sekali
  cron.schedule("0 * * * *", runAnalysisEngine); // jalan tiap jam
  console.log("Penjadwal analisis aktif (tiap jam).");
});
