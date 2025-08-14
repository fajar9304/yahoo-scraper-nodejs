// Backend Terpadu - Versi ES Modules
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

const STOCK_TICKERS_FOR_CRON = ['BBCA.JK', 'BBRI.JK', 'TLKM.JK', 'GOTO.JK'];
const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

// --- INISIALISASI ---

const app = express();
const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

app.use(cors());

// --- FUNGSI-FUNGSI ---

async function getStockPriceData(ticker) {
    try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!response.ok) return null;
        const json = await response.json();
        const result = json?.quoteSummary?.result?.[0]?.price;
        if (!result) return null;
        return {
            symbol: result.symbol,
            shortName: result.shortName || result.longName,
            currency: result.currency,
            regularMarketPrice: result.regularMarketPrice?.fmt ?? null,
            regularMarketChangePercent: result.regularMarketChangePercent?.fmt ?? null,
        };
    } catch (error) {
        console.error(`Gagal mengambil data harga untuk ${ticker}:`, error);
        return null;
    }
}

async function getAiAnalysis(stockName) {
    try {
        const prompt = `Berikan ringkasan singkat (maksimal 2 kalimat) mengenai sentimen pasar saat ini untuk saham ${stockName}.`;
        const payload = { contents: [{ parts: [{ text: prompt }] }] };
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) return "Analisis AI tidak tersedia.";
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada analisis.";
    } catch (error) {
        console.error(`Gagal mendapatkan analisis AI untuk ${stockName}:`, error);
        return "Gagal memuat analisis AI.";
    }
}

async function runAnalysisEngine() {
    console.log(`[${new Date().toLocaleString('id-ID')}] Memulai mesin analis...`);
    for (const ticker of STOCK_TICKERS_FOR_CRON) {
        const priceData = await getStockPriceData(ticker);
        if (!priceData) continue;
        const aiSummary = await getAiAnalysis(priceData.shortName);
        const combinedData = { ...priceData, aiAnalysis: aiSummary, lastUpdated: new Date().toISOString() };
        try {
            const dbRef = ref(database, 'stock_analysis/' + ticker.replace('.', '_'));
            await set(dbRef, combinedData);
            console.log(`Data untuk ${ticker} berhasil disimpan.`);
        } catch (error) {
            console.error(`Gagal menyimpan data ${ticker}:`, error);
        }
    }
    console.log("Siklus analisis selesai.");
}

// --- SERVER API REAL-TIME ---

app.get("/api/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?region=US&lang=en-US`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Yahoo API error: ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.get("/", (req, res) => {
  res.send("Server API dan Penganalisis Saham Aktif! 🚀");
});

// --- PENJADWALAN & SERVER START ---

app.listen(PORT, () => {
    console.log(`Server terpadu berjalan di port ${PORT}`);
    runAnalysisEngine();
    cron.schedule('0 * * * *', runAnalysisEngine);
    console.log("Penjadwal analisis aktif.");
});
