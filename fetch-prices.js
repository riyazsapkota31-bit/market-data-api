// fetch-prices.js – Hybrid: Binance (commodities) + Twelve Data (forex) + CoinGecko (crypto) + Finnhub (DXY)
const fs = require('fs');
const path = require('path');

// API keys from GitHub Secrets
const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

if (!TWELVE_KEY) console.warn('⚠️ Missing TWELVE_DATA_KEY – forex will be skipped');
if (!FINNHUB_KEY) console.warn('⚠️ Missing FINNHUB_API_KEY – DXY will be skipped');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// ---------- Helper: fetch with timeout ----------
async function fetchJSON(url, timeout = 8000) {
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

// ---------- Write file (with error placeholder) ----------
function writeFile(file, data, error = null) {
    const output = error ? { error: error.message, timestamp: new Date().toISOString() } : data;
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
    if (!error) console.log(`✓ ${file} updated`);
    else console.error(`✗ ${file}: ${error.message}`);
}

// ============================================================
// 1. Binance Futures – Commodities (Gold, Silver, Oil)
// ============================================================
async function fetchBinanceFutures(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
        const data = await fetchJSON(url);
        const price = parseFloat(data.price);
        if (isNaN(price)) throw new Error('Invalid price');
        writeFile(file, { price, timestamp: new Date().toISOString(), source: 'Binance Futures' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ============================================================
// 2. Twelve Data – Forex (batch quote)
// ============================================================
async function fetchTwelveDataForex() {
    if (!TWELVE_KEY) {
        writeFile('eurusd', null, new Error('No Twelve Data key'));
        writeFile('gbpusd', null, new Error('No Twelve Data key'));
        return;
    }
    try {
        const symbols = 'EUR/USD,GBP/USD';
        const url = `https://api.twelvedata.com/quote?symbol=${symbols}&apikey=${TWELVE_KEY}`;
        const data = await fetchJSON(url);
        for (const [sym, file] of [['EUR/USD','eurusd'], ['GBP/USD','gbpusd']]) {
            const quote = data[sym];
            if (quote && quote.close) {
                const price = parseFloat(quote.close);
                writeFile(file, { price, open: parseFloat(quote.open), high: parseFloat(quote.high), low: parseFloat(quote.low),
                    change: parseFloat(quote.percent_change), timestamp: new Date().toISOString(), source: 'Twelve Data' });
            } else {
                writeFile(file, null, new Error(`No data for ${sym}`));
            }
        }
    } catch (err) {
        writeFile('eurusd', null, err);
        writeFile('gbpusd', null, err);
    }
}

// ============================================================
// 3. CoinGecko – Crypto (no API key)
// ============================================================
async function fetchCoinGecko(id, file) {
    try {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
        const data = await fetchJSON(url);
        const price = data[id]?.usd;
        if (!price) throw new Error('No price');
        writeFile(file, { price, timestamp: new Date().toISOString(), source: 'CoinGecko' });
    } catch (err) {
        writeFile(file, null, err);
    }
}

// ============================================================
// 4. Finnhub – DXY (US Dollar Index)
// ============================================================
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
            price, open: data.o, high: data.h, low: data.l, change: data.dp,
            timestamp: new Date().toISOString(), source: 'Finnhub'
        });
    } catch (err) {
        writeFile('dxy', null, err);
    }
}

// ============================================================
// Main – run all fetches in parallel
// ============================================================
async function main() {
    await Promise.allSettled([
        // Commodities (Binance Futures)
        fetchBinanceFutures('XAUUSDT', 'xauusd'),
        fetchBinanceFutures('XAGUSDT', 'xagusd'),
        fetchBinanceFutures('CL', 'wtiusd'),          // WTI Crude Oil on Binance Futures
        // Forex (Twelve Data)
        fetchTwelveDataForex(),
        // Crypto (CoinGecko)
        fetchCoinGecko('bitcoin', 'btcusd'),
        fetchCoinGecko('ethereum', 'ethusd'),
        // DXY (Finnhub)
        fetchDXY()
    ]);
    console.log('--- Data update finished ---');
}

main().catch(err => console.error('Fatal error:', err));
