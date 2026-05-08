// fetch-prices.js – Multi‑source data fetcher
// Sources:
//   Forex (EUR/USD, GBP/USD) → Frankfurter (daily rates, free, no key)
//   Gold, Silver → Gramvey (current price, free, no key)
//   WTI Oil → CommodityPriceAPI (current price, free demo, no key)
//   Crypto (BTC, ETH) → CoinGecko (5‑min OHLCV candles, free, no key)
//   DXY → Twelve Data (5‑min candles, requires free API key)
const fs = require('fs');
const path = require('path');

const TWELVE_KEY = process.env.TWELVE_DATA_KEY;   // required only for DXY
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
    const output = error ? { error: error.message, timestamp: Date.now() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ------------------------------------------------------------
// 1. Forex – Frankfurter (daily rates, free, no key)
// Returns current price (latest rate). History will be built by frontend.
// ------------------------------------------------------------
async function fetchForexFrankfurter(base, file) {
    try {
        // Get the latest rate (today's rate)
        const url = `https://api.frankfurter.dev/v1/latest?base=${base}`;
        const data = await fetchJSON(url);
        const target = file === 'eurusd' ? 'USD' : 'USD';
        const price = data.rates?.[target];
        if (!price) throw new Error(`No rate for ${base}/${target}`);
        writeFile(file, {
            currentPrice: price,
            timestamp: Date.now(),
            source: 'Frankfurter'
        });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// 2. Gold & Silver – Gramvey (current price only, free, no key)
// ------------------------------------------------------------
async function fetchGramvey(symbol, file) {
    try {
        const url = `https://goldapi.gramvey.com/golds/${symbol}/?currency=USD`;
        const data = await fetchJSON(url);
        const price = data.price;
        if (!price) throw new Error('No price');
        writeFile(file, {
            currentPrice: price,
            timestamp: Date.now(),
            source: 'Gramvey'
        });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// 3. WTI Oil – CommodityPriceAPI (current price, free demo, no key)
// ------------------------------------------------------------
async function fetchOil() {
    try {
        const url = 'https://commoditypriceapi.com/api/latest?commodity=crude_oil&apikey=demo';
        const data = await fetchJSON(url);
        const price = data.rates?.USD;
        if (!price) throw new Error('No oil price');
        writeFile('wtiusd', {
            currentPrice: price,
            timestamp: Date.now(),
            source: 'CommodityPriceAPI'
        });
    } catch (err) {
        writeFile('wtiusd', null, err);
    }
}

// ------------------------------------------------------------
// 4. Crypto – CoinGecko (5‑minute OHLCV candles, provides history array)
// ------------------------------------------------------------
async function fetchCrypto(id, file) {
    try {
        const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=7&interval=5minute`;
        const data = await fetchJSON(url);
        if (!data || data.length === 0) throw new Error('No data');
        const closes = data.map(c => c[4]); // close price
        const currentPrice = closes[0];
        writeFile(file, {
            currentPrice,
            history: closes,
            timestamp: Date.now(),
            source: 'CoinGecko (5min)'
        });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ------------------------------------------------------------
// 5. DXY – Twelve Data (5‑minute candles, requires API key)
// ------------------------------------------------------------
async function fetchDXY() {
    if (!TWELVE_KEY) {
        writeFile('dxy', null, new Error('No Twelve Data key'));
        return;
    }
    try {
        const url = `https://api.twelvedata.com/time_series?symbol=DXY&interval=5min&outputsize=100&apikey=${TWELVE_KEY}`;
        const data = await fetchJSON(url);
        if (!data.values || data.values.length === 0) throw new Error('No data');
        const closes = data.values.map(v => parseFloat(v.close));
        const currentPrice = closes[0];
        writeFile('dxy', {
            currentPrice,
            history: closes,
            timestamp: Date.now(),
            source: 'Twelve Data (5min)'
        });
    } catch (err) {
        writeFile('dxy', null, err);
    }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
    console.log('--- Fetching market data ---');
    await Promise.allSettled([
        fetchForexFrankfurter('EUR', 'eurusd'),
        fetchForexFrankfurter('GBP', 'gbpusd'),
        fetchGramvey('XAUUSD', 'xauusd'),
        fetchGramvey('XAGUSD', 'xagusd'),
        fetchOil(),
        fetchCrypto('bitcoin', 'btcusd'),
        fetchCrypto('ethereum', 'ethusd'),
        fetchDXY()
    ]);
    console.log('--- Data sync finished ---');
}

main().catch(err => console.error('Fatal error:', err));
