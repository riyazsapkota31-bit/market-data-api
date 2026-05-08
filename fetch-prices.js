// fetch-prices.js – v6.0 (Final)
// Builds 5‑minute candles for all assets from minute snapshots.
// Sources:
//   Forex: Frankfurter (free, no key)
//   Crypto: CoinGecko (free, no key)
//   Gold, Silver, Oil, DXY: Yahoo Finance via public proxy (free, no key)
// Every minute (triggered by cron-job.org), it fetches current prices,
// aggregates into 5‑minute buckets, and writes completed candles to JSON files.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Helper: fetch JSON with timeout
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

// Yahoo Finance via public CORS proxy (no key)
async function fetchYahooPrice(symbol) {
    const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    const proxy = 'https://api.allorigins.win/raw?url=';
    const data = await fetchJSON(proxy + encodeURIComponent(directUrl));
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('No chart data');
    const quotes = result.indicators.quote[0];
    const closes = quotes.close.filter(c => c !== null);
    if (closes.length === 0) throw new Error('No price');
    return closes[closes.length - 1]; // latest price
}

// ------------------------------------------------------------------
// Generic candle builder (works for any asset)
// ------------------------------------------------------------------
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
    history.history.unshift(candle.close);
    if (history.history.length > 100) history.history.pop();
    history.currentPrice = candle.close;
    history.timestamp = Date.now();
    history.source = 'Built 5min candle';
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

// Process a single asset with a function that returns current price
async function processAsset(name, priceFetcher) {
    try {
        const price = await priceFetcher();
        if (price === undefined || price === null) throw new Error('No price');

        const now = Date.now();
        const minute = Math.floor(now / 60000);
        const current5minBucket = Math.floor(minute / 5);

        let state = loadCandleState(name);
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
                appendCandleToHistory(name, completedCandle);
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
        saveCandleState(name, state);
        console.log(`✓ ${name} price ${price}`);
    } catch (err) {
        console.error(`✗ ${name}: ${err.message}`);
    }
}

// ------------------------------------------------------------------
// Price fetchers for each asset (no keys, all free)
// ------------------------------------------------------------------
async function fetchForexPrice(base, quote) {
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
    const data = await fetchJSON(url);
    const rate = data.rates[quote];
    if (!rate) throw new Error('No rate');
    return rate;
}

async function fetchCryptoPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const data = await fetchJSON(url);
    const price = data[id]?.usd;
    if (!price) throw new Error('No price');
    return price;
}

// Yahoo symbols for commodities & DXY
const YAHOO_SYMBOLS = {
    gold: 'GC=F',
    silver: 'SI=F',
    oil: 'CL=F',
    dxy: 'DX-Y.NYB'
};

async function fetchYahooAssetPrice(symbolName) {
    const yahooSym = YAHOO_SYMBOLS[symbolName];
    if (!yahooSym) throw new Error('Unknown Yahoo symbol');
    return await fetchYahooPrice(yahooSym);
}

// ------------------------------------------------------------------
// Main – runs every minute (triggered by cron-job.org)
// ------------------------------------------------------------------
async function main() {
    console.log('--- Fetching minute snapshots for all assets ---');

    // Forex
    await processAsset('eurusd', () => fetchForexPrice('EUR', 'USD'));
    await processAsset('gbpusd', () => fetchForexPrice('GBP', 'USD'));

    // Crypto
    await processAsset('btcusd', () => fetchCryptoPrice('bitcoin'));
    await processAsset('ethusd', () => fetchCryptoPrice('ethereum'));

    // Commodities & DXY (via Yahoo)
    await processAsset('xauusd', () => fetchYahooAssetPrice('gold'));
    await processAsset('xagusd', () => fetchYahooAssetPrice('silver'));
    await processAsset('wtiusd', () => fetchYahooAssetPrice('oil'));
    await processAsset('dxy', () => fetchYahooAssetPrice('dxy'));

    console.log('--- Minute snapshots finished ---');
}

main().catch(err => console.error('Fatal error:', err));
