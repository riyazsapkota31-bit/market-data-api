// fetch-prices.js – v7.3 (Yahoo fix only, NO test alerts, original thresholds preserved)

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Helper: fetch JSON with timeout
async function fetchJSON(url, timeout = 15000) {
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

// IMPROVED Yahoo Finance fetcher (multiple proxies for reliability)
async function fetchYahooPrice(symbol) {
    const proxies = [
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        (url) => `https://cors-anywhere.herokuapp.com/${url}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    
    const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    
    for (const proxy of proxies) {
        try {
            const url = proxy(directUrl);
            const data = await fetchJSON(url, 10000);
            const result = data.chart?.result?.[0];
            if (result && result.indicators && result.indicators.quote) {
                const quotes = result.indicators.quote[0];
                const closes = quotes.close.filter(c => c !== null);
                if (closes.length > 0) {
                    return closes[closes.length - 1];
                }
            }
        } catch (e) {
            // Try next proxy
            continue;
        }
    }
    throw new Error('All Yahoo proxies failed');
}

// Forex fetcher (works fine)
async function fetchForexPrice(base, quote) {
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
    const data = await fetchJSON(url);
    const rate = data.rates[quote];
    if (!rate) throw new Error('No rate');
    return rate;
}

// Crypto fetcher (works fine)
async function fetchCryptoPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const data = await fetchJSON(url);
    const price = data[id]?.usd;
    if (!price) throw new Error('No price');
    return price;
}

// ========== TECHNICAL INDICATORS (YOUR ORIGINAL) ==========
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

// ========== STRATEGY ANALYSIS (YOUR ORIGINAL - THRESHOLD 100) ==========
function analyzeSignal(prices, candleData) {
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Insufficient data (need 50 candles)'], rsi: 50, trend: 'SIDEWAYS', currentPrice: prices[prices.length-1] };
    }
    
    const currentPrice = prices[prices.length-1];
    const rsi = calcRSI(prices);
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, 50);
    const ema200 = calcEMA(prices, 200);
    
    let trend = 'SIDEWAYS';
    if (ema20 > ema50 && ema50 > ema200) trend = 'BULLISH';
    if (ema20 < ema50 && ema50 < ema200) trend = 'BEARISH';
    
    const isChoppy = Math.abs(ema20 - ema50) / currentPrice < 0.001;
    
    if (isChoppy) {
        return { bias: 'WAIT', confidence: 35, reasons: ['Market choppy (EMAs too close)'], rsi, trend, currentPrice };
    }
    
    let buyScore = 0;
    let sellScore = 0;
    const reasons = [];
    
    // RSI Divergence
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
    
    // EMA Pullback
    const dist = Math.abs(currentPrice - ema20) / currentPrice * 100;
    if (trend === 'BULLISH' && currentPrice < ema20 && currentPrice > ema50 && dist < 0.3) {
        buyScore += 75;
        reasons.push('Bullish EMA pullback');
    } else if (trend === 'BEARISH' && currentPrice > ema20 && currentPrice < ema50 && dist < 0.3) {
        sellScore += 75;
        reasons.push('Bearish EMA pullback');
    }
    
    // Support/Resistance
    const recentLows = Math.min(...prices.slice(-20));
    const recentHighs = Math.max(...prices.slice(-20));
    const nearSupport = Math.abs(currentPrice - recentLows) / currentPrice * 100 < 0.2;
    const nearResistance = Math.abs(currentPrice - recentHighs) / currentPrice * 100 < 0.2;
    
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
    
    // YOUR ORIGINAL THRESHOLD: 100 (NOT CHANGED)
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

// ========== TELEGRAM SENDER ==========
async function sendTelegramAlert(symbolDisplay, signal) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('Telegram not configured');
        return false;
    }
    
    const icon = signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const timestamp = new Date().toLocaleString();
    
    const message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${icon} | ${signal.confidence}% confidence
⏰ ${timestamp}

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice?.toFixed(2) || signal.currentPrice}
📈 RSI: ${signal.rsi?.toFixed(1)} | Trend: ${signal.trend}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons?.slice(0,2).join(', ') || 'Signal detected'}

⚠️ Auto-generated by OMNI-SIGNAL
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
            console.log(`✅ Telegram alert sent for ${symbolDisplay}`);
            return true;
        }
        console.error('Telegram error:', result.description);
        return false;
    } catch (error) {
        console.error('Failed to send:', error.message);
        return false;
    }
}

// ========== CANDLE BUILDER FUNCTIONS ==========
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

function saveFullHistory(file, history, currentPrice) {
    const historyFile = path.join(dataDir, `${file}.json`);
    const data = {
        currentPrice,
        timestamp: Date.now(),
        history: history.slice(-100),
        source: 'Built 5min candle'
    };
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
}

async function processAsset(file, priceFetcher, displayName) {
    try {
        const price = await priceFetcher();
        if (price === undefined || price === null) throw new Error('No price');
        
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
                    const signal = analyzeSignal(history, state.candle);
                    console.log(`📊 ${displayName} - Signal: ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0,1).join(', ') || 'No confluence'}`);
                    
                    if (signal.bias !== 'WAIT' && signal.confidence >= 55) {
                        await sendTelegramAlert(displayName, signal);
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

// ========== MAIN EXECUTION ==========
async function main() {
    console.log('--- Fetching minute snapshots with automatic signal detection ---');
    console.log(`Telegram configured: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID}`);
    
    const assets = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD' },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD' },
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD' },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD' },
        { file: 'xauusd', fetcher: () => fetchYahooPrice('GC=F'), display: 'XAUUSD (Gold)' },
        { file: 'xagusd', fetcher: () => fetchYahooPrice('SI=F'), display: 'XAGUSD (Silver)' },
        { file: 'wtiusd', fetcher: () => fetchYahooPrice('CL=F'), display: 'WTI Oil' },
        { file: 'dxy', fetcher: () => fetchYahooPrice('DX-Y.NYB'), display: 'DXY' }
    ];
    
    for (const asset of assets) {
        await processAsset(asset.file, asset.fetcher, asset.display);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('--- Minute snapshots + signal analysis completed ---');
}

main().catch(err => console.error('Fatal error:', err));
