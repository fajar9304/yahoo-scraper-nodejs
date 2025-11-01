import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

// === KONFIGURASI FIREBASE ===
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

// === GEMINI ===
const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = "gemini-pro";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// === SAHAM & CRYPTO ===
const STOCK_TICKERS = ["BBCA.JK", "BBRI.JK", "TLKM.JK"];
const CRYPTO_TICKERS = ["BTC-USD", "ETH-USD"];
const ALL_TICKERS = [...STOCK_TICKERS, ...CRYPTO_TICKERS];

// === INISIALISASI SERVER ===
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// === UTILITAS ===
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === AMBIL DATA HARGA DARI YAHOO FINANCE ===
async function getAssetPriceData(ticker) {
  try {
    // 1️⃣ Coba ambil via quoteSummary
    const url1 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=price`;
    const r1 = await fetch(url1, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (r1.ok) {
      const j1 = await r1.json();
      const p = j1?.quoteSummary?.result?.[0]?.price;
      if (p && p.regularMarketPrice) {
        return {
          symbol: p.symbol,
          shortName: p.shortName || p.longName || p.symbol,
          currency: p.currency,
          regularMarketPrice: p.regularMarketPrice.raw,
          regularMarketChangePercent: p.regularMarketChangePercent?.fmt ?? "0%",
        };
      }
    }

    // 2️⃣ Fallback ke chart endpoint
    const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?region=US&lang=en-US`;
    const r2 = await fetch(url2, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r2.ok) return null;

    const j2 = await r2.json();
    const meta = j2?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      symbol: meta.symbol,
      shortName: meta.instrumentDisplayName || meta.symbol,
      currency: meta.currency,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketChangePercent: "0.00%",
    };
  } catch (e) {
    console.error(`❌ Gagal ambil data ${ticker}:`, e);
    return null;
  }
}

// === ANALISIS AI (GEMINI) ===
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

    if (!res.ok) return `Analisis AI tidak tersedia untuk ${name}.`;

    const data = await res.json();
    return (
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      `Analisis AI tidak tersedia untuk ${name}.`
    );
  } catch (e) {
    console.error(`[AI ERROR] ${name}:`, e);
    return `Gagal memuat analisis untuk ${name}.`;
  }
}

// === MESIN UTAMA ===
async function runAnalysisEngine() {
  console.log(
    `[${new Date().toLocaleString()}] 🚀 Memulai analisis otomatis...`
  );

  for (const ticker of ALL_TICKERS) {
    const isCrypto = ticker.endsWith("-USD");
    const price = await getAssetPriceData(ticker);
    if (!price) {
      console.warn(`⚠️ Data tidak ditemukan: ${ticker}`);
      continue;
    }

    const aiText = await getAiAnalysis(price.shortName, isCrypto);
    const combined = {
      ...price,
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

    await delay(2000);
  }

  console.log("✅ Siklus analisis selesai.\n");
}

// === API REALTIME ===
app.get("/api/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const isCrypto = symbol.endsWith("-USD");
  const data = await getAssetPriceData(symbol);
  if (!data) return res.status(404).json({ error: `Data tidak ditemukan: ${symbol}` });

  const ai = await getAiAnalysis(data.shortName, isCrypto);
  res.json({ ...data, aiAnalysis: ai });
});

// === KEEP ALIVE ===
setInterval(() => {
  fetch("https://stock-api-server-28ng.onrender.com/").catch(() =>
    console.log("[PING] Render tetap hidup.")
  );
}, 12 * 60 * 1000);

// === START SERVER ===
app.get("/", (req, res) => res.send("✅ Server Scraper Saham & Crypto v3.1 aktif."));
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  runAnalysisEngine();
  cron.schedule("0 * * * *", runAnalysisEngine);
});
