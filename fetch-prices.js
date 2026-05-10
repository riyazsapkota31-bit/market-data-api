// fetch-prices.js – v10.3 (Final: within API limits, 1% risk, Gold/Silver fixed)

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Secrets from GitHub Actions
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

// ========== YOUR PERSONAL TRADING PARAMETERS ==========
const DEFAULT_BALANCE = 7200;
const DEFAULT_RISK_PERCENT = 1.0;      // 1% as you requested
const DEFAULT_MODE = 'scalp';

// ========== XM STANDARD ACCOUNT SPREADS ==========
const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex' },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex' },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto' },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto' },
    xauusd: { multiplier: 100, spread: 0.040, digits: 2, class: 'commodities' },
    xagusd: { multiplier: 100, spread: 0.030, digits: 3, class: 'commodities' },
    wtiusd: { multiplier: 100, spread: 0.030, digits: 2, class: 'commodities' },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex' }
};

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

// ---------- FOREX (Frankfurter – no limits) ----------
async function fetchForexPrice(base, quote) {
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
    const data = await fetchJSON(url);
    return data.rates[quote];
}

// ---------- CRYPTO (CoinGecko – no limits) ----------
async function fetchCryptoPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const data = await fetchJSON(url);
    return data[id]?.usd;
}

// ---------- GOLD & SILVER (Multiple fallbacks) ----------
async function fetchMetalPrice(metal) {
    const metalName = metal === 'XAU' ? 'Gold' : 'Silver';
    
    // Try metals.live first
    try {
        const url = `https://api.metals.live/v1/spot/${metal.toLowerCase()}`;
        const data = await fetchJSON(url);
        if (data && data.price) {
            console.log(`✓ ${metalName} price from metals.live: $${data.price}`);
            return data.price;
        }
    } catch (err) {
        console.log(`metals.live failed for ${metalName}: ${err.message}`);
    }
    
    // Try gold-api.com as fallback
    try {
        const symbol = metal === 'XAU' ? 'XAUUSD' : 'XAGUSD';
        const url = `https://api.gold-api.com/price/${symbol}`;
        const data = await fetchJSON(url);
        if (data && data.price) {
            console.log(`✓ ${metalName} price from gold-api.com: $${data.price}`);
            return data.price;
        }
    } catch (err) {
        console.log(`gold-api.com failed for ${metalName}: ${err.message}`);
    }
    
    // Use cached fallback
    const fallbackFile = path.join(dataDir, `${metal.toLowerCase()}_fallback.json`);
    if (fs.existsSync(fallbackFile)) {
        const fallback = JSON.parse(fs.readFileSync(fallbackFile));
        if (Date.now() - fallback.timestamp < 7200000) { // 2 hours stale
            console.log(`⚠️ Using cached ${metalName} price: $${fallback.price}`);
            return fallback.price;
        }
    }
    
    throw new Error(`Failed to fetch ${metalName} price from all sources`);
}

// Save metal fallback
async function saveMetalFallback(metal, price) {
    const fallbackFile = path.join(dataDir, `${metal.toLowerCase()}_fallback.json`);
    fs.writeFileSync(fallbackFile, JSON.stringify({ price, timestamp: Date.now() }));
}

// ---------- DXY (Twelve Data only – within limit 480/day) ----------
async function fetchDXYPrice() {
    if (!TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_KEY missing');
    
    const url = `https://api.twelvedata.com/price?symbol=DX-Y.NYB&apikey=${TWELVE_DATA_KEY}`;
    const data = await fetchJSON(url);
    
    if (!data.price) {
        throw new Error('Invalid DXY response from Twelve Data');
    }
    
    const price = parseFloat(data.price);
    if (isNaN(price) || price <= 0) {
        throw new Error(`Invalid DXY price: ${data.price}`);
    }
    
    return price;
}

// ---------- OIL (Alpha Vantage with correct symbols) ----------
let lastOilPrice = null;
let lastOilFetchTime = 0;

async function fetchOilPrice() {
    if (!ALPHA_VANTAGE_KEY) throw new Error('ALPHA_VANTAGE_KEY missing');
    
    const now = Date.now();
    
    // Cache for 10 minutes to reduce API calls (480/day is safe, but extra buffer)
    if (lastOilPrice && (now - lastOilFetchTime) < 600000) {
        console.log('⚠️ Using cached oil price (10 min cache)');
        return lastOilPrice;
    }
    
    // Correct symbols for Crude Oil WTI
    const symbols = ['CL', 'USO', 'BZ'];
    
    for (const symbol of symbols) {
        try {
            const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
            const data = await fetchJSON(url);
            
            const quote = data['Global Quote'];
            if (quote && quote['05. price']) {
                const price = parseFloat(quote['05. price']);
                // Real oil should be $50-150, not $3-5 (natural gas)
                if (!isNaN(price) && price > 50 && price < 150) {
                    console.log(`✓ Oil price fetched using symbol: ${symbol} at $${price}`);
                    lastOilPrice = price;
                    lastOilFetchTime = now;
                    return price;
                } else {
                    console.log(`⚠️ Symbol ${symbol} returned $${price} (likely not oil, skipping)`);
                }
            }
        } catch (err) {
            console.log(`Symbol ${symbol} failed: ${err.message}`);
        }
    }
    
    // Use cached fallback if available
    const fallbackFile = path.join(dataDir, 'wtiusd_fallback.json');
    if (fs.existsSync(fallbackFile)) {
        const fallback = JSON.parse(fs.readFileSync(fallbackFile));
        if (Date.now() - fallback.timestamp < 7200000) { // 2 hours stale
            console.log(`⚠️ Using cached oil price from fallback: $${fallback.price}`);
            return fallback.price;
        }
    }
    
    throw new Error('Oil price not found from any symbol (CL, USO, BZ)');
}

// Save oil fallback
async function saveOilFallback(price) {
    const fallbackFile = path.join(dataDir, 'wtiusd_fallback.json');
    fs.writeFileSync(fallbackFile, JSON.stringify({ price, timestamp: Date.now() }));
}

// ---------- TECHNICAL INDICATORS ----------
function calcRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length - 1; i++) {
        const diff = prices[i+1] - prices[i];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calcEMA(prices, period) {
    if (prices.length < period) return prices[prices.length-1];
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcATR(prices, period = 14) {
    if (prices.length < period + 1) {
        const recent = prices.slice(-period);
        return (Math.max(...recent) - Math.min(...recent)) / period;
    }
    let trSum = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        if (i === 0) continue;
        const high = prices[i];
        const low = prices[i];
        const prevClose = prices[i-1];
        const hl = high - low;
        const hc = Math.abs(high - prevClose);
        const lc = Math.abs(low - prevClose);
        trSum += Math.max(hl, hc, lc);
    }
    return trSum / period;
}

// ---------- RISK MANAGER ----------
function calculateTradeLevels(currentPrice, atr, support, resistance, signalBias, confidence, mode, multiplier, spread, digits) {
    let entry, sl, tp1, tp2, rrRatio = 0;
    if (signalBias === 'BUY') {
        entry = currentPrice;
        const atrMult = mode === 'scalp' ? 0.45 : 1.0;
        let slDist = atr * atrMult;
        sl = entry - slDist;
        if (sl > support) sl = support * 0.998;
        const minRR = mode === 'scalp' ? 1.5 : 4.0;
        const maxRR = mode === 'scalp' ? 4.0 : 12.0;
        const targetRR = Math.min(minRR + (confidence / 100) * 3, maxRR);
        const risk = entry - sl;
        tp1 = entry + risk;
        tp2 = entry + risk * targetRR;
        if (tp2 > resistance) { tp2 = resistance * 0.998; rrRatio = (tp2 - entry) / risk; }
        else rrRatio = targetRR;
    } else if (signalBias === 'SELL') {
        entry = currentPrice;
        const atrMult = mode === 'scalp' ? 0.45 : 1.0;
        let slDist = atr * atrMult;
        sl = entry + slDist;
        if (sl < resistance) sl = resistance * 1.002;
        const minRR = mode === 'scalp' ? 1.5 : 4.0;
        const maxRR = mode === 'scalp' ? 4.0 : 12.0;
        const targetRR = Math.min(minRR + (confidence / 100) * 3, maxRR);
        const risk = sl - entry;
        tp1 = entry - risk;
        tp2 = entry - risk * targetRR;
        if (tp2 < support) { tp2 = support * 1.002; rrRatio = (entry - tp2) / risk; }
        else rrRatio = targetRR;
    } else return null;
    const minRRReq = mode === 'scalp' ? 1.5 : 4.0;
    if (rrRatio < minRRReq) return null;
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDist = Math.abs(entry - sl) + spread;
    let lotSize = riskAmount / (stopDist * multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, 50));
    return {
        entry: entry.toFixed(digits),
        sl: sl.toFixed(digits),
        tp1: tp1.toFixed(digits),
        tp2: tp2.toFixed(digits),
        rrRatio: rrRatio.toFixed(1),
        lotSize: lotSize.toFixed(2)
    };
}

// ---------- STRATEGY ENGINE ----------
function analyzeSignal(prices, candleData, assetClass) {
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Insufficient data (need 50 candles)'], rsi: 50, trend: 'SIDEWAYS', currentPrice: prices[prices.length-1] };
    }
    const currentPrice = prices[prices.length-1];
    const rsi = calcRSI(prices);
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, 50);
    const ema200 = calcEMA(prices, 200);
    const atr = calcATR(prices, 14);
    const support = Math.min(...prices.slice(-50)) * 0.998;
    const resistance = Math.max(...prices.slice(-50)) * 1.002;
    let trend = 'SIDEWAYS';
    if (ema20 > ema50 && ema50 > ema200) trend = 'BULLISH';
    if (ema20 < ema50 && ema50 < ema200) trend = 'BEARISH';
    const isChoppy = Math.abs(ema20 - ema50) / currentPrice < 0.001;
    if (isChoppy) {
        return { bias: 'WAIT', confidence: 35, reasons: ['Market choppy (EMAs too close)'], rsi, trend, currentPrice, atr, support, resistance };
    }
    let buyScore = 0, sellScore = 0, reasons = [];
    if (prices.length >= 2) {
        const prevPrice = prices[prices.length-2];
        const priceHigher = currentPrice > prevPrice;
        const rsiHigher = rsi > 50;
        if (!priceHigher && rsiHigher) { buyScore += 85; reasons.push('Bullish RSI divergence'); }
        else if (priceHigher && !rsiHigher) { sellScore += 85; reasons.push('Bearish RSI divergence'); }
    }
    const dist = Math.abs(currentPrice - ema20) / currentPrice * 100;
    if (trend === 'BULLISH' && currentPrice < ema20 && currentPrice > ema50 && dist < 0.3) { buyScore += 75; reasons.push('Bullish EMA pullback'); }
    else if (trend === 'BEARISH' && currentPrice > ema20 && currentPrice < ema50 && dist < 0.3) { sellScore += 75; reasons.push('Bearish EMA pullback'); }
    const atrPerc = atr / currentPrice * 100;
    const nearSupport = Math.abs(currentPrice - support) / currentPrice * 100 < atrPerc * 0.5;
    const nearResistance = Math.abs(currentPrice - resistance) / currentPrice * 100 < atrPerc * 0.5;
    if (nearSupport && rsi < 50) { buyScore += 80; reasons.push('Bounce from support'); }
    else if (nearResistance && rsi > 50) { sellScore += 80; reasons.push('Rejection from resistance'); }
    if (trend === 'BULLISH') buyScore += 15;
    if (trend === 'BEARISH') sellScore += 15;
    let bias = 'WAIT', confidence = 50;
    if (buyScore > 100 && buyScore > sellScore) { bias = 'BUY'; confidence = Math.min(85, 50 + Math.floor(buyScore / 3)); }
    else if (sellScore > 100 && sellScore > buyScore) { bias = 'SELL'; confidence = Math.min(85, 50 + Math.floor(sellScore / 3)); }
    return { bias, confidence, reasons, rsi, trend, currentPrice, ema20, ema50, atr, support, resistance };
}

// ---------- TELEGRAM ALERT ----------
async function sendTelegramAlert(symbolDisplay, signal, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    let tradeLevels = null;
    if (signal.bias !== 'WAIT') {
        tradeLevels = calculateTradeLevels(
            signal.currentPrice, signal.atr, signal.support, signal.resistance,
            signal.bias, signal.confidence, DEFAULT_MODE,
            assetConfig.multiplier, assetConfig.spread, assetConfig.digits
        );
    }
    const icon = signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const timestamp = new Date().toLocaleString();
    let message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${icon} | ${signal.confidence}% confidence
⏰ ${timestamp}

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}
📈 RSI: ${signal.rsi.toFixed(1)} | Trend: ${signal.trend}
📊 ATR: ${signal.atr.toFixed(assetConfig.digits === 5 ? 5 : 2)}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0,2).join(', ') || 'Signal detected'}
`;
    if (tradeLevels) {
        message += `
━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop Loss: ${tradeLevels.sl}
🎯 TP1: ${tradeLevels.tp1} | TP2: ${tradeLevels.tp2}
📐 Risk/Reward: 1:${tradeLevels.rrRatio}
💰 Lot Size: ${tradeLevels.lotSize}
`;
    }
    message += `\n⚠️ Mode: ${DEFAULT_MODE} | Risk: ${DEFAULT_RISK_PERCENT}% | Balance: $${DEFAULT_BALANCE}`;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        const json = await res.json();
        if (json.ok) { console.log(`✅ Telegram alert sent for ${symbolDisplay}`); return true; }
        else console.error('Telegram error:', json.description);
    } catch(e) { console.error('Telegram send error:', e.message); }
    return false;
}

// ---------- CANDLE BUILDER ----------
function loadCandleState(file) {
    const stateFile = path.join(dataDir, `${file}_candle.json`);
    if (fs.existsSync(stateFile)) {
        try { return JSON.parse(fs.readFileSync(stateFile)); } catch(e) { return null; }
    }
    return null;
}
function saveCandleState(file, state) {
    fs.writeFileSync(path.join(dataDir, `${file}_candle.json`), JSON.stringify(state, null, 2));
}
function loadFullHistory(file) {
    const historyFile = path.join(dataDir, `${file}.json`);
    if (fs.existsSync(historyFile)) {
        try { const d = JSON.parse(fs.readFileSync(historyFile)); if (d.history) return d.history; } catch(e) {}
    }
    return [];
}
function saveFullHistory(file, history, currentPrice) {
    fs.writeFileSync(path.join(dataDir, `${file}.json`), JSON.stringify({
        currentPrice, timestamp: Date.now(), history: history.slice(-100), source: '5min candle'
    }, null, 2));
}
async function processAsset(file, priceFetcher, displayName, assetConfig, isOil = false, isMetal = false, metalName = null) {
    try {
        let price = await priceFetcher();
        if (price === undefined || price === null) throw new Error('No price');
        
        if (isOil) await saveOilFallback(price);
        if (isMetal && metalName) await saveMetalFallback(metalName, price);
        
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        const current5minBucket = Math.floor(minute / 5);
        let state = loadCandleState(file);
        let history = loadFullHistory(file);
        if (!state || state.bucket !== current5minBucket) {
            if (state && state.candle && state.lastPrice) {
                history.push(state.lastPrice);
                saveFullHistory(file, history, state.lastPrice);
                if (history.length >= 50) {
                    const signal = analyzeSignal(history, state.candle, assetConfig.class);
                    console.log(`📊 ${displayName} - Signal: ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0,1).join(', ') || 'No confluence'}`);
                    if (signal.bias !== 'WAIT' && signal.confidence >= 55) {
                        await sendTelegramAlert(displayName, signal, assetConfig);
                    }
                }
            }
            state = {
                bucket: current5minBucket,
                startTime: now,
                candle: { open: price, high: price, low: price, close: price },
                lastPrice: price,
                lastTimestamp: now
            };
        } else {
            state.candle.high = Math.max(state.candle.high, price);
            state.candle.low = Math.min(state.candle.low, price);
            state.candle.close = price;
            state.lastPrice = price;
            state.lastTimestamp = now;
        }
        saveCandleState(file, state);
        console.log(`✓ ${displayName} price ${price}`);
    } catch (err) {
        console.error(`✗ ${displayName}: ${err.message}`);
    }
}

// ---------- MAIN ----------
async function main() {
    console.log('--- OMNI-SIGNAL v10.3 (Final: within API limits, 1% risk) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Twelve Data: ${!!TWELVE_DATA_KEY ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: ${DEFAULT_MODE} | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);
    
    const assets = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD', config: ASSET_CONFIGS.eurusd, isOil: false, isMetal: false },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD', config: ASSET_CONFIGS.gbpusd, isOil: false, isMetal: false },
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD', config: ASSET_CONFIGS.btcusd, isOil: false, isMetal: false },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD', config: ASSET_CONFIGS.ethusd, isOil: false, isMetal: false },
        { file: 'xauusd', fetcher: () => fetchMetalPrice('XAU'), display: 'XAUUSD (Gold)', config: ASSET_CONFIGS.xauusd, isOil: false, isMetal: true, metalName: 'XAU' },
        { file: 'xagusd', fetcher: () => fetchMetalPrice('XAG'), display: 'XAGUSD (Silver)', config: ASSET_CONFIGS.xagusd, isOil: false, isMetal: true, metalName: 'XAG' },
        { file: 'wtiusd', fetcher: fetchOilPrice, display: 'WTI Oil', config: ASSET_CONFIGS.wtiusd, isOil: true, isMetal: false },
        { file: 'dxy', fetcher: fetchDXYPrice, display: 'DXY', config: ASSET_CONFIGS.dxy, isOil: false, isMetal: false }
    ];
    
    for (const asset of assets) {
        await processAsset(asset.file, asset.fetcher, asset.display, asset.config, asset.isOil, asset.isMetal, asset.metalName);
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('--- Completed ---');
}

main().catch(err => console.error('Fatal error:', err));
