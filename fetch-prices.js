// fetch-prices.js – Hybrid data fetcher for OMNI-SIGNAL
// Runs on GitHub Actions every 5 minutes.
// Uses Twelve Data batch for forex/crypto, Alpha Vantage for metals & DXY, CoinGecko for extra crypto (optional).
// Writes JSON files to /data/ folder.

const fs = require('fs');
const path = require('path');

const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
const ALPHA_KEY = process.env.ALPHA_VANTAGE_KEY;

if (!TWELVE_KEY || !ALPHA_KEY) {
    console.error("Missing API keys. Please set TWELVE_DATA_KEY and ALPHA_VANTAGE_KEY secrets.");
    process.exit(0);
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// ------------------------------------------------------------------
// 1. Twelve Data batch (forex + crypto)
// ------------------------------------------------------------------
const tdSymbols = ['EUR/USD', 'GBP/USD', 'BTC/USD', 'ETH/USD'];
const tdMap = {
    'EUR/USD': 'eurusd',
    'GBP/USD': 'gbpusd',
    'BTC/USD': 'btcusd',
    'ETH/USD': 'ethusd'
};

async function fetchTwelveData() {
    try {
        const url = `https://api.twelvedata.com/quote?symbol=${tdSymbols.join(',')}&apikey=${TWELVE_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        for (const [symbol, file] of Object.entries(tdMap)) {
            const asset = data[symbol];
            if (asset && asset.close) {
                const price = parseFloat(asset.close);
                const output = {
                    price,
                    open: parseFloat(asset.open),
                    high: parseFloat(asset.high),
                    low: parseFloat(asset.low),
                    change: parseFloat(asset.percent_change) || 0,
                    timestamp: new Date().toISOString(),
                    source: 'Twelve Data'
                };
                fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify(output, null, 2));
                console.log(`✓ ${file} from Twelve Data`);
            } else {
                console.warn(`✗ ${file} missing in Twelve Data response`);
            }
        }
    } catch (err) {
        console.error("Twelve Data batch failed:", err.message);
    }
}

// ------------------------------------------------------------------
// 2. Alpha Vantage: Metals (XAU/USD, XAG/USD) and DXY
// ------------------------------------------------------------------
const alphaAssets = [
    { type: 'forex', from: 'XAU', to: 'USD', file: 'xauusd' },
    { type: 'forex', from: 'XAG', to: 'USD', file: 'xagusd' },
    { type: 'index', symbol: 'DXY', file: 'dxy' }
];

async function fetchAlphaVantage() {
    for (const asset of alphaAssets) {
        try {
            let url;
            if (asset.type === 'forex') {
                url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${asset.from}&to_currency=${asset.to}&apikey=${ALPHA_KEY}`;
            } else {
                url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${asset.symbol}&apikey=${ALPHA_KEY}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            let price = null;
            let change = 0;
            if (asset.type === 'forex') {
                const rate = data['Realtime Currency Exchange Rate'];
                if (rate) {
                    price = parseFloat(rate['5. Exchange Rate']);
                    change = 0; // no change percent from this endpoint
                }
            } else {
                const quote = data['Global Quote'];
                if (quote && quote['05. price']) {
                    price = parseFloat(quote['05. price']);
                    change = parseFloat(quote['10. change percent']) || 0;
                }
            }
            if (price) {
                const output = {
                    price,
                    open: price,
                    high: price,
                    low: price,
                    change,
                    timestamp: new Date().toISOString(),
                    source: 'Alpha Vantage'
                };
                fs.writeFileSync(path.join(dataDir, `${asset.file}.json`), JSON.stringify(output, null, 2));
                console.log(`✓ ${asset.file} from Alpha Vantage`);
            } else {
                console.warn(`✗ ${asset.file} – no price`);
            }
        } catch (err) {
            console.error(`Alpha Vantage error for ${asset.file}:`, err.message);
        }
    }
}

// ------------------------------------------------------------------
// 3. Oil (WTI) – try Twelve Data first, fallback to Alpha Vantage
// ------------------------------------------------------------------
async function fetchOil() {
    // Try Twelve Data first (WTI/USD)
    if (TWELVE_KEY) {
        try {
            const url = `https://api.twelvedata.com/quote?symbol=WTI/USD&apikey=${TWELVE_KEY}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.close) {
                const price = parseFloat(data.close);
                const output = {
                    price,
                    open: parseFloat(data.open),
                    high: parseFloat(data.high),
                    low: parseFloat(data.low),
                    change: parseFloat(data.percent_change),
                    timestamp: new Date().toISOString(),
                    source: 'Twelve Data (WTI/USD)'
                };
                fs.writeFileSync(path.join(dataDir, 'wtiusd.json'), JSON.stringify(output, null, 2));
                console.log("✓ wtiusd from Twelve Data");
                return;
            }
        } catch (e) { console.warn("Twelve Data oil failed, trying Alpha Vantage fallback", e.message); }
    }
    // Fallback: Alpha Vantage WTICOUSD
    try {
        const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=WTICOUSD&apikey=${ALPHA_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        const quote = data['Global Quote'];
        if (quote && quote['05. price']) {
            const price = parseFloat(quote['05. price']);
            const output = {
                price,
                open: parseFloat(quote['02. open'] || price),
                high: parseFloat(quote['03. high'] || price),
                low: parseFloat(quote['04. low'] || price),
                change: parseFloat(quote['10. change percent']),
                timestamp: new Date().toISOString(),
                source: 'Alpha Vantage (WTICOUSD)'
            };
            fs.writeFileSync(path.join(dataDir, 'wtiusd.json'), JSON.stringify(output, null, 2));
            console.log("✓ wtiusd from Alpha Vantage (fallback)");
        } else {
            console.warn("✗ Oil – no price from any source");
        }
    } catch (err) {
        console.error("Oil fetch failed completely:", err.message);
    }
}

// ------------------------------------------------------------------
// 4. (Optional) Solana from CoinGecko – free, no key, CORS friendly
// ------------------------------------------------------------------
async function fetchSolana() {
    try {
        const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
        const res = await fetch(url);
        const data = await res.json();
        if (data.solana && data.solana.usd) {
            const output = {
                price: data.solana.usd,
                timestamp: new Date().toISOString(),
                source: 'CoinGecko'
            };
            fs.writeFileSync(path.join(dataDir, 'solusd.json'), JSON.stringify(output, null, 2));
            console.log("✓ solusd from CoinGecko");
        }
    } catch (err) {
        console.error("Solana fetch failed:", err.message);
    }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
(async () => {
    console.log("--- OMNI-SIGNAL MASTER SYNC START ---");
    await fetchTwelveData();
    await fetchAlphaVantage();
    await fetchOil();
    await fetchSolana();   // optional, comment out if not needed
    console.log("--- SYNC COMPLETE ---");
})();
