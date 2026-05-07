// fetch-prices.js – fixed symbols + detailed error logging
const fs = require('fs');
const path = require('path');

const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

async function fetchJSON(url, timeout = 10000) {
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

function writeError(file, err) {
    const output = { error: err.message, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    console.error(`✗ ${file}: ${err.message}`);
}

function writeSuccess(file, data) {
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(data, null, 2));
    console.log(`✓ ${file} updated`);
}

// ------------------------------------------------------------
// Binance Futures – commodities (5‑min candles)
// ------------------------------------------------------------
async function fetchBinanceFuturesKlines(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`;
        const klines = await fetchJSON(url);
        const closes = klines.map(k => parseFloat(k[4]));
        if (!closes.length) throw new Error('No klines data');
        const currentPrice = closes[closes.length - 1];
        writeSuccess(file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'Binance Futures' });
    } catch (err) {
        writeError(file, err);
    }
}

// ------------------------------------------------------------
// Binance Spot – crypto (5‑min candles)
// ------------------------------------------------------------
async function fetchBinanceSpotKlines(symbol, file) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;
        const klines = await fetchJSON(url);
        const closes = klines.map(k => parseFloat(k[4]));
        if (!closes.length) throw new Error('No klines data');
        const currentPrice = closes[closes.length - 1];
        writeSuccess(file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'Binance Spot' });
    } catch (err) {
        writeError(file, err);
    }
}

// ------------------------------------------------------------
// Twelve Data – forex (daily candles – more reliable on free tier)
// ------------------------------------------------------------
async function fetchTwelveDataForex() {
    if (!TWELVE_KEY) {
        writeError('eurusd', new Error('No Twelve Data key'));
        writeError('gbpusd', new Error('No Twelve Data key'));
        return;
    }
    const pairs = [
        { symbol: 'EUR/USD', file: 'eurusd' },
        { symbol: 'GBP/USD', file: 'gbpusd' }
    ];
    for (const pair of pairs) {
        try {
            // Use daily candles (free tier works better)
            const url = `https://api.twelvedata.com/time_series?symbol=${pair.symbol}&interval=1day&outputsize=100&apikey=${TWELVE_KEY}`;
            const data = await fetchJSON(url);
            if (!data.values || data.values.length === 0) throw new Error('No data');
            const closes = data.values.map(v => parseFloat(v.close));
            const currentPrice = closes[0];
            writeSuccess(pair.file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'Twelve Data (1d)' });
        } catch (err) {
            writeError(pair.file, err);
        }
    }
}

// ------------------------------------------------------------
// Finnhub DXY
// ------------------------------------------------------------
async function fetchDXY() {
    if (!FINNHUB_KEY) {
        writeError('dxy', new Error('No Finnhub key'));
        return;
    }
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=DX-Y.NYB&token=${FINNHUB_KEY}`;
        const data = await fetchJSON(url);
        const price = data.c;
        if (!price) throw new Error('No price');
        writeSuccess('dxy', { currentPrice: price, history: [price], timestamp: new Date().toISOString(), source: 'Finnhub' });
    } catch (err) {
        writeError('dxy', err);
    }
}

// ------------------------------------------------------------
// Main – run all fetches
// ------------------------------------------------------------
async function main() {
    console.log('--- Starting data sync ---');
    await Promise.allSettled([
        fetchBinanceFuturesKlines('XAUUSDT', 'xauusd'),
        fetchBinanceFuturesKlines('XAGUSDT', 'xagusd'),
        fetchBinanceFuturesKlines('CLUSDT', 'wtiusd'),   // Fixed oil symbol
        fetchBinanceSpotKlines('BTCUSDT', 'btcusd'),
        fetchBinanceSpotKlines('ETHUSDT', 'ethusd'),
        fetchTwelveDataForex(),
        fetchDXY()
    ]);
    console.log('--- Data sync finished ---');
}

main().catch(err => console.error('Fatal error:', err));
