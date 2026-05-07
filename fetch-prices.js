// fetch-prices.js – Binance (all assets) + Finnhub DXY (your key)
const fs = require('fs');
const path = require('path');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) {
    console.warn('⚠️ FINNHUB_API_KEY missing – DXY will be skipped');
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

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

// ---------- Binance Spot (crypto, gold/silver via PAXG) ----------
async function fetchBinanceSpot(symbol, file) {
    try {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
        const data = await fetchJSON(url);
        const price = parseFloat(data.price);
        if (isNaN(price)) throw new Error('Invalid price');
        const output = { price, timestamp: new Date().toISOString(), source: 'Binance Spot' };
        fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
        console.log(`✓ ${file} from Binance Spot`);
    } catch (err) {
        console.error(`✗ ${file}: ${err.message}`);
    }
}

// ---------- Binance Futures (forex, oil) ----------
async function fetchBinanceFutures(symbol, file) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
        const data = await fetchJSON(url);
        const price = parseFloat(data.price);
        if (isNaN(price)) throw new Error('Invalid price');
        const output = { price, timestamp: new Date().toISOString(), source: 'Binance Futures' };
        fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
        console.log(`✓ ${file} from Binance Futures`);
    } catch (err) {
        console.error(`✗ ${file}: ${err.message}`);
    }
}

// ---------- Finnhub DXY ----------
async function fetchDXY() {
    if (!FINNHUB_KEY) {
        console.warn('Skipping DXY – no API key');
        return;
    }
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=DX-Y.NYB&token=${FINNHUB_KEY}`;
        const data = await fetchJSON(url);
        const price = data.c;
        if (!price) throw new Error('No price');
        const output = {
            price,
            open: data.o,
            high: data.h,
            low: data.l,
            change: data.dp,
            timestamp: new Date().toISOString(),
            source: 'Finnhub'
        };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(output, null, 2));
        console.log('✓ dxy from Finnhub');
    } catch (err) {
        console.error(`✗ dxy: ${err.message}`);
        // fallback
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify({ price: 0, error: true, timestamp: new Date().toISOString() }, null, 2));
    }
}

// ---------- Main ----------
async function main() {
    await Promise.all([
        fetchBinanceSpot('BTCUSDT', 'btcusd'),
        fetchBinanceSpot('ETHUSDT', 'ethusd'),
        fetchBinanceSpot('PAXGUSDT', 'xauusd'),
        fetchBinanceSpot('PAXGUSDT', 'xagusd'),
        fetchBinanceFutures('EURUSDT', 'eurusd'),
        fetchBinanceFutures('GBPUSDT', 'gbpusd'),
        fetchBinanceFutures('CLUSDT', 'wtiusd'),
        fetchDXY()
    ]);
    console.log('--- Data update finished ---');
}

main().catch(err => console.error('Fatal error:', err));
