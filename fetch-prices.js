// fetch-prices.js – v7.3 (Only fixes: Yahoo fetching + error handling)
// NO changes to strategy thresholds (keeps your 100 score requirement)

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

// IMPROVED Yahoo Finance fetcher (only fix added)
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
            if (result?.indicators?.quote?.[0]?.close) {
                const closes = result.indicators.quote[0].close.filter(c => c !== null);
                if (closes.length > 0) return closes[closes.length - 1];
            }
        } catch (e) {
            continue;
        }
    }
    throw new Error('All Yahoo proxies failed');
}

// YOUR ORIGINAL FETCHERS (unchanged)
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

// ========== YOUR ORIGINAL INDICATORS (unchanged) ==========
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

// ========== YOUR ORIGINAL STRATEGY (THRESHOLD STILL 100) ==========
function analyzeSignal(prices, candleData) {
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Insufficient data (need 50 candles)'] };
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
        return { bias: 'WAIT', confidence: 35, reasons: ['Market choppy (EMAs too close)'], rsi, trend };
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
    
    // Volume Confirmation (simplified)
    if (candleData && candleData.volumeSpike) {
        if (currentPrice > recentHighs * 0.995) {
            buyScore += 70;
            reasons.push('Volume breakout');
        } else if (currentPrice < recentLows * 1.005) {
            sellScore += 70;
            reasons.push('Volume breakdown');
        }
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

// ========== TELEGRAM SENDER (unchanged from your original) ==========
async function sendTelegramAlert(symbolDisplay, signal, assetName) {
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
        return false;
    } catch (error) {
        console.error('Failed to send:', error.message);
        return false;
    }
}

// [Rest of your original processAsset and candle builder functions remain EXACTLY the same]
// ... (loadCandleState, saveCandleState, appendCandleToHistory, processAsset, main)

// I'm not including the full candle functions here to save space,
// but you would keep your EXISTING ones unchanged.
