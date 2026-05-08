// fetch-prices.js – v7.0 (Automatic Signals + Telegram Alerts)
// Builds 5‑minute candles for all assets from minute snapshots.
// Sources:
//   Forex: Frankfurter (free, no key)
//   Crypto: CoinGecko (free, no key)
//   Gold, Silver, Oil, DXY: Yahoo Finance via public proxy (free, no key)
// Every minute (triggered by cron-job.org), it fetches current prices,
// aggregates into 5‑minute buckets, writes completed candles to JSON files,
// AND sends Telegram alerts when BUY/SELL signals are detected.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Telegram Configuration (from GitHub Secrets)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

// ========== TECHNICAL INDICATORS ==========
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
    let ema = prices.slice(0, period).reduce((a,b)=>a+b,0)/period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcATR(highLowClose, period = 14) {
    if (highLowClose.length < period + 1) return null;
    let trSum = 0;
    for (let i = highLowClose.length - period; i < highLowClose.length; i++) {
        const candle = highLowClose[i];
        if (i === 0) continue;
        const prevClose = highLowClose[i-1].close;
        const hl = candle.high - candle.low;
        const hc = Math.abs(candle.high - prevClose);
        const lc = Math.abs(candle.low - prevClose);
        trSum += Math.max(hl, hc, lc);
    }
    return trSum / period;
}

// ========== STRATEGY ANALYSIS (Simplified for auto-alerts) ==========
function analyzeSignal(prices, candleData) {
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Insufficient data (need 50 candles)'] };
    }
    
    const currentPrice = prices[prices.length-1];
    const rsi = calcRSI(prices);
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, 50);
    const ema200 = calcEMA(prices, 200);
    
    // Determine trend
    let trend = 'SIDEWAYS';
    if (ema20 > ema50 && ema50 > ema200) trend = 'BULLISH';
    if (ema20 < ema50 && ema50 < ema200) trend = 'BEARISH';
    
    // Choppy market check
    const isChoppy = Math.abs(ema20 - ema50) / currentPrice < 0.001;
    
    if (isChoppy) {
        return { bias: 'WAIT', confidence: 35, reasons: ['Market choppy (EMAs too close)'], rsi, trend };
    }
    
    let buyScore = 0;
    let sellScore = 0;
    const reasons = [];
    
    // Strategy 1: RSI Divergence
    if (prices.length >= 2) {
        const prevPrice = prices[prices.length-2];
        const priceHigher = currentPrice > prevPrice;
        const rsiHigher = rsi > 50;
        if (!priceHigher && rsiHigher) {
            buyScore += 85;
            reasons.push('Bullish RSI divergence');
        } else if (priceHigher && !rsiHigher) {
            sellScore += 85;
            reasons.push('Bearish RSI divergence');
        }
    }
    
    // Strategy 2: EMA Pullback
    const dist = Math.abs(currentPrice - ema20) / currentPrice * 100;
    if (trend === 'BULLISH' && currentPrice < ema20 && currentPrice > ema50 && dist < 0.3) {
        buyScore += 75;
        reasons.push('Bullish EMA pullback');
    } else if (trend === 'BEARISH' && currentPrice > ema20 && currentPrice < ema50 && dist < 0.3) {
        sellScore += 75;
        reasons.push('Bearish EMA pullback');
    }
    
    // Strategy 3: Support/Resistance (using recent highs/lows)
    const recentLows = Math.min(...prices.slice(-20));
    const recentHighs = Math.max(...prices.slice(-20));
    const support = recentLows;
    const resistance = recentHighs;
    
    const nearSupport = Math.abs(currentPrice - support) / currentPrice * 100 < 0.2;
    const nearResistance = Math.abs(currentPrice - resistance) / currentPrice * 100 < 0.2;
    
    if (nearSupport && rsi < 50) {
        buyScore += 80;
        reasons.push('Bounce from support');
    } else if (nearResistance && rsi > 50) {
        sellScore += 80;
        reasons.push('Rejection from resistance');
    }
    
    // Trend alignment bonus
    if (trend === 'BULLISH') buyScore += 15;
    if (trend === 'BEARISH') sellScore += 15;
    
    // Determine final signal
    let bias = 'WAIT';
    let confidence = 50;
    
    if (buyScore > 100 && buyScore > sellScore) {
        bias = 'BUY';
        confidence = Math.min(85, 50 + Math.floor(buyScore / 3));
    } else if (sellScore > 100 && sellScore > buyScore) {
        bias = 'SELL';
        confidence = Math.min(85, 50 + Math.floor(sellScore / 3));
    }
    
    return { bias, confidence, reasons, rsi, trend, currentPrice, ema20, ema50 };
}

// ========== TELEGRAM ALERT SENDER ==========
async function sendTelegramAlert(symbolDisplay, signal, assetName) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram not configured - secrets missing');
        return false;
    }
    
    const icon = signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const stars = '★'.repeat(Math.floor(signal.confidence / 20)) + '☆'.repeat(5 - Math.floor(signal.confidence / 20));
    const timestamp = new Date().toLocaleString();
    
    const message = `
🤖 <b>OMNI-SIGNAL AUTO ALERT</b> 🤖
━━━━━━━━━━━━━━━━━━━
${icon} | ${stars} ${signal.confidence}%
⏰ ${timestamp}

📊 <b>${symbolDisplay}</b>
💰 Price: ${signal.currentPrice.toFixed(symbolDisplay.includes('XAU') ? 2 : 4)}
📈 RSI: ${signal.rsi.toFixed(1)} | Trend: ${signal.trend}
📊 EMA20: ${signal.ema20.toFixed(symbolDisplay.includes('XAU') ? 2 : 4)}
📊 EMA50: ${signal.ema50.toFixed(symbolDisplay.includes('XAU') ? 2 : 4)}

━━━━━━━━━━━━━━━━━━━
💡 <b>Signal Reasons:</b>
${signal.reasons.map(r => `• ${r}`).join('\n')}

⚠️ <i>Auto-generated by OMNI-SIGNAL. Always verify before trading.</i>
    `.trim();
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_notification: false
            })
        });
        
        const result = await response.json();
        if (result.ok) {
            console.log(`✅ Telegram alert sent for ${symbolDisplay} - ${signal.bias}`);
            return true;
        } else {
            console.error('Telegram error:', result.description);
            return false;
        }
    } catch (error) {
        console.error('Failed to send Telegram:', error.message);
        return false;
    }
}

// ========== CANDLE BUILDER (with signal analysis on candle completion) ==========
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

function loadFullHistory(file) {
    const historyFile = path.join(dataDir, `${file}.json`);
    if (fs.existsSync(historyFile)) {
        try { 
            const data = JSON.parse(fs.readFileSync(historyFile));
            if (data.history && Array.isArray(data.history)) {
                return data.history;
            }
        } catch(e) {}
    }
    return [];
}

function saveFullHistory(file, history, currentPrice, extra = {}) {
    const historyFile = path.join(dataDir, `${file}.json`);
    const data = {
        currentPrice,
        timestamp: Date.now(),
        history: history.slice(-100),
        source: 'Built 5min candle',
        ...extra
    };
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
    return data;
}

// Process a single asset with automatic signal detection
async function processAsset(name, priceFetcher, displaySymbol) {
    try {
        const price = await priceFetcher();
        if (price === undefined || price === null) throw new Error('No price');

        const now = Date.now();
        const minute = Math.floor(now / 60000);
        const current5minBucket = Math.floor(minute / 5);

        let state = loadCandleState(name);
        if (!state || state.bucket !== current5minBucket) {
            // Finalize previous candle if exists and analyze signal
            if (state && state.candle && state.history) {
                const completedCandle = {
                    open: state.candle.open,
                    high: state.candle.high,
                    low: state.candle.low,
                    close: state.lastPrice,
                    timestamp: state.startTime
                };
                
                // Add to history
                const history = [...(state.history || []), completedCandle.close].slice(-100);
                saveFullHistory(name, history, state.lastPrice);
                
                // ANALYZE SIGNAL ON COMPLETED CANDLE
                if (history.length >= 50) {
                    const signal = analyzeSignal(history, completedCandle);
                    console.log(`📊 ${displaySymbol} - Signal: ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0,2).join(', ') || 'No confluence'}`);
                    
                    // Send Telegram alert if strong signal
                    if (signal.bias !== 'WAIT' && signal.confidence >= 55) {
                        await sendTelegramAlert(displaySymbol, signal, name);
                    }
                }
            }
            
            // Start new candle
            const existingHistory = loadFullHistory(name);
            state = {
                bucket: current5minBucket,
                startTime: now,
                candle: { open: price, high: price, low: price, close: price },
                lastPrice: price,
                lastTimestamp: now,
                history: existingHistory
            };
        } else {
            // Update current candle
            state.candle.high = Math.max(state.candle.high, price);
            state.candle.low = Math.min(state.candle.low, price);
            state.candle.close = price;
            state.lastPrice = price;
            state.lastTimestamp = now;
            if (!state.history) state.history = loadFullHistory(name);
        }
        saveCandleState(name, state);
        console.log(`✓ ${displaySymbol} price ${price}`);
    } catch (err) {
        console.error(`✗ ${displaySymbol}: ${err.message}`);
    }
}

// ========== PRICE FETCHERS FOR EACH ASSET ==========
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

// ========== MAIN EXECUTION ==========
async function main() {
    console.log('--- Fetching minute snapshots with automatic signal detection ---');
    console.log(`Telegram configured: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID}`);
    
    // Asset list: (filename, fetcher, display symbol)
    const assets = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD' },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD' },
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD' },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD' },
        { file: 'xauusd', fetcher: () => fetchYahooAssetPrice('gold'), display: 'XAUUSD (Gold)' },
        { file: 'xagusd', fetcher: () => fetchYahooAssetPrice('silver'), display: 'XAGUSD (Silver)' },
        { file: 'wtiusd', fetcher: () => fetchYahooAssetPrice('oil'), display: 'WTI Oil' },
        { file: 'dxy', fetcher: () => fetchYahooAssetPrice('dxy'), display: 'DXY (Dollar Index)' }
    ];
    
    for (const asset of assets) {
        await processAsset(asset.file, asset.fetcher, asset.display);
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('--- Minute snapshots + signal analysis completed ---');
}

main().catch(err => console.error('Fatal error:', err));
