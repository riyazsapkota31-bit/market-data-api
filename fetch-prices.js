// fetch-prices.js – Binance (corrected symbols) + Finnhub DXY
const fs = require('fs');
const path = require('path');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) console.warn('⚠️ FINNHUB_API_KEY missing – DXY will be skipped');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Helper: fetch with timeout
async function fetchJSON(url, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// Helper: write output or error file
function writeResult(file, data, error = null) {
    const output = error ? { error: error.message, timestamp: new Date().toISOString() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ------------------------------------------------------------
// 1. Binance Spot (crypto, PAXG for gold/silver)
// ------------------------------------------------------------
async function fetchBinanceSpot(symbol, file) {
    try {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
        const data = await fetchJSON(url);
        const price = parseFloat(data.price);
        if (isNaN(price)) throw new Error('Invalid price');
        writeResult(file, { price, timestamp: new Date().toISOString(), source: 'Binance Spot' });
    } catch (err) {
        writeResult(file, null, err);
    }
}

// ------------------------------------------------------------
// 2. Binance Futures (forex, oil)
// ------------------------------------------------------------
async function fetchBinanceFutures(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
        const data = await fetchJSON(url);
        const price = parseFloat(data.price);
        if (isNaN(price)) throw new Error('Invalid price');
        writeResult(file, { price, timestamp: new Date().toISOString(), source: 'Binance Futures' });
    } catch (err) {
        writeResult(file, null, err);
    }
}

// ------------------------------------------------------------
// 3. Finnhub DXY
// ------------------------------------------------------------
async function fetchDXY() {
    if (!FINNHUB_KEY) {
        writeResult('dxy', null, new Error('No FINNHUB_API_KEY'));
        return;
    }
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=DX-Y.NYB&token=${FINNHUB_KEY}`;
        const data = await fetchJSON(url);
        const price = data.c;
        if (!price) throw new Error('No price');
        writeResult('dxy', {
            price, open: data.o, high: data.h, low: data.l, change: data.dp,
            timestamp: new Date().toISOString(), source: 'Finnhub'
        });
    } catch (err) {
        writeResult('dxy', null, err);
    }
}

// ------------------------------------------------------------
// Main – run all fetches (each writes its own file)
// ------------------------------------------------------------
async function main() {
    // Correct symbols:
    // Spot: BTCUSDT, ETHUSDT, PAXGUSDT (tracks gold)
    // Futures: EURUSDT, GBPUSDT, CL (WTI Crude Oil)
    await Promise.allSettled([
        fetchBinanceSpot('BTCUSDT', 'btcusd'),
        fetchBinanceSpot('ETHUSDT', 'ethusd'),
        fetchBinanceSpot('PAXGUSDT', 'xauusd'),
        fetchBinanceSpot('PAXGUSDT', 'xagusd'),   // same token for silver proxy
        fetchBinanceFutures('EURUSDT', 'eurusd'),
        fetchBinanceFutures('GBPUSDT', 'gbpusd'),
        fetchBinanceFutures('CL', 'wtiusd'),      // WTI Crude Oil on Binance Futures
        fetchDXY()
    ]);
    console.log('--- Data update finished ---');
}

main().catch(err => console.error('Fatal error:', err));
