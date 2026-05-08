// fetch-prices.js – v4.0 (Final)
// Builds 5‑minute candles for all assets.
// Runs every minute (triggered by cron-job.org via repository_dispatch).
// Forex: built from Frankfurter minute snapshots (no key)
// DXY, Oil: Twelve Data (requires API key) – fetched every 5 minutes
// Crypto, Gold, Silver: Binance (no key) – fetched every 5 minutes
// All assets maintain rolling 100‑candle history.

const fs = require('fs');
const path = require('path');

const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// ------------------------------------------------------------------
// Helper functions
// ------------------------------------------------------------------
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
    const output = error ? { error: error.message, timestamp: Date.now() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated (${data.history?.length || 0} candles)`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ------------------------------------------------------------------
// Forex: Build 5‑minute candles from minute snapshots (Frankfurter, no key)
// ------------------------------------------------------------------
const FOREX_PAIRS = [
    { name: 'eurusd', base: 'EUR', quote: 'USD' },
    { name: 'gbpusd', base: 'GBP', quote: 'USD' }
];

function loadCandleState(file) {
    const stateFile = path.join(dataDir, `${file}_candle.json`);
    if (fs.existsSync(stateFile)) {
        try { return JSON.parse(fs.readFileSync(stateFile)); } catch(e) { return null; }
    }
    return null;
}

function saveCandleState(file, state) {
    const stateFile = path.join(dataDir, `${file}_candle.json`);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function appendCandleToHistory(file, candle) {
    const historyFile = path.join(dataDir, `${file}.json`);
    let history = { history: [] };
    if (fs.existsSync(historyFile)) {
        try { history = JSON.parse(fs.readFileSync(historyFile)); } catch(e) {}
    }
    if (!history.history) history.history = [];
    history.history.unshift(candle.close); // newest first
    if (history.history.length > 100) history.history.pop();
    history.currentPrice = candle.close;
    history.timestamp = Date.now();
    history.source = 'Frankfurter (built 5min)';
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

async function processForex() {
    for (const pair of FOREX_PAIRS) {
        try {
            const url = `https://api.frankfurter.app/latest?from=${pair.base}&to=${pair.quote}`;
            const data = await fetchJSON(url);
            const price = data.rates[pair.quote];
            if (!price) throw new Error('No price');

            const now = Date.now();
            const minute = Math.floor(now / 60000);
            const current5minBucket = Math.floor(minute / 5);

            let state = loadCandleState(pair.name);
            if (!state || state.bucket !== current5minBucket) {
                // Finalize previous candle if exists
                if (state && state.candle) {
                    const completedCandle = {
                        open: state.candle.open,
                        high: state.candle.high,
                        low: state.candle.low,
                        close: state.lastPrice,
                        timestamp: state.startTime
                    };
                    appendCandleToHistory(pair.name, completedCandle);
                }
                // Start new candle
                state = {
                    bucket: current5minBucket,
                    startTime: now,
                    candle: { open: price, high: price, low: price, close: price },
                    lastPrice: price,
                    lastTimestamp: now
                };
            } else {
                // Update current candle
                state.candle.high = Math.max(state.candle.high, price);
                state.candle.low = Math.min(state.candle.low, price);
                state.candle.close = price;
                state.lastPrice = price;
                state.lastTimestamp = now;
            }
            saveCandleState(pair.name, state);
            console.log(`✓ Forex ${pair.name} price ${price}`);
        } catch (err) {
            console.error(`✗ Forex ${pair.name}: ${err.message}`);
        }
    }
}

// ------------------------------------------------------------------
// Full fetch for other assets (run every 5 minutes)
// ------------------------------------------------------------------
let lastFullFetch = 0;
const FULL_FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Twelve Data assets (DXY, oil)
async function fetchTwelveData(symbol, file, interval = '5min') {
    if (!TWELVE_KEY) {
        writeFile(file, null, new Error('No Twelve Data key'));
        return;
    }
    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&apikey=${TWELVE_KEY}`;
        const data = await fetchJSON(url);
        if (!data.values || data.values.length === 0) throw new Error('No data');
        const history = data.values.map(v => parseFloat(v.close));
        const currentPrice = history[0];
        writeFile(file, { currentPrice, history, timestamp: Date.now(), source: `Twelve Data (${interval})` });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// Binance Spot (crypto)
async function fetchBinanceSpot(symbol, file) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;
        const data = await fetchJSON(url);
        if (!data || data.length === 0) throw new Error('No data');
        const history = data.map(candle => parseFloat(candle[4]));
        const currentPrice = history[0];
        writeFile(file, { currentPrice, history, timestamp: Date.now(), source: 'Binance Spot (5min)' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// Binance Futures (gold, silver)
async function fetchBinanceFutures(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`;
        const data = await fetchJSON(url);
        if (!data || data.length === 0) throw new Error('No data');
        const history = data.map(candle => parseFloat(candle[4]));
        const currentPrice = history[0];
        writeFile(file, { currentPrice, history, timestamp: Date.now(), source: 'Binance Futures (5min)' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

async function fullFetch() {
    console.log('--- Full fetch (5min candles) for DXY, oil, crypto, metals ---');
    await Promise.allSettled([
        fetchTwelveData('DXY', 'dxy'),
        fetchTwelveData('WTI', 'wtiusd'),
        fetchBinanceSpot('BTCUSDT', 'btcusd'),
        fetchBinanceSpot('ETHUSDT', 'ethusd'),
        fetchBinanceFutures('XAUUSDT', 'xauusd'),
        fetchBinanceFutures('XAGUSDT', 'xagusd')
    ]);
    console.log('--- Full fetch finished ---');
}

// ------------------------------------------------------------------
// Main – decides when to run full fetch
// ------------------------------------------------------------------
async function main() {
    console.log('--- Sync started ---');
    // Always process forex (minute snapshots)
    await processForex();

    // Read last full fetch time from file
    const lastFetchFile = path.join(dataDir, '.last_full_fetch');
    let now = Date.now();
    if (fs.existsSync(lastFetchFile)) {
        lastFullFetch = parseInt(fs.readFileSync(lastFetchFile, 'utf8'));
    } else {
        lastFullFetch = 0;
    }

    if (now - lastFullFetch >= FULL_FETCH_INTERVAL) {
        await fullFetch();
        lastFullFetch = now;
        fs.writeFileSync(lastFetchFile, lastFullFetch.toString());
    } else {
        const remaining = Math.round((FULL_FETCH_INTERVAL - (now - lastFullFetch)) / 1000);
        console.log(`Skipping full fetch (next in ${remaining} seconds)`);
    }
    console.log('--- Sync finished ---');
}

main().catch(err => console.error('Fatal error:', err));
