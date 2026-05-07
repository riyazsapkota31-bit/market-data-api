// fetch-prices.js – Forex: Twelve Data | Crypto: CoinGecko | Commodities: Binance Futures | DXY: Finnhub
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

function writeFile(file, data, error = null) {
    const output = error ? { error: error.message, timestamp: new Date().toISOString() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ------------------------------------------------------------
// 1. Binance Futures – Commodities (5‑min candles, 100 points)
// ------------------------------------------------------------
async function fetchBinanceFutures(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`;
        const klines = await fetchJSON(url);
        const closes = klines.map(k => parseFloat(k[4]));
        if (!closes.length) throw new Error('No klines');
        const currentPrice = closes[closes.length - 1];
        writeFile(file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'Binance Futures (5m)' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// 2. CoinGecko – Crypto (daily candles, 100 days)
// ------------------------------------------------------------
async function fetchCoinGecko(id, file) {
    try {
        const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=100&interval=daily`;
        const data = await fetchJSON(url);
        const prices = data.prices;
        if (!prices || prices.length === 0) throw new Error('No price data');
        const closes = prices.map(p => p[1]); // second element is price
        const currentPrice = closes[closes.length - 1];
        writeFile(file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'CoinGecko (daily)' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// 3. Twelve Data – Forex (daily candles, 100 points – reliable on free tier)
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
            const url = `https://api.twelvedata.com/time_series?symbol=${pair.symbol}&interval=1day&outputsize=100&apikey=${TWELVE_KEY}`;
            const data = await fetchJSON(url);
            if (!data.values || data.values.length === 0) throw new Error('No data');
            const closes = data.values.map(v => parseFloat(v.close));
            const currentPrice = closes[0];
            writeFile(pair.file, { currentPrice, history: closes, timestamp: new Date().toISOString(), source: 'Twelve Data (1d)' });
        } catch (err) {
            writeFile(pair.file, null, err);
        }
    }
}

// ------------------------------------------------------------
// 4. Finnhub – DXY (current price only, enough for filter)
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
        writeFile('dxy', { currentPrice: price, history: [price], timestamp: new Date().toISOString(), source: 'Finnhub' });
    } catch (err) {
        writeFile('dxy', null, err);
    }
}

// ------------------------------------------------------------
// Main – parallel execution
// ------------------------------------------------------------
async function main() {
    console.log('--- Starting data sync ---');
    await Promise.allSettled([
        fetchBinanceFutures('XAUUSDT', 'xauusd'),
        fetchBinanceFutures('XAGUSDT', 'xagusd'),
        fetchBinanceFutures('CLUSDT', 'wtiusd'),   // WTI Oil
        fetchCoinGecko('bitcoin', 'btcusd'),
        fetchCoinGecko('ethereum', 'ethusd'),
        fetchTwelveDataForex(),
        fetchDXY()
    ]);
    console.log('--- Data sync finished ---');
}

main().catch(err => console.error('Fatal error:', err));
