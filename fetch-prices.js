// fetch-prices.js – FINAL v10.0 (Lot size limits, max position caps)

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

const DEFAULT_BALANCE = 7200;
const DEFAULT_RISK_PERCENT = 1.0;
const DEFAULT_MODE = 'scalp';

const COOLDOWN_FILE = path.join(dataDir, 'cooldown.json');
let oilRunCounter = 0;

// Asset configurations with min stop % and MAX LOT SIZE
const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    usdjpy: { multiplier: 100, spread: 0.03, digits: 3, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    usdcad: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    usdchf: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    usdsek: { multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto', minStopPercent: 0.005, maxLot: 0.5 },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto', minStopPercent: 0.005, maxLot: 5.0 },
    solusd: { multiplier: 10, spread: 0.50, digits: 2, class: 'crypto', minStopPercent: 0.005, maxLot: 50.0 },
    xauusd: { multiplier: 100, spread: 0.040, digits: 2, class: 'commodities', minStopPercent: 0.002, maxLot: 0.5 },
    xagusd: { multiplier: 100, spread: 0.030, digits: 3, class: 'commodities', minStopPercent: 0.002, maxLot: 0.5 },
    wtiusd: { multiplier: 100, spread: 0.030, digits: 2, class: 'commodities', minStopPercent: 0.002, maxLot: 1.0 },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex', minStopPercent: 0.0005, maxLot: 5.0 }
};

// ========== FILE-BASED COOLDOWN ==========
function loadCooldown() {
    if (fs.existsSync(COOLDOWN_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(COOLDOWN_FILE));
        } catch(e) {}
    }
    return {};
}

function saveCooldown(cooldown) {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown, null, 2));
}

function isCooldownActive(symbol, bias) {
    const cooldown = loadCooldown();
    const key = `${symbol}_${bias}`;
    const lastAlert = cooldown[key];
    if (!lastAlert) return false;
    const now = Date.now();
    return (now - lastAlert) < 1800000; // 30 minutes
}

function setCooldown(symbol, bias) {
    const cooldown = loadCooldown();
    const key = `${symbol}_${bias}`;
    cooldown[key] = Date.now();
    saveCooldown(cooldown);
}

// ========== FETCHERS ==========
async function fetchJSON(url, timeout = 10000, headers = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal, headers });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

async function fetchForexPrice(base, quote) {
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
    const data = await fetchJSON(url);
    return data.rates[quote];
}

async function fetchCryptoPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const data = await fetchJSON(url);
    if (!data[id]?.usd) throw new Error(`No price for ${id}`);
    return data[id].usd;
}

async function fetchGoldPrice() {
    const url = 'https://api.gold-api.com/price/XAU';
    const data = await fetchJSON(url);
    if (data && data.price && data.price > 0) return data.price;
    throw new Error('Invalid gold price');
}

async function fetchSilverPrice() {
    const url = 'https://api.gold-api.com/price/XAG';
    const data = await fetchJSON(url);
    if (data && data.price && data.price > 0) return data.price;
    throw new Error('Invalid silver price');
}

let lastOilPrice = null;
let lastOilFetchTime = 0;

async function fetchOilPrice() {
    if (!ALPHA_VANTAGE_KEY) throw new Error('ALPHA_VANTAGE_KEY missing');
    oilRunCounter++;
    if (oilRunCounter % 3 !== 1) {
        console.log('⏸️ Skipping oil (3-min interval)');
        if (lastOilPrice) return lastOilPrice;
        throw new Error('No cached oil');
    }
    const now = Date.now();
    if (lastOilPrice && (now - lastOilFetchTime) < 120000) {
        console.log('⚠️ Using cached oil');
        return lastOilPrice;
    }
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=CL&apikey=${ALPHA_VANTAGE_KEY}`;
    const data = await fetchJSON(url);
    const quote = data['Global Quote'];
    if (quote && quote['05. price']) {
        const price = parseFloat(quote['05. price']);
        if (!isNaN(price) && price > 50 && price < 150) {
            console.log(`✓ Oil: $${price}`);
            lastOilPrice = price;
            lastOilFetchTime = now;
            return price;
        }
    }
    throw new Error('Oil not found');
}

function calculateDXY(eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf) {
    return 50.14348112 *
        Math.pow(eurusd, -0.576) *
        Math.pow(usdjpy, 0.136) *
        Math.pow(gbpusd, -0.119) *
        Math.pow(usdcad, 0.091) *
        Math.pow(usdsek, 0.042) *
        Math.pow(usdchf, 0.036);
}

// ========== TECHNICAL INDICATORS ==========
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

function getSessionQuality() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    
    if (utcHour === 7 && utcMinute < 30) return 1.5;
    if (utcHour >= 7 && utcHour < 16) return 1.0;
    if (utcHour === 12 && utcMinute < 30) return 1.5;
    if (utcHour >= 12 && utcHour < 20) return 1.0;
    if (utcHour >= 23 || utcHour < 7) return 0.5;
    return 0.3;
}

function getCurrentSession() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    if (utcHour >= 7 && utcHour < 16) return 'LONDON';
    if (utcHour >= 12 && utcHour < 20) return 'NEW_YORK';
    return 'OFF_HOURS';
}

// ========== KEY LEVELS ==========
function getKeyLevels(candles, currentPrice) {
    const levels = [];
    
    const dayCandles = candles.slice(-288);
    if (dayCandles.length > 0) {
        levels.push({ price: Math.max(...dayCandles.map(c => c.high)), type: 'MAJOR_RESISTANCE', strength: 15 });
        levels.push({ price: Math.min(...dayCandles.map(c => c.low)), type: 'MAJOR_SUPPORT', strength: 15 });
    }
    
    for (let i = 10; i < candles.length - 10; i++) {
        if (candles[i].high > candles[i-5].high && candles[i].high > candles[i+5].high) {
            levels.push({ price: candles[i].high, type: 'MINOR_RESISTANCE', strength: 10 });
        }
        if (candles[i].low < candles[i-5].low && candles[i].low < candles[i+5].low) {
            levels.push({ price: candles[i].low, type: 'MINOR_SUPPORT', strength: 10 });
        }
    }
    
    const roundNumber = Math.round(currentPrice / (currentPrice > 100 ? 100 : 10)) * (currentPrice > 100 ? 100 : 10);
    levels.push({ price: roundNumber, type: 'ROUND_NUMBER', strength: 5 });
    
    const unique = [];
    for (const level of levels) {
        let duplicate = false;
        for (const existing of unique) {
            if (Math.abs(existing.price - level.price) / level.price < 0.001) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) unique.push(level);
    }
    return unique;
}

function getLevelBonus(price, levels, maxBonus = 20) {
    let bonus = 0;
    for (const level of levels) {
        if (Math.abs(price - level.price) / price < 0.001) {
            bonus += level.strength;
        }
    }
    return Math.min(bonus, maxBonus);
}

// ========== INSTITUTIONAL FOOTPRINTS ==========
function detectFVG(candles) {
    if (candles.length < 3) return null;
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];
    
    if (c1.high < c3.low) {
        return { type: 'BULLISH', strength: 25, reason: 'FVG (bullish gap)', level: c1.high, level2: c3.low };
    }
    if (c3.high < c1.low) {
        return { type: 'BEARISH', strength: 25, reason: 'FVG (bearish gap)', level: c3.high, level2: c1.low };
    }
    return null;
}

function detectOrderBlock(candles) {
    if (candles.length < 3) return null;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    
    if (prev.close < prev.open && last.close > last.open && last.close > prev.high) {
        return { type: 'BULLISH', strength: 30, reason: 'Order Block (bullish)', level: prev.low };
    }
    if (prev.close > prev.open && last.close < last.open && last.close < prev.low) {
        return { type: 'BEARISH', strength: 30, reason: 'Order Block (bearish)', level: prev.high };
    }
    return null;
}

function detectBOS(candles) {
    if (candles.length < 20) return null;
    
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const recentHigh = Math.max(...highs.slice(-10));
    const previousHigh = Math.max(...highs.slice(-20, -10));
    const recentLow = Math.min(...lows.slice(-10));
    const previousLow = Math.min(...lows.slice(-20, -10));
    
    if (recentHigh > previousHigh) {
        return { type: 'BULLISH', strength: 20, reason: 'BOS (higher high)', level: previousHigh };
    }
    if (recentLow < previousLow) {
        return { type: 'BEARISH', strength: 20, reason: 'BOS (lower low)', level: previousLow };
    }
    return null;
}

function detectLiquiditySweep(candles) {
    if (candles.length < 10) return null;
    
    const last = candles[candles.length - 1];
    const recentHighs = candles.slice(-20).map(c => c.high);
    const recentLows = candles.slice(-20).map(c => c.low);
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    
    if (last.low < lowestLow && last.close > lowestLow && last.close > last.open) {
        return { type: 'BULLISH', strength: 35, reason: 'Liquidity sweep (bullish)', level: lowestLow, sweep: last.low };
    }
    if (last.high > highestHigh && last.close < highestHigh && last.close < last.open) {
        return { type: 'BEARISH', strength: 35, reason: 'Liquidity sweep (bearish)', level: highestHigh, sweep: last.high };
    }
    return null;
}

// ========== RETRACEMENT & LIQUIDITY GRAB CONFIRMATION ==========
function checkRetracementAndSweep(candles, bosLevel, bosType, fvgOrObLevel) {
    if (candles.length < 5) return false;
    
    const recentCandles = candles.slice(-10);
    let retraced = false;
    let grabbed = false;
    
    if (bosType === 'BULLISH') {
        for (const candle of recentCandles) {
            if (candle.low <= fvgOrObLevel) retraced = true;
            if (candle.low < fvgOrObLevel && candle.close > fvgOrObLevel) grabbed = true;
        }
    } else {
        for (const candle of recentCandles) {
            if (candle.high >= fvgOrObLevel) retraced = true;
            if (candle.high > fvgOrObLevel && candle.close < fvgOrObLevel) grabbed = true;
        }
    }
    
    return retraced && grabbed;
}

// ========== DYNAMIC RR ==========
function getDynamicRR(confidence) {
    if (confidence >= 80) return 3.0;
    if (confidence >= 70) return 2.5;
    if (confidence >= 60) return 2.0;
    return 1.5;
}

// ========== TRADE LEVELS WITH LOT SIZE CAP ==========
function calculateTradeLevels(price, atr, bias, confidence, config) {
    const atrMult = DEFAULT_MODE === 'scalp' ? 0.8 : 1.2;
    let slDist = atr * atrMult;
    
    const minStopPrice = price * config.minStopPercent;
    if (slDist < minStopPrice) {
        slDist = minStopPrice;
    }
    
    const rr = getDynamicRR(confidence);
    let entry = price;
    let sl, tp;
    
    if (bias === 'BUY') {
        sl = entry - slDist;
        tp = entry + (entry - sl) * rr;
    } else {
        sl = entry + slDist;
        tp = entry - (sl - entry) * rr;
    }
    
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDist = Math.abs(entry - sl) + config.spread;
    let lotSize = riskAmount / (stopDist * config.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, config.maxLot)); // CAP at maxLot
    
    return {
        entry: entry.toFixed(config.digits),
        sl: sl.toFixed(config.digits),
        tp: tp.toFixed(config.digits),
        rrRatio: rr.toFixed(1),
        lotSize: lotSize.toFixed(2)
    };
}

// ========== MAIN STRATEGY ==========
function analyzeSignal(prices, candles, assetClass, assetConfig) {
    if (candles.length < 50) {
        return { 
            bias: 'WAIT', 
            confidence: 30, 
            reasons: [`Building data (${candles.length}/50)`],
            atr: calcATR(prices, 14),
            currentPrice: prices[prices.length-1]
        };
    }
    
    const curPrice = prices[prices.length-1];
    const atr = calcATR(prices, 14);
    
    const bos = detectBOS(candles);
    const fvg = detectFVG(candles);
    const ob = detectOrderBlock(candles);
    const sweep = detectLiquiditySweep(candles);
    
    const keyLevels = getKeyLevels(candles, curPrice);
    const levelBonus = getLevelBonus(curPrice, keyLevels, 20);
    
    let buyScore = 0;
    let sellScore = 0;
    let reasons = [];
    
    let retracementConfirmed = false;
    
    if (bos && (fvg || ob)) {
        const targetLevel = fvg ? (fvg.type === 'BULLISH' ? fvg.level2 : fvg.level) : ob.level;
        const bosType = bos.type;
        retracementConfirmed = checkRetracementAndSweep(candles, bos.level, bosType, targetLevel);
        
        if (retracementConfirmed) {
            reasons.push(`Retracement to ${fvg ? 'FVG' : 'OB'} confirmed`);
            if (sweep && sweep.type === bosType) {
                reasons.push('Liquidity grab confirmed');
                if (bosType === 'BULLISH') buyScore += 20;
                else sellScore += 20;
            }
        }
    }
    
    if (fvg) {
        if (fvg.type === 'BULLISH') buyScore += fvg.strength;
        else sellScore += fvg.strength;
        reasons.push(fvg.reason);
    }
    if (ob) {
        if (ob.type === 'BULLISH') buyScore += ob.strength;
        else sellScore += ob.strength;
        reasons.push(ob.reason);
    }
    if (bos && retracementConfirmed) {
        if (bos.type === 'BULLISH') buyScore += bos.strength;
        else sellScore += bos.strength;
        reasons.push(bos.reason);
    }
    
    if (levelBonus > 0 && buyScore > sellScore) {
        buyScore += levelBonus;
        reasons.push(`+${levelBonus} from key level`);
    } else if (levelBonus > 0 && sellScore > buyScore) {
        sellScore += levelBonus;
        reasons.push(`+${levelBonus} from key level`);
    }
    
    const sessionQuality = getSessionQuality();
    buyScore = Math.floor(buyScore * sessionQuality);
    sellScore = Math.floor(sellScore * sessionQuality);
    
    let bias = 'WAIT';
    let confidence = 40;
    const minScore = 55;
    
    if (buyScore > minScore && buyScore > sellScore) {
        bias = 'BUY';
        confidence = Math.min(85, 55 + Math.floor(buyScore / 3));
    } else if (sellScore > minScore && sellScore > buyScore) {
        bias = 'SELL';
        confidence = Math.min(85, 55 + Math.floor(sellScore / 3));
    }
    
    if (bos && !retracementConfirmed && (fvg || ob)) {
        bias = 'WAIT';
        reasons.push('Waiting for retracement to FVG/OB');
    }
    
    return {
        bias,
        confidence,
        reasons: reasons.slice(0, 5),
        atr,
        currentPrice: curPrice
    };
}

// ========== TELEGRAM ALERT ==========
async function sendTelegramAlert(symbolDisplay, signal, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    if (isCooldownActive(symbolDisplay, signal.bias)) {
        console.log(`⏸️ Cooldown active for ${symbolDisplay} ${signal.bias} - skipping`);
        return false;
    }
    
    const tradeLevels = calculateTradeLevels(signal.currentPrice, signal.atr, signal.bias, signal.confidence, assetConfig);
    const session = getCurrentSession();
    const timestamp = new Date().toLocaleString();
    
    const message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | ${signal.confidence}% confidence
⏰ ${timestamp} (${session} session)

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}
📊 ATR: ${signal.atr.toFixed(assetConfig.digits === 5 ? 5 : 2)}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0, 3).join(', ') || 'Institutional setup confirmed'}

━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop Loss: ${tradeLevels.sl}
🎯 Take Profit: ${tradeLevels.tp}
📐 Risk/Reward: 1:${tradeLevels.rrRatio}
💰 Lot Size: ${tradeLevels.lotSize}

⚠️ Mode: ${DEFAULT_MODE} | Risk: ${DEFAULT_RISK_PERCENT}% | Balance: $${DEFAULT_BALANCE}
    `;
    
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        const json = await res.json();
        if (json.ok) {
            console.log(`✅ Alert sent for ${symbolDisplay}`);
            setCooldown(symbolDisplay, signal.bias);
            return true;
        }
    } catch(e) { console.error('Telegram error:', e.message); }
    return false;
}

// ========== CANDLE BUILDER ==========
function loadCandleHistory(file) {
    const f = path.join(dataDir, `${file}.json`);
    if (fs.existsSync(f)) {
        try {
            const data = JSON.parse(fs.readFileSync(f));
            return data.candles || [];
        } catch(e) {}
    }
    return [];
}

function saveCandleToHistory(file, candle) {
    const f = path.join(dataDir, `${file}.json`);
    let data = { candles: [] };
    if (fs.existsSync(f)) try { data = JSON.parse(fs.readFileSync(f)); } catch(e) {}
    if (!data.candles) data.candles = [];
    data.candles.push(candle);
    if (data.candles.length > 500) data.candles.shift();
    data.currentPrice = candle.close;
    data.timestamp = Date.now();
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function loadCandleState(file) {
    const f = path.join(dataDir, `${file}_candle.json`);
    if (fs.existsSync(f)) try { return JSON.parse(fs.readFileSync(f)); } catch(e) {}
    return null;
}

function saveCandleState(file, state) {
    const f = path.join(dataDir, `${file}_candle.json`);
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
}

async function processAsset(file, priceFetcher, displayName, assetConfig, isOil = false) {
    try {
        let price = await priceFetcher();
        if (!price) throw new Error('No price');
        
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        const bucket = Math.floor(minute / 5);
        let state = loadCandleState(file);
        let candles = loadCandleHistory(file);
        
        if (!state || state.bucket !== bucket) {
            if (state && state.candle && state.lastPrice) {
                const completed = {
                    timestamp: state.startTime,
                    open: state.candle.open,
                    high: state.candle.high,
                    low: state.candle.low,
                    close: state.lastPrice
                };
                saveCandleToHistory(file, completed);
                candles.push(completed);
                const prices = candles.map(c => c.close);
                if (candles.length >= 50) {
                    const signal = analyzeSignal(prices, candles, assetConfig.class, assetConfig);
                    console.log(`📊 ${displayName} - ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0, 2).join(', ') || 'No setup'}`);
                    if (signal.bias !== 'WAIT' && signal.confidence >= 55) {
                        await sendTelegramAlert(displayName, signal, assetConfig);
                    }
                }
            }
            state = {
                bucket: bucket,
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

// ========== MAIN ==========
async function main() {
    console.log('--- OMNI-SIGNAL FINAL v10.0 (Lot size caps, safe trading) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: ${DEFAULT_MODE} | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);

    let eurusd, gbpusd, usdjpy, usdcad, usdchf, usdsek;
    try {
        eurusd = await fetchForexPrice('EUR', 'USD');
        gbpusd = await fetchForexPrice('GBP', 'USD');
        usdjpy = await fetchForexPrice('USD', 'JPY');
        usdcad = await fetchForexPrice('USD', 'CAD');
        usdchf = await fetchForexPrice('USD', 'CHF');
        usdsek = await fetchForexPrice('USD', 'SEK');
    } catch(e) { console.error('Forex DXY error:', e.message); }

    let dxyPrice = null;
    if (eurusd && gbpusd && usdjpy && usdcad && usdchf && usdsek) {
        dxyPrice = calculateDXY(eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf);
        console.log(`✓ DXY: ${dxyPrice.toFixed(4)}`);
    }

    const forex = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD', config: ASSET_CONFIGS.eurusd },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD', config: ASSET_CONFIGS.gbpusd },
        { file: 'usdjpy', fetcher: () => fetchForexPrice('USD', 'JPY'), display: 'USD/JPY', config: ASSET_CONFIGS.usdjpy },
        { file: 'usdcad', fetcher: () => fetchForexPrice('USD', 'CAD'), display: 'USD/CAD', config: ASSET_CONFIGS.usdcad },
        { file: 'usdchf', fetcher: () => fetchForexPrice('USD', 'CHF'), display: 'USD/CHF', config: ASSET_CONFIGS.usdchf },
        { file: 'usdsek', fetcher: () => fetchForexPrice('USD', 'SEK'), display: 'USD/SEK', config: ASSET_CONFIGS.usdsek }
    ];
    const crypto = [
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD', config: ASSET_CONFIGS.btcusd },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD', config: ASSET_CONFIGS.ethusd },
        { file: 'solusd', fetcher: () => fetchCryptoPrice('solana'), display: 'SOL/USD', config: ASSET_CONFIGS.solusd }
    ];
    const metals = [
        { file: 'xauusd', fetcher: fetchGoldPrice, display: 'XAUUSD (Gold)', config: ASSET_CONFIGS.xauusd },
        { file: 'xagusd', fetcher: fetchSilverPrice, display: 'XAGUSD (Silver)', config: ASSET_CONFIGS.xagusd }
    ];
    const oil = [
        { file: 'wtiusd', fetcher: fetchOilPrice, display: 'WTI Oil', config: ASSET_CONFIGS.wtiusd, isOil: true }
    ];

    for (const a of forex) await processAsset(a.file, a.fetcher, a.display, a.config);
    console.log('⏸️ 1.5s delay...'); await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < crypto.length; i++) { 
        await processAsset(crypto[i].file, crypto[i].fetcher, crypto[i].display, crypto[i].config); 
        if (i < crypto.length - 1) await new Promise(r => setTimeout(r, 1500)); 
    }
    console.log('⏸️ 1.5s delay...'); await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < metals.length; i++) { 
        await processAsset(metals[i].file, metals[i].fetcher, metals[i].display, metals[i].config); 
        if (i < metals.length - 1) await new Promise(r => setTimeout(r, 1500)); 
    }
    console.log('⏸️ 1.5s delay...'); await new Promise(r => setTimeout(r, 1500));
    for (const a of oil) await processAsset(a.file, a.fetcher, a.display, a.config, true);

    if (dxyPrice) {
        const dxyData = { currentPrice: dxyPrice, timestamp: Date.now(), candles: [] };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(dxyData, null, 2));
    }
    console.log('--- Completed ---');
}

main().catch(err => console.error('Fatal error:', err));
