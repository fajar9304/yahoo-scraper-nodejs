import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, remove } from 'firebase/database'; // Import remove
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

// Tambahkan beberapa ticker Kripto untuk penjadwalan
const STOCK_TICKERS_FOR_CRON = ['BBCA.JK', 'BBRI.JK', 'TLKM.JK'];
const CRYPTO_TICKERS_FOR_CRON = ['BTC-USD', 'ETH-USD']; // Ticker Crypto
const ALL_CRON_TICKERS = [...STOCK_TICKERS_FOR_CRON, ...CRYPTO_TICKERS_FOR_CRON]; // Gabungkan

// PENTING: Ganti dengan GEMINI API KEY Anda yang sesungguhnya (jika ini production code)
const GEMINI_API_KEY = "AIzaSyDWDY9e36xDuNdtd36DCSloDqO5zwvq_8w";
const GEMINI_MODEL = 'gemini-pro'; // Menggunakan gemini-pro untuk analisis mendalam
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const GOOGLE_SEARCH_TOOL = { "google_search": {} };


// --- INISIALISASI ---

const app = express();
const PORT = process.env.PORT || 3000;
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

app.use(cors());
app.use(express.json()); // Middleware untuk parsing JSON di proxy Gemini

// --- FUNGSI-FUNGSI ---

// MODIFIED: Mendukung Saham (.JK) dan Kripto (-USD)
async function getAssetPriceData(ticker) {
    try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!response.ok) return null;
        const json = await response.json();
        const result = json?.quoteSummary?.result?.[0]?.price;
        
        if (!result) {
            console.warn(`[WARNING] Data harga kosong untuk ticker: ${ticker}`);
            return null;
        }
        
        return {
            symbol: result.symbol,
            // shortName untuk crypto lebih spesifik, misal 'Bitcoin USD'
            shortName: result.shortName || result.longName || result.symbol,
            currency: result.currency,
            // Format price: jika crypto, harga bisa sangat besar. Simpan sebagai angka (raw)
            regularMarketPrice: result.regularMarketPrice?.raw ?? null, 
            regularMarketChangePercent: result.regularMarketChangePercent?.fmt ?? null,
        };
    } catch (error) {
        console.error(`Gagal mengambil data harga untuk ${ticker}:`, error);
        return null;
    }
}

async function getAiAnalysis(assetName, isCrypto) {
    let prompt;
    if (isCrypto) {
        prompt = `Berikan ringkasan singkat (maksimal 2 kalimat) mengenai sentimen pasar dan volatilitas saat ini untuk aset crypto ${assetName}.`;
    } else {
        prompt = `Berikan ringkasan singkat (maksimal 2 kalimat) mengenai sentimen pasar saat ini untuk saham ${assetName}.`;
    }

    try {
        const payload = { 
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ "google_search": {} }] // Tambahkan Google Search Tool untuk AI
        };
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) return "Analisis AI tidak tersedia.";
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada analisis.";
    } catch (error) {
        console.error(`Gagal mendapatkan analisis AI untuk ${assetName}:`, error);
        return "Gagal memuat analisis AI.";
    }
}

async function runAnalysisEngine() {
    console.log(`[${new Date().toLocaleString('id-ID')}] Memulai mesin analis (Saham & Kripto)...`);
    
    for (const ticker of ALL_CRON_TICKERS) {
        const isCrypto = ticker.endsWith('-USD');
        const priceData = await getAssetPriceData(ticker);
        
        if (!priceData) continue;
        
        const aiSummary = await getAiAnalysis(priceData.shortName, isCrypto);
        
        // Simpan harga asli (raw) untuk perhitungan di frontend
        const combinedData = { 
            ...priceData, 
            regularMarketPrice: priceData.regularMarketPrice, // Nilai Raw (angka)
            aiAnalysis: aiSummary, 
            lastUpdated: new Date().toISOString() 
        };
        
        try {
            const dbRef = ref(database, 'stock_analysis/' + ticker.replace('.', '_').replace('-', '_')); // Path aman untuk Firebase
            await set(dbRef, combinedData);
            console.log(`Data untuk ${ticker} berhasil disimpan.`);
        } catch (error) {
            console.error(`Gagal menyimpan data ${ticker}:`, error);
        }
    }
    console.log("Siklus analisis selesai.");
}

// --- SERVER API REAL-TIME ---

// MODIFIED: Endpoint lama diubah untuk menggunakan fungsi getAssetPriceData dan memanggil AI
app.get("/api/:symbol", async (req, res) => {
    const { symbol } = req.params;
    
    // Asumsi: frontend mengirim 'BBCA.JK' atau 'BTC-USD'
    const isCrypto = symbol.endsWith('-USD');

    // 1. Ambil Data Harga (Price)
    const priceData = await getAssetPriceData(symbol);
    
    if (!priceData) {
        // Fallback ke Yahoo Chart API (khusus untuk grafik yang membutuhkan format tertentu)
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?region=US&lang=en-US`;
            const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!response.ok) {
                 return res.status(404).json({ error: `Aset tidak ditemukan atau API tidak merespon untuk: ${symbol}` });
            }
            const data = await response.json();
            
            // Tambahkan harga terbaru dari meta jika ada (untuk frontend)
            const latestPrice = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
            const companyName = data?.chart?.result?.[0]?.meta?.instrumentDisplayName || symbol;
            
            return res.json({ 
                ...data,
                regularMarketPrice: latestPrice,
                companyName: companyName,
                aiAnalysis: "Analisis AI tidak tersedia dalam mode chart." // Kosongkan analisis untuk respons ini
            });

        } catch(e) {
             return res.status(500).json({ error: "Terjadi kesalahan server saat mengambil data chart." });
        }
    }
    
    // 2. Ambil Analisis AI (Summary)
    const aiSummary = await getAiAnalysis(priceData.shortName, isCrypto);
    
    // 3. Gabungkan dan kembalikan data yang mudah dicerna oleh frontend
    const finalResult = {
        ...priceData,
        regularMarketPrice: priceData.regularMarketPrice, // Nilai Raw (angka)
        companyName: priceData.shortName,
        aiAnalysis: aiSummary,
        // Tambahkan properti chart kosong untuk kompatibilitas frontend
        chart: { result: [{ meta: { regularMarketPrice: priceData.regularMarketPrice, instrumentDisplayName: priceData.shortName } }] }
    };

    res.json(finalResult);
});

// --- API Endpoint PROXY GEMINI untuk aplikasi frontend ---
app.post('/api/gemini-proxy', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    const { prompt, schema } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required.' });
    }

    let payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: {
             parts: [{ text: "Anda adalah analis saham dan keuangan profesional. Berikan respon yang akurat, berdasarkan data real-time jika memungkinkan, dan patuhi JSON schema yang diberikan." }]
        }
    };

    // Logika penambahan Tool (Google Search) atau Schema (Structured Output)
    if (schema) {
        try {
            payload.generationConfig = {
                responseMimeType: "application/json",
                responseSchema: JSON.parse(schema), 
            };
            // JANGAN tambahkan TOOLS jika ada schema, karena sering konflik dengan output JSON
            // Jika Anda ingin grounding, Anda harus memprioritaskan JSON, dan AI akan mencoba menggunakan pengetahuan terkini tanpa tools eksplisit.
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON schema format.' });
        }
    } else {
        // Jika TIDAK ADA skema, tambahkan Google Search Tool untuk mencari data bebas
        payload.tools = [GOOGLE_SEARCH_TOOL];
    }

    // Melakukan Panggilan Aman ke Gemini API
    try {
        const geminiResponse = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!geminiResponse.ok) {
            const errorDetails = await geminiResponse.text();
            console.error("Gemini API Error:", errorDetails);
            return res.status(geminiResponse.status).json({ 
                error: 'Gemini API call failed', 
                details: errorDetails 
            });
        }
        
        const geminiResult = await geminiResponse.json();
        const textData = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textData) {
            console.error("Gemini response structure invalid or empty:", geminiResult);
            // Cek jika ada alasan penolakan (e.g. blokir keamanan)
            const rejectionReason = geminiResult.promptFeedback?.blockReason || 'Unknown';
            return res.status(500).json({ error: `Gemini API call failed: Empty content (Blocked: ${rejectionReason}).` });
        }
        
        res.json({ text: textData });

    } catch (error) {
        console.error("Error during Gemini proxy operation:", error);
        res.status(500).json({ error: 'Internal server error during API call.' });
    }
});


app.get("/", (req, res) => {
    res.send("Server API dan Penganalisis Saham & Kripto Aktif! 🚀");
});

// --- PENJADWALAN & SERVER START ---

app.listen(PORT, () => {
    console.log(`Server terpadu berjalan di port ${PORT}`);
    
    // Jalankan sekali saat start
    runAnalysisEngine(); 
    
    // Penjadwalan: Setiap jam (sesuai setting lama Anda)
    cron.schedule('0 * * * *', runAnalysisEngine); 
    console.log("Penjadwal analisis aktif (setiap jam).");
});
