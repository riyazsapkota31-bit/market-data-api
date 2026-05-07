// fetch-prices.js – 100 past 5‑minute candles for all assets
const fs = require('fs');
const path = require('path');

const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

if (!TWELVE_KEY) console.warn('⚠️ TWELVE_DATA_KEY missing – forex will be skipped');
if (!FINNHUB_KEY) console.warn('⚠️ FINNHUB_API_KEY missing – DXY will be skipped');

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

function writeFile(file, data, error = null) {
    const output = error ? { error: error.message, timestamp: new Date().toISOString() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ------------------------------------------------------------
// Binance Futures – commodities (5‑min candles)
// ------------------------------------------------------------
async function fetchBinanceFuturesKlines(symbol, file) {
    try {
        const klinesUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`;
        const klines = await fetchJSON(klinesUrl);
        const closes = klines.map(k => parseFloat(k[4])); // closing prices
        if (!closes.length) throw new Error('No klines data');
        const currentPrice = closes[closes.length - 1];
        writeFile(file, {
            currentPrice,
            history: closes,
            timestamp: new Date().toISOString(),
            source: 'Binance Futures (5m)'
        });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// Binance Spot – crypto (5‑min candles)
// ------------------------------------------------------------
async function fetchBinanceSpotKlines(symbol, file) {
    try {
        const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;
        const klines = await fetchJSON(klinesUrl);
        const closes = klines.map(k => parseFloat(k[4]));
        if (!closes.length) throw new Error('No klines data');
        const currentPrice = closes[closes.length - 1];
        writeFile(file, {
            currentPrice,
            history: closes,
            timestamp: new Date().toISOString(),
            source: 'Binance Spot (5m)'
        });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// Twelve Data – forex (5‑min time series)
// ------------------------------------------------------------
async function fetchTwelveDataForex() {
    if (!TWELVE_KEY) {
        writeFile('eurusd', null, new Error('No Twelve Data key'));
        writeFile('gbpusd', null, new Error('No Twelve Data key'));
        return;
    }
    const pairs = [
        { symbol: 'EUR/USD', file: 'eurusd' },
        { symbol: 'GBP/USD', file: 'gbpusd' }
    ];
    for (const pair of pairs) {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${pair.symbol}&interval=5min&outputsize=100&apikey=${TWELVE_KEY}`;
            const data = await fetchJSON(url);
            if (!data.values || data.values.length === 0) throw new Error('No data');
            const closes = data.values.map(v => parseFloat(v.close));
            const currentPrice = closes[0];
            writeFile(pair.file, {
                currentPrice,
                history: closes,
                timestamp: new Date().toISOString(),
                source: 'Twelve Data (5min)'
            });
        } catch (err) {
            writeFile(pair.file, null, err);
        }
    }
}

// ------------------------------------------------------------
// Finnhub DXY – only current price (historical not needed)
// ------------------------------------------------------------
async function fetchDXY() {
    if (!FINNHUB_KEY) {
        writeFile('dxy', null, new Error('No Finnhub key'));
        return;
    }
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=DX-Y.NYB&token=${FINNHUB_KEY}`;
        const data = await fetchJSON(url);
        const price = data.c;
        if (!price) throw new Error('No price');
        writeFile('dxy', {
            currentPrice: price,
            history: [price], // placeholder
            timestamp: new Date().toISOString(),
            source: 'Finnhub'
        });
    } catch (err) {
        writeFile('dxy', null, err);
    }
}

// ------------------------------------------------------------
// Main – run all fetches in parallel
// ------------------------------------------------------------
async function main() {
    await Promise.allSettled([
        fetchBinanceFuturesKlines('XAUUSDT', 'xauusd'),
        fetchBinanceFuturesKlines('XAGUSDT', 'xagusd'),
        fetchBinanceFuturesKlines('CL', 'wtiusd'),
        fetchBinanceSpotKlines('BTCUSDT', 'btcusd'),
        fetchBinanceSpotKlines('ETHUSDT', 'ethusd'),
        fetchTwelveDataForex(),
        fetchDXY()
    ]);
    console.log('--- Data update finished ---');
}

main().catch(err => console.error('Fatal error:', err));
