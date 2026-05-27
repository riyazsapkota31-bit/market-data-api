// fetch-prices.js – v10.1 (Persistent Session High/Low Strategy)

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
const DAILY_HL_FILE = path.join(dataDir, 'daily_highs_lows.json');  // NEW: Persistent storage
let oilRunCounter = 0;

// ========== SESSION HIGH/LOW CONFIGURATION ==========
const SESSION_CONFIG = {
    trackSessions: ['LONDON', 'NEW_YORK'],
    minRangePips: {
        forex: 15,
        crypto: 100,
        commodities: 20
    },
    proximityThreshold: 0.15,
    requireSweepConfirmation: true,
    tradingHours: {
        start: 12,
        end: 16
    },
    // NEW: Use yesterday's H/L if today's range is too small
    useYesterdayIfSmallRange: true,
    minRangeToTrade: 10  // minimum pips for forex
};

const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex', minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    usdjpy: { multiplier: 100, spread: 0.03, digits: 3, class: 'forex', minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    usdcad: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    usdchf: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    usdsek: { multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex', minStopPips: 20, maxStopPips: 40, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto', minStopPips: 800, maxStopPips: 2000, atrMultiplier: 0.8, maxLot: 0.5, tpMultiplier: 2.5 },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto', minStopPips: 50, maxStopPips: 120, atrMultiplier: 0.8, maxLot: 5.0, tpMultiplier: 2.5 },
    solusd: { multiplier: 10, spread: 0.50, digits: 2, class: 'crypto', minStopPips: 5, maxStopPips: 15, atrMultiplier: 0.8, maxLot: 50.0, tpMultiplier: 2.5 },
    xauusd: { multiplier: 100, spread: 0.35, digits: 2, class: 'commodities', minStopPips: 15.0, maxStopPips: 35.0, atrMultiplier: 0.8, maxLot: 0.5, tpMultiplier: 2.0 },
    xagusd: { multiplier: 100, spread: 0.04, digits: 3, class: 'commodities', minStopPips: 0.50, maxStopPips: 1.20, atrMultiplier: 0.8, maxLot: 0.5, tpMultiplier: 2.0 },
    wtiusd: { multiplier: 100, spread: 0.05, digits: 2, class: 'commodities', minStopPips: 0.60, maxStopPips: 1.50, atrMultiplier: 0.6, maxLot: 1.0, tpMultiplier: 2.0 },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex', minStopPips: 15, maxStopPips: 40, atrMultiplier: 0.6, maxLot: 5.0, tpMultiplier: 2.0 }
};

// ---------- UTILITIES ----------
function loadCooldown() {
    if (fs.existsSync(COOLDOWN_FILE)) {
        try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE)); } catch(e) {}
    }
    return {};
}
function saveCooldown(cooldown) { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown, null, 2)); }
function isCooldownActive(symbol, bias) {
    const cooldown = loadCooldown();
    const key = `${symbol}_${bias}`;
    const lastAlert = cooldown[key];
    if (!lastAlert) return false;
    return (Date.now() - lastAlert) < 2 * 60 * 60 * 1000;
}
function setCooldown(symbol, bias) {
    const cooldown = loadCooldown();
    cooldown[`${symbol}_${bias}`] = Date.now();
    saveCooldown(cooldown);
}

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
let lastOilPrice = null, lastOilFetchTime = 0;
async function fetchOilPrice() {
    if (!ALPHA_VANTAGE_KEY) throw new Error('ALPHA_VANTAGE_KEY missing');
    oilRunCounter++;
    if (oilRunCounter % 3 !== 1) {
        if (lastOilPrice) return lastOilPrice;
        throw new Error('No cached oil');
    }
    const now = Date.now();
    if (lastOilPrice && (now - lastOilFetchTime) < 120000) return lastOilPrice;
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=CL&apikey=${ALPHA_VANTAGE_KEY}`;
    const data = await fetchJSON(url);
    const quote = data['Global Quote'];
    if (quote && quote['05. price']) {
        const price = parseFloat(quote['05. price']);
        if (!isNaN(price) && price > 50 && price < 150) {
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
function getSessionMultiplier() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    if ((utcHour === 7 && utcMinute < 30) || (utcHour === 12 && utcMinute < 30)) return 1.5;
    if ((utcHour >= 7 && utcHour < 16) || (utcHour >= 12 && utcHour < 20)) return 1.0;
    return 0.5;
}
function getCurrentSession() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    if (utcHour >= 7 && utcHour < 16) return 'LONDON';
    if (utcHour >= 12 && utcHour < 20) return 'NEW_YORK';
    return 'OFF_HOURS';
}

// ========== NEW: PERSISTENT DAILY HIGH/LOW STORAGE ==========
function updateDailyHighLow(symbol, price, timestamp) {
    let dailyData = {};
    if (fs.existsSync(DAILY_HL_FILE)) {
        try { dailyData = JSON.parse(fs.readFileSync(DAILY_HL_FILE)); } catch(e) {}
    }
    
    const date = new Date(timestamp);
    const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    
    if (!dailyData[symbol]) {
        dailyData[symbol] = {};
    }
    
    if (!dailyData[symbol][dateStr]) {
        dailyData[symbol][dateStr] = { 
            high: price, 
            low: price, 
            updated: timestamp,
            open: price,
            close: null
        };
    } else {
        if (price > dailyData[symbol][dateStr].high) dailyData[symbol][dateStr].high = price;
        if (price < dailyData[symbol][dateStr].low) dailyData[symbol][dateStr].low = price;
        dailyData[symbol][dateStr].updated = timestamp;
        dailyData[symbol][dateStr].close = price;
    }
    
    // Keep last 30 days only
    const dates = Object.keys(dailyData[symbol]).sort();
    while (dates.length > 30) {
        delete dailyData[symbol][dates.shift()];
    }
    
    fs.writeFileSync(DAILY_HL_FILE, JSON.stringify(dailyData, null, 2));
}

function getDailyHighLow(symbol) {
    if (!fs.existsSync(DAILY_HL_FILE)) return null;
    
    try {
        const dailyData = JSON.parse(fs.readFileSync(DAILY_HL_FILE));
        const now = new Date();
        const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
        
        if (!dailyData[symbol] || !dailyData[symbol][todayStr]) return null;
        
        const today = dailyData[symbol][todayStr];
        return {
            high: today.high,
            low: today.low,
            range: today.high - today.low,
            open: today.open,
            close: today.close
        };
    } catch(e) {
        return null;
    }
}

function getYesterdayHighLow(symbol) {
    if (!fs.existsSync(DAILY_HL_FILE)) return null;
    
    try {
        const dailyData = JSON.parse(fs.readFileSync(DAILY_HL_FILE));
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setUTCDate(now.getUTCDate() - 1);
        const yesterdayStr = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`;
        
        if (!dailyData[symbol] || !dailyData[symbol][yesterdayStr]) return null;
        
        const yesterdayData = dailyData[symbol][yesterdayStr];
        return {
            high: yesterdayData.high,
            low: yesterdayData.low,
            range: yesterdayData.high - yesterdayData.low,
            isYesterday: true
        };
    } catch(e) {
        return null;
    }
}

function isWithinTradingHours() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    return utcHour >= SESSION_CONFIG.tradingHours.start && utcHour < SESSION_CONFIG.tradingHours.end;
}

function isPriceNearLevel(price, level, range) {
    if (!range || range === 0) return false;
    const threshold = range * SESSION_CONFIG.proximityThreshold;
    return Math.abs(price - level) <= threshold;
}

function detectSweepOfLevel(candles, level, bias, lookback = 8) {
    if (candles.length < lookback) return { detected: false, direction: null };
    
    const recentCandles = candles.slice(-lookback);
    
    for (const candle of recentCandles) {
        if (bias === 'BUY') {
            // Bullish sweep: price went below level, closed above it with bullish candle
            if (candle.low < level && candle.close > level && candle.close > candle.open) {
                return { detected: true, direction: 'BULLISH', candle: candle };
            }
        } else if (bias === 'SELL') {
            // Bearish sweep: price went above level, closed below it with bearish candle
            if (candle.high > level && candle.close < level && candle.close < candle.open) {
                return { detected: true, direction: 'BEARISH', candle: candle };
            }
        }
    }
    
    return { detected: false, direction: null };
}

function checkRangeReversalPattern(candles, level, bias) {
    if (candles.length < 3) return false;
    
    const lastThree = candles.slice(-3);
    
    if (bias === 'BUY') {
        const sweepCandle = lastThree.find(c => c.low < level && c.close > c.open);
        const afterSweep = lastThree.slice(lastThree.indexOf(sweepCandle) + 1);
        if (sweepCandle && afterSweep.length > 0) {
            return afterSweep.some(c => c.close > sweepCandle.high);
        }
    } else if (bias === 'SELL') {
        const sweepCandle = lastThree.find(c => c.high > level && c.close < c.open);
        const afterSweep = lastThree.slice(lastThree.indexOf(sweepCandle) + 1);
        if (sweepCandle && afterSweep.length > 0) {
            return afterSweep.some(c => c.close < sweepCandle.low);
        }
    }
    
    return false;
}

// ========== NEW: SESSION HIGH/LOW STRATEGY SIGNAL (with persistent storage) ==========
function analyzeSessionHighLowStrategy(candles, assetConfig, currentPrice, symbol) {
    // 1. Check if within trading hours
    if (!isWithinTradingHours()) {
        return { bias: 'WAIT', grade: 'REJECT', reasons: ['⏸️ Outside trading hours (12:00-16:00 UTC)'] };
    }
    
    // 2. Get today's H/L from persistent storage
    let dailyHL = getDailyHighLow(symbol);
    let usingYesterday = false;
    
    // 3. If today's data is insufficient, try yesterday's
    if (!dailyHL || dailyHL.range === 0) {
        if (SESSION_CONFIG.useYesterdayIfSmallRange) {
            const yesterdayHL = getYesterdayHighLow(symbol);
            if (yesterdayHL && yesterdayHL.range > 0) {
                dailyHL = yesterdayHL;
                usingYesterday = true;
                console.log(`⚠️ ${symbol}: Using yesterday's H/L (today's data insufficient)`);
            }
        }
    }
    
    if (!dailyHL || dailyHL.range === 0) {
        return { bias: 'WAIT', grade: 'REJECT', reasons: ['⏸️ No daily H/L data available'] };
    }
    
    // 4. Check minimum range requirement
    const rangeInPips = dailyHL.range * assetConfig.multiplier;
    const minRange = SESSION_CONFIG.minRangePips[assetConfig.class] || 10;
    
    if (rangeInPips < minRange) {
        return { bias: 'WAIT', grade: 'REJECT', reasons: [`⏸️ Range too small (${rangeInPips.toFixed(1)} < ${minRange} pips)`] };
    }
    
    // 5. Determine if price is near High or Low
    const nearHigh = isPriceNearLevel(currentPrice, dailyHL.high, dailyHL.range);
    const nearLow = isPriceNearLevel(currentPrice, dailyHL.low, dailyHL.range);
    
    if (!nearHigh && !nearLow) {
        return { bias: 'WAIT', grade: 'REJECT', reasons: ['⏸️ Price not near session H/L'] };
    }
    
    // 6. Determine bias and level
    let bias = null;
    let level = null;
    let levelType = null;
    
    if (nearHigh) {
        bias = 'SELL';
        level = dailyHL.high;
        levelType = 'RESISTANCE';
    } else if (nearLow) {
        bias = 'BUY';
        level = dailyHL.low;
        levelType = 'SUPPORT';
    }
    
    // 7. Detect sweep confirmation
    let sweepResult = { detected: false, direction: null };
    if (SESSION_CONFIG.requireSweepConfirmation) {
        sweepResult = detectSweepOfLevel(candles, level, bias, 10);
        if (!sweepResult.detected) {
            return { bias: 'WAIT', grade: 'REJECT', reasons: [`⏸️ No sweep confirmation at ${levelType}`] };
        }
        if ((bias === 'BUY' && sweepResult.direction !== 'BULLISH') ||
            (bias === 'SELL' && sweepResult.direction !== 'BEARISH')) {
            return { bias: 'WAIT', grade: 'REJECT', reasons: ['⏸️ Sweep direction does not match bias'] };
        }
    }
    
    // 8. Check for reversal pattern
    const hasReversalPattern = checkRangeReversalPattern(candles, level, bias);
    
    // 9. Calculate signal strength
    let score = 70;
    let expectedWinRate = 65;
    let grade = 'B+';
    let reasons = [];
    
    reasons.push(`${bias === 'BUY' ? '🟢' : '🔴'} ${bias} | Session H/L Strategy${usingYesterday ? ' (using yesterday\'s levels)' : ''}`);
    reasons.push(`📊 ${usingYesterday ? 'Yesterday\'s' : 'Today\'s'} range: ${dailyHL.high.toFixed(assetConfig.digits)} / ${dailyHL.low.toFixed(assetConfig.digits)} (${rangeInPips.toFixed(1)} pips)`);
    reasons.push(`📍 Trading near session ${levelType} at ${level.toFixed(assetConfig.digits)}`);
    
    if (sweepResult.detected) {
        score += 15;
        expectedWinRate += 8;
        reasons.push(`💧 Liquidity sweep confirmed at ${levelType}`);
    }
    
    if (hasReversalPattern) {
        score += 10;
        expectedWinRate += 5;
        reasons.push(`🕯️ Reversal pattern confirmed`);
    }
    
    // Count how many times level was tested (from candle data)
    let touchCount = 0;
    const recentCandles = candles.slice(-50);
    for (const c of recentCandles) {
        if (Math.abs(c.high - level) / level < 0.0003) touchCount++;
        if (Math.abs(c.low - level) / level < 0.0003) touchCount++;
    }
    
    if (touchCount >= 3) {
        score += 10;
        expectedWinRate += 5;
        reasons.push(`🔁 Level tested ${touchCount} times (strong S/R)`);
    }
    
    // Determine grade
    if (expectedWinRate >= 75) grade = 'A';
    else if (expectedWinRate >= 70) grade = 'A-';
    else if (expectedWinRate >= 65) grade = 'B+';
    else grade = 'B';
    
    score = Math.min(100, score);
    expectedWinRate = Math.min(85, expectedWinRate);
    
    // 10. Set stop loss (just beyond H/L)
    const buffer = dailyHL.range * 0.05;
    const stopLoss = bias === 'BUY' 
        ? level - buffer
        : level + buffer;
    
    // 11. Set take profit (mid-range or 1.5x risk)
    const midRange = (dailyHL.high + dailyHL.low) / 2;
    const risk = Math.abs(currentPrice - stopLoss);
    const minRR = 1.5;
    
    let takeProfit;
    if (bias === 'BUY') {
        const potentialTP = Math.max(midRange, currentPrice + (risk * minRR));
        takeProfit = potentialTP;
    } else {
        const potentialTP = Math.min(midRange, currentPrice - (risk * minRR));
        takeProfit = potentialTP;
    }
    
    const rrRatio = Math.abs(takeProfit - currentPrice) / risk;
    
    return {
        bias,
        grade,
        expectedWinRate,
        positionMultiplier: 1.0,
        entry: currentPrice,
        stopLoss,
        takeProfit,
        rrRatio: rrRatio.toFixed(1),
        strategy: 'SessionHL',
        reasons,
        currentPrice,
        level,
        levelType,
        dailyHL,
        usingYesterday
    };
}

// ========== INSTITUTIONAL FOOTPRINTS (Keeping all existing code) ==========
function getKeyLevels(candles, currentPrice) {
    const levels = [];
    const dayCandles = candles.slice(-288);
    if (dayCandles.length > 0) {
        levels.push({ price: Math.max(...dayCandles.map(c => c.high)), type: 'RESISTANCE', strength: 'MAJOR', touches: 0, quality: 100 });
        levels.push({ price: Math.min(...dayCandles.map(c => c.low)), type: 'SUPPORT', strength: 'MAJOR', touches: 0, quality: 100 });
    }
    if (candles.length >= 1440) {
        const weekCandles = candles.slice(-1440);
        levels.push({ price: Math.max(...weekCandles.map(c => c.high)), type: 'RESISTANCE', strength: 'MAJOR', touches: 0, quality: 100 });
        levels.push({ price: Math.min(...weekCandles.map(c => c.low)), type: 'SUPPORT', strength: 'MAJOR', touches: 0, quality: 100 });
    }
    const levelMap = new Map();
    for (let i = 20; i < candles.length - 5; i++) {
        const isSwingHigh = candles[i].high > candles[i-2].high && candles[i].high > candles[i-1].high &&
                            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        const isSwingLow = candles[i].low < candles[i-2].low && candles[i].low < candles[i-1].low &&
                           candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
        if (isSwingHigh) {
            const price = candles[i].high;
            const rounded = Math.round(price * 100) / 100;
            let touches = 0;
            for (let j = Math.max(0, i - 30); j <= Math.min(candles.length - 1, i + 10); j++) {
                if (Math.abs(candles[j].high - price) / price < 0.0003) touches++;
            }
            let quality = Math.min(90, 30 + (touches * 20));
            if (!levelMap.has(rounded) && quality >= 70) levelMap.set(rounded, { price, touches, quality, type: 'RESISTANCE' });
        }
        if (isSwingLow) {
            const price = candles[i].low;
            const rounded = Math.round(price * 100) / 100;
            let touches = 0;
            for (let j = Math.max(0, i - 30); j <= Math.min(candles.length - 1, i + 10); j++) {
                if (Math.abs(candles[j].low - price) / price < 0.0003) touches++;
            }
            let quality = Math.min(90, 30 + (touches * 20));
            if (!levelMap.has(rounded) && quality >= 70) levelMap.set(rounded, { price, touches, quality, type: 'SUPPORT' });
        }
    }
    for (const [_, level] of levelMap) {
        levels.push({ price: level.price, type: level.type, strength: 'MINOR', touches: level.touches, quality: level.quality });
    }
    const roundNumber = Math.round(currentPrice / 10) * 10;
    let roundTouches = 0;
    for (let i = Math.max(0, candles.length - 100); i < candles.length; i++) {
        if (Math.abs(candles[i].high - roundNumber) / roundNumber < 0.0003) roundTouches++;
        if (Math.abs(candles[i].low - roundNumber) / roundNumber < 0.0003) roundTouches++;
    }
    if (roundTouches >= 2) {
        levels.push({ price: roundNumber, type: 'ROUND_NUMBER', strength: 'ROUND', touches: roundTouches, quality: Math.min(80, 50 + roundTouches * 10) });
    }
    const unique = [];
    for (const level of levels) {
        let duplicate = false;
        for (const existing of unique) {
            if (Math.abs(existing.price - level.price) / level.price < 0.0005) { duplicate = true; break; }
        }
        if (!duplicate) unique.push(level);
    }
    unique.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
    return unique;
}
function isAtSupport(price, levels) {
    for (const level of levels) {
        if (level.type === 'SUPPORT' && Math.abs(price - level.price) / price < 0.0005) {
            return { atLevel: true, level: level.price, strength: level.strength, quality: level.quality || 100 };
        }
    }
    return { atLevel: false };
}
function isAtResistance(price, levels) {
    for (const level of levels) {
        if (level.type === 'RESISTANCE' && Math.abs(price - level.price) / price < 0.0005) {
            return { atLevel: true, level: level.price, strength: level.strength, quality: level.quality || 100 };
        }
    }
    return { atLevel: false };
}
function detectBOS(candles) {
    if (candles.length < 50) return null;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const last50High = Math.max(...highs.slice(-50));
    const previousHigh = Math.max(...highs.slice(-100, -50));
    const last50Low = Math.min(...lows.slice(-50));
    const previousLow = Math.min(...lows.slice(-100, -50));
    if (last50High > previousHigh) return { type: 'BULLISH', level: previousHigh };
    if (last50Low < previousLow) return { type: 'BEARISH', level: previousLow };
    const recentHigh = Math.max(...highs.slice(-15));
    const recentPrevHigh = Math.max(...highs.slice(-30, -15));
    const recentLow = Math.min(...lows.slice(-15));
    const recentPrevLow = Math.min(...lows.slice(-30, -15));
    if (recentHigh > recentPrevHigh) return { type: 'BULLISH', level: recentPrevHigh };
    if (recentLow < recentPrevLow) return { type: 'BEARISH', level: recentPrevLow };
    return null;
}
function detectFVG(candles) {
    if (candles.length < 3) return null;
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];
    if (c1.high < c3.low) return { type: 'BULLISH', level: c1.high, level2: c3.low };
    if (c3.high < c1.low) return { type: 'BEARISH', level: c3.high, level2: c1.low };
    return null;
}
function detectOrderBlock(candles) {
    if (candles.length < 3) return null;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    if (prev.close < prev.open && last.close > last.open && last.close > prev.high) return { type: 'BULLISH', level: prev.low };
    if (prev.close > prev.open && last.close < last.open && last.close < prev.low) return { type: 'BEARISH', level: prev.high };
    return null;
}
function checkRetracement(candles, level) {
    if (candles.length < 10) return false;
    const recent = candles.slice(-10);
    for (const c of recent) {
        if (Math.abs(c.low - level) / level < 0.0015) return true;
        if (Math.abs(c.high - level) / level < 0.0015) return true;
    }
    return false;
}
function detectLiquiditySweep(candles, level, bias) {
    if (candles.length < 5) return { detected: false, direction: null };
    const recent = candles.slice(-5);
    for (const c of recent) {
        if (c.low < level && c.close > level && c.close > c.open) {
            return { detected: true, direction: 'BULLISH' };
        }
        if (c.high > level && c.close < level && c.close < c.open) {
            return { detected: true, direction: 'BEARISH' };
        }
    }
    return { detected: false, direction: null };
}
function detectMSS(candles, bias) {
    if (candles.length < 20) return { detected: false, strength: 0 };
    const recentCandles = candles.slice(-18);
    let lastSwingHigh = -Infinity, lastSwingLow = Infinity, swingIndex = -1;
    for (let i = 4; i < recentCandles.length - 4; i++) {
        const isSwingHigh = recentCandles[i].high > recentCandles[i-1].high && recentCandles[i].high > recentCandles[i-2].high &&
                            recentCandles[i].high > recentCandles[i+1].high && recentCandles[i].high > recentCandles[i+2].high;
        const isSwingLow = recentCandles[i].low < recentCandles[i-1].low && recentCandles[i].low < recentCandles[i-2].low &&
                           recentCandles[i].low < recentCandles[i+1].low && recentCandles[i].low < recentCandles[i+2].low;
        if (isSwingHigh && recentCandles[i].high > lastSwingHigh) { lastSwingHigh = recentCandles[i].high; swingIndex = i; }
        if (isSwingLow && recentCandles[i].low < lastSwingLow) { lastSwingLow = recentCandles[i].low; swingIndex = i; }
    }
    if (swingIndex === -1 || swingIndex >= recentCandles.length - 3) return { detected: false, strength: 0 };
    const candlesAfter = recentCandles.slice(swingIndex + 1);
    if (candlesAfter.length < 3) return { detected: false, strength: 0 };
    if (bias === 'BUY') {
        const higherLow = Math.min(...candlesAfter.map(c => c.low)) > lastSwingLow;
        const higherHigh = Math.max(...candlesAfter.map(c => c.high)) > lastSwingHigh;
        if (higherLow && higherHigh) return { detected: true, strength: 80 };
    } else {
        const lowerHigh = Math.max(...candlesAfter.map(c => c.high)) < lastSwingHigh;
        const lowerLow = Math.min(...candlesAfter.map(c => c.low)) < lastSwingLow;
        if (lowerHigh && lowerLow) return { detected: true, strength: 80 };
    }
    return { detected: false, strength: 0 };
}
function detectCandlePattern(candles, bias) {
    if (candles.length < 2) return { detected: false, pattern: null };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (bias === 'BUY') {
        const bullishEngulfing = prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close;
        if (bullishEngulfing) return { detected: true, pattern: 'BULLISH_ENGULFING' };
        const bodySize = Math.abs(last.close - last.open);
        const lowerWick = Math.min(last.open, last.close) - last.low;
        if (lowerWick > bodySize * 2 && last.close > last.open) return { detected: true, pattern: 'BULLISH_PINBAR' };
    } else {
        const bearishEngulfing = prev.close > prev.open && last.close < last.open && last.close < prev.open && last.open > prev.close;
        if (bearishEngulfing) return { detected: true, pattern: 'BEARISH_ENGULFING' };
        const bodySize = Math.abs(last.close - last.open);
        const upperWick = last.high - Math.max(last.open, last.close);
        if (upperWick > bodySize * 2 && last.close < last.open) return { detected: true, pattern: 'BEARISH_PINBAR' };
    }
    return { detected: false, pattern: null };
}
function detectDoubleSweep(candles) {
    if (candles.length < 30) return false;
    const recentHighs = [];
    const recentLows = [];
    for (let i = candles.length - 30; i < candles.length; i++) {
        recentHighs.push(candles[i].high);
        recentLows.push(candles[i].low);
    }
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    let sweepCount = 0;
    for (let i = candles.length - 5; i < candles.length; i++) {
        if (candles[i].high > highestHigh && candles[i].close < highestHigh) sweepCount++;
        if (candles[i].low < lowestLow && candles[i].close > lowestLow) sweepCount++;
    }
    return sweepCount >= 2;
}
function detectTrendlineBreakRetest(candles) {
    if (candles.length < 20) return { detected: false, direction: null };
    const swingPoints = [];
    for (let i = 5; i < candles.length - 5; i++) {
        const isSwingHigh = candles[i].high > candles[i-2].high && candles[i].high > candles[i-1].high &&
                            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        const isSwingLow = candles[i].low < candles[i-2].low && candles[i].low < candles[i-1].low &&
                           candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
        if (isSwingHigh) swingPoints.push({ price: candles[i].high, type: 'HIGH', index: i });
        if (isSwingLow) swingPoints.push({ price: candles[i].low, type: 'LOW', index: i });
    }
    if (swingPoints.length < 5) return { detected: false, direction: null };
    const lastTwo = swingPoints.slice(-2);
    if (lastTwo.length !== 2) return { detected: false, direction: null };
    const trendlineSlope = (lastTwo[1].price - lastTwo[0].price) / (lastTwo[1].index - lastTwo[0].index);
    const lastCandle = candles[candles.length - 1];
    const projected = lastTwo[0].price + trendlineSlope * (lastCandle.index - lastTwo[0].index);
    const broke = (trendlineSlope > 0 && lastCandle.high > projected) || (trendlineSlope < 0 && lastCandle.low < projected);
    if (!broke) return { detected: false, direction: null };
    const retest = Math.abs(lastCandle.close - projected) / projected < 0.001;
    if (retest) {
        return { detected: true, direction: trendlineSlope > 0 ? 'BUY' : 'SELL' };
    }
    return { detected: false, direction: null };
}
function detectScaledRSIDivergence(prices, rsi) {
    if (prices.length < 20) return { direction: null, strength: 0 };
    const recentPrices = prices.slice(-20);
    const recentRSI = rsi.slice(-20);
    let priceSwingHigh = -Infinity, priceSwingLow = Infinity;
    let rsiSwingHigh = -Infinity, rsiSwingLow = Infinity;
    for (let i = 5; i < recentPrices.length - 5; i++) {
        if (recentPrices[i] > recentPrices[i-1] && recentPrices[i] > recentPrices[i-2] &&
            recentPrices[i] > recentPrices[i+1] && recentPrices[i] > recentPrices[i+2]) {
            priceSwingHigh = recentPrices[i];
            rsiSwingHigh = recentRSI[i];
        }
        if (recentPrices[i] < recentPrices[i-1] && recentPrices[i] < recentPrices[i-2] &&
            recentPrices[i] < recentPrices[i+1] && recentPrices[i] < recentPrices[i+2]) {
            priceSwingLow = recentPrices[i];
            rsiSwingLow = recentRSI[i];
        }
    }
    const lastPrice = recentPrices[recentPrices.length-1];
    const lastRSI = recentRSI[recentRSI.length-1];
    let direction = null;
    let strength = 0;
    if (lastPrice < priceSwingLow && lastRSI > rsiSwingLow) {
        direction = 'BUY';
        strength = (lastRSI - rsiSwingLow) > 10 ? 85 : 50;
    } else if (lastPrice > priceSwingHigh && lastRSI < rsiSwingHigh) {
        direction = 'SELL';
        strength = (rsiSwingHigh - lastRSI) > 10 ? 85 : 50;
    }
    return { direction, strength };
}
function detectThreeDrive(candles) {
    if (candles.length < 30) return { detected: false, direction: null };
    const swingPoints = [];
    for (let i = 8; i < candles.length - 8; i++) {
        const isSwingHigh = candles[i].high > candles[i-3].high && candles[i].high > candles[i-2].high &&
                            candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high &&
                            candles[i].high > candles[i+2].high && candles[i].high > candles[i+3].high;
        const isSwingLow = candles[i].low < candles[i-3].low && candles[i].low < candles[i-2].low &&
                           candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low &&
                           candles[i].low < candles[i+2].low && candles[i].low < candles[i+3].low;
        if (isSwingHigh) swingPoints.push({ price: candles[i].high, type: 'HIGH', index: i });
        if (isSwingLow) swingPoints.push({ price: candles[i].low, type: 'LOW', index: i });
    }
    if (swingPoints.length < 5) return { detected: false, direction: null };
    const lastFive = swingPoints.slice(-5);
    const [p1, p2, p3, p4, p5] = lastFive;
    if (!p1 || !p2 || !p3 || !p4 || !p5) return { detected: false, direction: null };
    const drive1Size = Math.abs(p2.price - p1.price);
    const drive2Size = Math.abs(p3.price - p2.price);
    const drive3Size = Math.abs(p5.price - p4.price);
    if (drive2Size > drive1Size && drive2Size > drive3Size) {
        if (p1.type === 'LOW' && p2.type === 'HIGH' && p3.type === 'LOW' && p4.type === 'HIGH' && p5.type === 'LOW') {
            return { detected: true, direction: 'BUY' };
        }
        if (p1.type === 'HIGH' && p2.type === 'LOW' && p3.type === 'HIGH' && p4.type === 'LOW' && p5.type === 'HIGH') {
            return { detected: true, direction: 'SELL' };
        }
    }
    return { detected: false, direction: null };
}
function detectHeadAndShoulders(candles) {
    if (candles.length < 30) return { detected: false, direction: null, neckline: null };
    const swingPoints = [];
    for (let i = 8; i < candles.length - 8; i++) {
        const isSwingHigh = candles[i].high > candles[i-3].high && candles[i].high > candles[i-2].high &&
                            candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high &&
                            candles[i].high > candles[i+2].high && candles[i].high > candles[i+3].high;
        const isSwingLow = candles[i].low < candles[i-3].low && candles[i].low < candles[i-2].low &&
                           candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low &&
                           candles[i].low < candles[i+2].low && candles[i].low < candles[i+3].low;
        if (isSwingHigh) swingPoints.push({ price: candles[i].high, type: 'HIGH', index: i });
        if (isSwingLow) swingPoints.push({ price: candles[i].low, type: 'LOW', index: i });
    }
    if (swingPoints.length < 5) return { detected: false, direction: null, neckline: null };
    const lastFive = swingPoints.slice(-5);
    const [ls, h, rs] = lastFive;
    if (!ls || !h || !rs) return { detected: false, direction: null, neckline: null };
    if (ls.type === 'HIGH' && h.type === 'HIGH' && rs.type === 'HIGH' &&
        h.price > ls.price && h.price > rs.price) {
        const necklineCandles = candles.slice(ls.index, rs.index);
        let neckline = Infinity;
        for (const c of necklineCandles) {
            if (c.low < neckline) neckline = c.low;
        }
        const lastCandle = candles[candles.length-1];
        const brokeNeckline = lastCandle.close < neckline;
        if (brokeNeckline) return { detected: true, direction: 'SELL', neckline: neckline };
    }
    const inverse = lastFive.filter(p => p.type === 'LOW');
    if (inverse.length >= 3) {
        const [lsInv, hInv, rsInv] = inverse.slice(-3);
        if (lsInv && hInv && rsInv && hInv.price < lsInv.price && hInv.price < rsInv.price) {
            const necklineCandles = candles.slice(lsInv.index, rsInv.index);
            let neckline = -Infinity;
            for (const c of necklineCandles) {
                if (c.high > neckline) neckline = c.high;
            }
            const lastCandle = candles[candles.length-1];
            const brokeNeckline = lastCandle.close > neckline;
            if (brokeNeckline) return { detected: true, direction: 'BUY', neckline: neckline };
        }
    }
    return { detected: false, direction: null, neckline: null };
}

// ========== SCORING SYSTEM (Keeping original) ==========
function calculateSignalScore(factors) {
    const { hasBOS, hasKeyLevel, retraced, sweepDetected, sweepDirection, levelStrength, levelQuality, mss, candlePattern, fvg, ob, sessionBoost,
            doubleSweep, trendlineBreak, scaledRSIStrength, threeDrive, headShoulders, tradeDirection } = factors;
    
    if (!hasBOS || !hasKeyLevel) return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
    if (!retraced) return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
    
    if (sweepDetected && sweepDirection !== tradeDirection) {
        return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35, reason: 'Sweep direction opposes trade' };
    }
    if (fvg && fvg.type !== tradeDirection) {
        return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35, reason: 'FVG direction opposes trade' };
    }
    if (ob && ob.type !== tradeDirection) {
        return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35, reason: 'OB direction opposes trade' };
    }
    if (hasBOS && factors.bosDirection !== tradeDirection) {
        return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35, reason: 'BOS direction opposes trade' };
    }

    let score = 60;
    let positionMultiplier = 1.0;
    let expectedWinRate = 50;

    if (levelStrength === 'MAJOR') {
        score += 25;
        positionMultiplier = 1.0;
        expectedWinRate = 80;
    } else if (levelStrength === 'MINOR') {
        if (levelQuality >= 85) { score += 15; positionMultiplier = 0.95; expectedWinRate = 75; }
        else if (levelQuality >= 75) { score += 10; positionMultiplier = 0.85; expectedWinRate = 70; }
        else return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
    } else if (levelStrength === 'ROUND') {
        if (levelQuality >= 60) { score += 8; positionMultiplier = 0.8; expectedWinRate = 68; }
        else return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
    } else return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };

    if (mss && mss.detected) { score += (mss.strength >= 80 ? 12 : 6); expectedWinRate = Math.min(85, expectedWinRate + (mss.strength >= 80 ? 5 : 3)); }
    if (candlePattern && candlePattern.detected) { score += 10; expectedWinRate = Math.min(85, expectedWinRate + 4); }
    if (sessionBoost && (levelStrength === 'MAJOR' || levelQuality >= 75)) { score += 5; expectedWinRate = Math.min(85, expectedWinRate + 2); }

    if (doubleSweep) { score += 15; expectedWinRate = Math.min(85, expectedWinRate + 5); }
    if (trendlineBreak) { score += 12; expectedWinRate = Math.min(85, expectedWinRate + 4); }
    if (scaledRSIStrength === 85) { score += 10; expectedWinRate = Math.min(85, expectedWinRate + 5); }
    else if (scaledRSIStrength === 50) { score += 5; expectedWinRate = Math.min(85, expectedWinRate + 2); }
    if (threeDrive) { score += 20; expectedWinRate = Math.min(85, expectedWinRate + 8); }
    if (headShoulders) { score += 25; expectedWinRate = Math.min(85, expectedWinRate + 10); }

    score = Math.min(100, score);
    expectedWinRate = Math.min(85, expectedWinRate);
    let grade = 'B';
    let passed = true;
    if (expectedWinRate >= 75) { grade = 'A+'; positionMultiplier = Math.min(positionMultiplier, 1.0); }
    else if (expectedWinRate >= 70) { grade = 'A'; positionMultiplier = Math.min(positionMultiplier, 0.95); }
    else if (expectedWinRate >= 65) { grade = 'B+'; positionMultiplier = Math.min(positionMultiplier, 0.85); }
    else { passed = false; }
    return { score, grade, passed, positionMultiplier, expectedWinRate };
}

// ========== RISK MANAGEMENT ==========
function findLogicalStopLoss(candles, currentPrice, bias, assetConfig) {
    const { minStopPips, maxStopPips, atrMultiplier, spread } = assetConfig;
    let atrStop = minStopPips;
    if (candles && candles.length >= 20) {
        const recentCandles = candles.slice(-20);
        let sumTR = 0;
        for (let i = 1; i < recentCandles.length; i++) {
            const tr = Math.max(recentCandles[i].high - recentCandles[i].low,
                Math.abs(recentCandles[i].high - recentCandles[i-1].close),
                Math.abs(recentCandles[i].low - recentCandles[i-1].close));
            sumTR += tr;
        }
        const avgTR = sumTR / (recentCandles.length - 1);
        atrStop = avgTR * atrMultiplier;
    }
    let swingStop = null;
    if (candles && candles.length >= 40) {
        const recentCandles = candles.slice(-40);
        const swingPoints = [];
        for (let i = 5; i < recentCandles.length - 5; i++) {
            if (recentCandles[i].low < recentCandles[i-1].low && recentCandles[i].low < recentCandles[i-2].low &&
                recentCandles[i].low < recentCandles[i-3].low && recentCandles[i].low < recentCandles[i+1].low &&
                recentCandles[i].low < recentCandles[i+2].low && recentCandles[i].low < recentCandles[i+3].low)
                swingPoints.push({ price: recentCandles[i].low, type: 'LOW' });
            if (recentCandles[i].high > recentCandles[i-1].high && recentCandles[i].high > recentCandles[i-2].high &&
                recentCandles[i].high > recentCandles[i-3].high && recentCandles[i].high > recentCandles[i+1].high &&
                recentCandles[i].high > recentCandles[i+2].high && recentCandles[i].high > recentCandles[i+3].high)
                swingPoints.push({ price: recentCandles[i].high, type: 'HIGH' });
        }
        const buffer = currentPrice * 0.001;
        if (bias === 'BUY') {
            const validLows = swingPoints.filter(p => p.type === 'LOW' && p.price < currentPrice && (currentPrice - p.price) >= minStopPips);
            if (validLows.length > 0) {
                validLows.sort((a, b) => (currentPrice - b.price) - (currentPrice - a.price));
                swingStop = validLows[0].price - buffer;
            }
        } else {
            const validHighs = swingPoints.filter(p => p.type === 'HIGH' && p.price > currentPrice && (p.price - currentPrice) >= minStopPips);
            if (validHighs.length > 0) {
                validHighs.sort((a, b) => (a.price - currentPrice) - (b.price - currentPrice));
                swingStop = validHighs[0].price + buffer;
            }
        }
    }
    let finalStop, stopDistance;
    if (swingStop) { stopDistance = Math.abs(currentPrice - swingStop); finalStop = swingStop; }
    else { stopDistance = Math.max(atrStop, minStopPips); finalStop = bias === 'BUY' ? currentPrice - stopDistance : currentPrice + stopDistance; }
    if (stopDistance > maxStopPips) { stopDistance = maxStopPips; finalStop = bias === 'BUY' ? currentPrice - maxStopPips : currentPrice + maxStopPips; }
    const minSafeDistance = spread * 3;
    if (stopDistance < minSafeDistance) finalStop = bias === 'BUY' ? currentPrice - minSafeDistance : currentPrice + minSafeDistance;
    return finalStop;
}
function findLogicalTakeProfit(entry, stopLoss, bias, assetConfig, candles) {
    const risk = Math.abs(entry - stopLoss);
    const minRR = 1.6;
    const maxRR = 3.0;
    const preferredRR = assetConfig.tpMultiplier || 2.0;
    let logicalTP = null;
    let actualRR = minRR;
    if (candles && candles.length >= 50) {
        const recentCandles = candles.slice(-50);
        const resistanceLevels = [], supportLevels = [];
        for (let i = 5; i < recentCandles.length - 5; i++) {
            if (recentCandles[i].high > recentCandles[i-1].high && recentCandles[i].high > recentCandles[i+1].high &&
                recentCandles[i].high > recentCandles[i-2].high && recentCandles[i].high > recentCandles[i+2].high)
                resistanceLevels.push(recentCandles[i].high);
            if (recentCandles[i].low < recentCandles[i-1].low && recentCandles[i].low < recentCandles[i+1].low &&
                recentCandles[i].low < recentCandles[i-2].low && recentCandles[i].low < recentCandles[i+2].low)
                supportLevels.push(recentCandles[i].low);
        }
        const buffer = entry * 0.0005;
        if (bias === 'BUY') {
            const validResistances = resistanceLevels.filter(r => r > entry);
            validResistances.sort((a, b) => a - b);
            if (validResistances.length > 0) {
                const nextResistance = validResistances[0] - buffer;
                const potentialRR = (nextResistance - entry) / risk;
                if (potentialRR >= minRR) { logicalTP = nextResistance; actualRR = Math.min(potentialRR, maxRR); }
            }
        } else {
            const validSupports = supportLevels.filter(s => s < entry);
            validSupports.sort((a, b) => b - a);
            if (validSupports.length > 0) {
                const nextSupport = validSupports[0] + buffer;
                const potentialRR = (entry - nextSupport) / risk;
                if (potentialRR >= minRR) { logicalTP = nextSupport; actualRR = Math.min(potentialRR, maxRR); }
            }
        }
    }
    let takeProfit, isExtended = false;
    if (logicalTP) { takeProfit = logicalTP; if (actualRR > minRR + 0.01) isExtended = true; }
    else { const targetRR = Math.min(maxRR, Math.max(minRR, preferredRR)); takeProfit = bias === 'BUY' ? entry + (risk * targetRR) : entry - (risk * targetRR); actualRR = targetRR; isExtended = false; }
    if (actualRR < minRR) { actualRR = minRR; takeProfit = bias === 'BUY' ? entry + (risk * minRR) : entry - (risk * minRR); isExtended = false; }
    if (actualRR > maxRR) { actualRR = maxRR; takeProfit = bias === 'BUY' ? entry + (risk * maxRR) : entry - (risk * maxRR); isExtended = true; }
    return { takeProfit, rr: actualRR.toFixed(1), isExtended };
}
function calculateTradeLevels(price, bias, assetConfig, candles, positionMultiplier) {
    const stopLoss = findLogicalStopLoss(candles, price, bias, assetConfig);
    const entry = price;
    const { takeProfit, rr, isExtended } = findLogicalTakeProfit(entry, stopLoss, bias, assetConfig, candles);
    if (parseFloat(rr) < 1.6) return null;
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDistPoints = Math.abs(entry - stopLoss) * assetConfig.multiplier + assetConfig.spread;
    let lotSize = riskAmount / (stopDistPoints * assetConfig.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, assetConfig.maxLot));
    lotSize = lotSize * positionMultiplier;
    lotSize = Math.floor(lotSize * 1000) / 1000;
    return { entry: entry.toFixed(assetConfig.digits), sl: stopLoss.toFixed(assetConfig.digits), tp: takeProfit.toFixed(assetConfig.digits), rrRatio: rr, lotSize: lotSize.toFixed(2), isExtendedRR: isExtended };
}

// ========== MAIN SIGNAL ANALYSIS (with persistent Session H/L priority) ==========
function analyzeSignal(prices, candles, assetConfig, symbol) {
    if (candles.length < 50) return { bias: 'WAIT', confidence: 30, currentPrice: prices[prices.length-1] };
    const curPrice = prices[prices.length-1];
    
    // PRIORITY 1: Session High/Low Strategy (Only during 12-16 UTC)
    if (isWithinTradingHours()) {
        const sessionHLSignal = analyzeSessionHighLowStrategy(candles, assetConfig, curPrice, symbol);
        if (sessionHLSignal && sessionHLSignal.bias !== 'WAIT') {
            console.log(`🎯 Session H/L signal detected for ${symbol}`);
            return sessionHLSignal;
        }
    }
    
    // PRIORITY 2: Original Institutional Footprint Strategy
    const keyLevels = getKeyLevels(candles, curPrice);
    const atSupport = isAtSupport(curPrice, keyLevels);
    const atResistance = isAtResistance(curPrice, keyLevels);
    let levelStrength = null, levelQuality = 0, levelPrice = null;
    if (atSupport.atLevel) { levelStrength = atSupport.strength; levelQuality = atSupport.quality || 100; levelPrice = atSupport.level; }
    else if (atResistance.atLevel) { levelStrength = atResistance.strength; levelQuality = atResistance.quality || 100; levelPrice = atResistance.level; }
    if (levelStrength === 'MINOR' && levelQuality < 70) return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: [`⏸️ MINOR level quality ${levelQuality} < 70`] };
    
    const bos = detectBOS(candles);
    const fvg = detectFVG(candles);
    const ob = detectOrderBlock(candles);
    const sessionBoost = getSessionMultiplier() >= 1.0;
    
    let bias = null, targetLevel = null, retraced = false, sweepResult = { detected: false, direction: null }, mss = { detected: false }, candlePattern = { detected: false };
    
    if (atSupport.atLevel) {
        bias = 'BUY';
        targetLevel = fvg ? (fvg.type === 'BULLISH' ? fvg.level2 : fvg.level) : (ob ? ob.level : null);
        if (targetLevel) { 
            retraced = checkRetracement(candles, targetLevel); 
            sweepResult = detectLiquiditySweep(candles, targetLevel, bias);
        }
        mss = detectMSS(candles, 'BUY'); 
        candlePattern = detectCandlePattern(candles, 'BUY');
    } else if (atResistance.atLevel) {
        bias = 'SELL';
        targetLevel = fvg ? (fvg.type === 'BEARISH' ? fvg.level : fvg.level2) : (ob ? ob.level : null);
        if (targetLevel) { 
            retraced = checkRetracement(candles, targetLevel); 
            sweepResult = detectLiquiditySweep(candles, targetLevel, bias);
        }
        mss = detectMSS(candles, 'SELL'); 
        candlePattern = detectCandlePattern(candles, 'SELL');
    }
    if (!bias) return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: ['⏸️ No clear level'] };
    
    if (!sweepResult.detected) {
        return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: ['⏸️ No liquidity sweep'] };
    }
    
    const doubleSweep = detectDoubleSweep(candles);
    const trendlineBreak = detectTrendlineBreakRetest(candles).detected;
    const scaledRSI = detectScaledRSIDivergence(prices.map(c => c.close), prices.map(c => c.rsi || 50));
    const threeDrive = detectThreeDrive(candles).detected;
    const headShoulders = detectHeadAndShoulders(candles).detected;

    const scoreResult = calculateSignalScore({
        hasBOS: !!(bos && ((bias === 'BUY' && bos.type === 'BULLISH') || (bias === 'SELL' && bos.type === 'BEARISH'))),
        bosDirection: bos ? (bos.type === 'BULLISH' ? 'BUY' : 'SELL') : null,
        hasKeyLevel: true, 
        retraced, 
        sweepDetected: sweepResult.detected,
        sweepDirection: sweepResult.direction,
        levelStrength, levelQuality, 
        mss, candlePattern, 
        fvg: fvg ? { type: fvg.type === 'BULLISH' ? 'BUY' : 'SELL' } : null,
        ob: ob ? { type: ob.type === 'BULLISH' ? 'BUY' : 'SELL' } : null,
        sessionBoost,
        doubleSweep, trendlineBreak, 
        scaledRSIStrength: scaledRSI.strength, 
        threeDrive, headShoulders,
        tradeDirection: bias
    });
    
    if (!scoreResult.passed) {
        let reason = scoreResult.reason || '❌ Signal rejected';
        return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: [reason] };
    }
    
    let reasons = [];
    reasons.push(`${bias === 'BUY' ? '🟢' : '🔴'} ${bias} | ${scoreResult.grade} | ${scoreResult.expectedWinRate}% WR expected`);
    if (atSupport.atLevel) reasons.push(`📍 ${atSupport.strength} SUPPORT at ${atSupport.level.toFixed(assetConfig.digits)} (quality: ${atSupport.quality || 100})`);
    if (atResistance.atLevel) reasons.push(`📍 ${atResistance.strength} RESISTANCE at ${atResistance.level.toFixed(assetConfig.digits)} (quality: ${atResistance.quality || 100})`);
    if (bos) reasons.push(`📈 BOS at ${bos.level.toFixed(assetConfig.digits)}`);
    if (retraced) reasons.push(`✅ Retracement to FVG/OB`);
    if (sweepResult.detected) reasons.push(`💧 Liquidity sweep confirmed (${sweepResult.direction})`);
    if (mss.detected) reasons.push(`🔄 MSS confirmed`);
    if (candlePattern.detected) reasons.push(`🕯️ ${candlePattern.pattern}`);
    if (fvg) reasons.push(`📊 FVG: ${fvg.level.toFixed(assetConfig.digits)} → ${fvg.level2.toFixed(assetConfig.digits)}`);
    if (ob) reasons.push(`🔷 OB at ${ob.level.toFixed(assetConfig.digits)}`);
    if (doubleSweep) reasons.push(`🔥 Double sweep detected (+15)`);
    if (trendlineBreak) reasons.push(`📐 Trendline break + retest (+12)`);
    if (scaledRSI.strength > 0) reasons.push(`📉 Scaled RSI divergence (${scaledRSI.strength} pts)`);
    if (threeDrive) reasons.push(`🔄 Three-Drive pattern (+20)`);
    if (headShoulders) reasons.push(`👤 Head & Shoulders pattern (+25)`);
    if (scoreResult.positionMultiplier < 1.0 && scoreResult.positionMultiplier > 0) reasons.push(`⚠️ Position size: ${Math.round(scoreResult.positionMultiplier * 100)}% of calculated`);
    
    let confidence = Math.min(85, 50 + Math.floor(scoreResult.score / 2.5));
    return { bias, confidence, grade: scoreResult.grade, expectedWinRate: scoreResult.expectedWinRate, positionMultiplier: scoreResult.positionMultiplier, reasons, currentPrice: curPrice };
}

// ========== 9AM KILLZONE (unchanged) ==========
function get8amRange(candles) {
    for (let i = candles.length - 1; i >= 0; i--) {
        const date = new Date(candles[i].timestamp);
        let hourET = date.getUTCHours() - 4; if (hourET < 0) hourET += 24;
        if (hourET === 8 && date.getUTCMinutes() === 0) return { high: candles[i].high, low: candles[i].low, timestamp: candles[i].timestamp };
    }
    return null;
}
function detect9amFalseBreak(candles, eightAmRange) {
    const nineAmCandles = [];
    for (let i = candles.length - 1; i >= 0; i--) {
        const date = new Date(candles[i].timestamp);
        let hourET = date.getUTCHours() - 4; if (hourET < 0) hourET += 24;
        if (hourET === 9) nineAmCandles.unshift(candles[i]);
        else if (hourET < 9) break;
    }
    if (nineAmCandles.length < 4) return null;
    let breakHigh = false, breakLow = false, breakCandle = null;
    for (let i = 0; i < nineAmCandles.length; i++) {
        if (nineAmCandles[i].high > eightAmRange.high) { breakHigh = true; breakCandle = nineAmCandles[i]; break; }
        if (nineAmCandles[i].low < eightAmRange.low) { breakLow = true; breakCandle = nineAmCandles[i]; break; }
    }
    if (!breakHigh && !breakLow) return null;
    const breakIndex = nineAmCandles.findIndex(c => c === breakCandle);
    const afterBreak = nineAmCandles.slice(breakIndex + 1, breakIndex + 5);
    if (afterBreak.length < 3) return null;
    const buffer = eightAmRange.high * 0.0003;
    if (breakHigh) {
        const closedBelow = afterBreak.some(c => c.close < eightAmRange.high - buffer);
        let reversal = false;
        if (afterBreak.length >= 3) reversal = afterBreak[afterBreak.length-1].close < afterBreak[afterBreak.length-2].close && afterBreak[afterBreak.length-2].close < afterBreak[0].close;
        if (closedBelow && reversal) return { bias: 'SELL', level: eightAmRange.high, reason: 'False break above 8am high (confirmed)' };
    } else if (breakLow) {
        const closedAbove = afterBreak.some(c => c.close > eightAmRange.low + buffer);
        let reversal = false;
        if (afterBreak.length >= 3) reversal = afterBreak[afterBreak.length-1].close > afterBreak[afterBreak.length-2].close && afterBreak[afterBreak.length-2].close > afterBreak[0].close;
        if (closedAbove && reversal) return { bias: 'BUY', level: eightAmRange.low, reason: 'False break below 8am low (confirmed)' };
    }
    return null;
}
function analyze9amStrategy(candles, assetConfig, currentPrice) {
    const nowET = new Date();
    let hourET = nowET.getUTCHours() - 4; if (hourET < 0) hourET += 24;
    const minuteET = nowET.getUTCMinutes();
    if (hourET < 9 || (hourET === 9 && minuteET < 30) || hourET > 16) return null;
    const eightAmRange = get8amRange(candles);
    if (!eightAmRange) return null;
    const falseBreak = detect9amFalseBreak(candles, eightAmRange);
    if (!falseBreak) return null;
    const stopLoss = findLogicalStopLoss(candles, currentPrice, falseBreak.bias, assetConfig);
    const risk = Math.abs(currentPrice - stopLoss);
    const { takeProfit, rr, isExtended } = findLogicalTakeProfit(currentPrice, stopLoss, falseBreak.bias, assetConfig, candles);
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDistPoints = Math.abs(currentPrice - stopLoss) * assetConfig.multiplier + assetConfig.spread;
    let lotSize = riskAmount / (stopDistPoints * assetConfig.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, assetConfig.maxLot));
    return { bias: falseBreak.bias, grade: 'A', expectedWinRate: 70, positionMultiplier: 1.0, entry: currentPrice.toFixed(assetConfig.digits), stopLoss: stopLoss.toFixed(assetConfig.digits), takeProfit: takeProfit.toFixed(assetConfig.digits), rrRatio: rr, lotSize: lotSize.toFixed(2), isExtendedRR: isExtended, strategy: '9amKillzone', reasons: [`${falseBreak.bias === 'BUY' ? '🟢' : '🔴'} 9AM Killzone Setup`, falseBreak.reason, `8am range: H=${eightAmRange.high.toFixed(assetConfig.digits)} L=${eightAmRange.low.toFixed(assetConfig.digits)}`, `Lower timeframe reversal confirmed`, `RR ${rr}`] };
}

// ========== TELEGRAM & CANDLE MANAGEMENT ==========
async function sendTelegramAlert(symbolDisplay, signal, tradeLevels, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    if (isCooldownActive(symbolDisplay, signal.bias)) return false;
    const session = getCurrentSession();
    const timestamp = new Date().toLocaleString();
    const rrDisplay = tradeLevels.isExtendedRR ? `1:${tradeLevels.rrRatio} 🚀 EXTENDED` : `1:${tradeLevels.rrRatio}`;
    const strategyTag = signal.strategy ? ` [${signal.strategy}]` : '';
    
    let rangeInfo = '';
    if (signal.strategy === 'SessionHL' && signal.dailyHL) {
        const rangePips = (signal.dailyHL.range * assetConfig.multiplier).toFixed(1);
        const yesterdayNote = signal.usingYesterday ? ' (using yesterday\'s levels)' : '';
        rangeInfo = `\n📐 ${signal.usingYesterday ? 'Yesterday\'s' : 'Today\'s'} Range: ${rangePips} pips${yesterdayNote}\n📍 Level: ${signal.levelType} at ${signal.level.toFixed(assetConfig.digits)}`;
    }
    
    const message = `
🤖 OMNI-SIGNAL ALERT${strategyTag} 🤖
━━━━━━━━━━━━━━━━━━━
${signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | ${signal.grade} (${signal.expectedWinRate}% WR expected)
⏰ ${timestamp} (${session})

📊 ${symbolDisplay}
💰 Price: ${(signal.currentPrice || signal.entry)?.toFixed(assetConfig.digits)}${rangeInfo}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0,6).join('\n')}

━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop: ${tradeLevels.sl}
🎯 TP: ${tradeLevels.tp}
📐 RR: ${rrDisplay}
💰 Lot: ${tradeLevels.lotSize}

⚠️ Mode: SCALP | Risk: 1% | Balance: $${DEFAULT_BALANCE}
    `;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
        });
        const json = await res.json();
        if (json.ok) {
            console.log(`✅ ${symbolDisplay} ${signal.grade} | RR:${tradeLevels.rrRatio} | ${signal.expectedWinRate}% WR${strategyTag}`);
            setCooldown(symbolDisplay, signal.bias);
            return true;
        }
    } catch(e) { console.error('Telegram error:', e.message); }
    return false;
}
function loadCandleHistory(file) {
    const f = path.join(dataDir, `${file}.json`);
    if (fs.existsSync(f)) { try { const data = JSON.parse(fs.readFileSync(f)); return data.candles || []; } catch(e) {} }
    return [];
}
function saveCandleToHistory(file, candle) {
    const f = path.join(dataDir, `${file}.json`);
    let data = { candles: [] };
    if (fs.existsSync(f)) try { data = JSON.parse(fs.readFileSync(f)); } catch(e) {}
    if (!data.candles) data.candles = [];
    data.candles.push(candle);
    // Keep more candles for better analysis
    if (data.candles.length > 2000) data.candles.shift();  // Increased from 500 to 2000
    data.currentPrice = candle.close;
    data.timestamp = Date.now();
    data.high = Math.max(...data.candles.slice(-288).map(c => c.high));
    data.low = Math.min(...data.candles.slice(-288).map(c => c.low));
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
}
function loadCandleState(file) {
    const f = path.join(dataDir, `${file}_candle.json`);
    if (fs.existsSync(f)) try { return JSON.parse(fs.readFileSync(f)); } catch(e) {}
    return null;
}
function saveCandleState(file, state) { fs.writeFileSync(path.join(dataDir, `${file}_candle.json`), JSON.stringify(state, null, 2)); }
async function processAsset(file, priceFetcher, displayName, assetConfig) {
    try {
        let price = await priceFetcher();
        if (!price) throw new Error('No price');
        const now = Date.now();
        
        // Update persistent daily High/Low storage
        updateDailyHighLow(file, price, now);
        
        const fiveMinMs = 5 * 60 * 1000;
        const bucketStart = Math.floor(now / fiveMinMs) * fiveMinMs;
        let state = loadCandleState(file);
        let candles = loadCandleHistory(file);
        if (!state || state.bucketStart !== bucketStart) {
            if (state && state.candle && state.lastPrice) {
                const completed = { timestamp: state.bucketStart, open: state.candle.open, high: state.candle.high, low: state.candle.low, close: state.lastPrice };
                saveCandleToHistory(file, completed);
                candles = loadCandleHistory(file);
            }
            state = { bucketStart, candle: { open: price, high: price, low: price, close: price }, lastPrice: price, lastTimestamp: now };
        } else {
            state.candle.high = Math.max(state.candle.high, price);
            state.candle.low = Math.min(state.candle.low, price);
            state.candle.close = price;
            state.lastPrice = price;
            state.lastTimestamp = now;
        }
        saveCandleState(file, state);
        console.log(`✓ ${displayName}: price ${price}`);
        if (candles.length >= 50) {
            const prices = candles.map(c => c.close);
            const existingSignal = analyzeSignal(prices, candles, assetConfig, file);
            const killzoneSignal = analyze9amStrategy(candles, assetConfig, price);
            let finalSignal = null;
            if (existingSignal.bias !== 'WAIT' && killzoneSignal) {
                const existingWR = existingSignal.expectedWinRate || 0;
                const killzoneWR = killzoneSignal.expectedWinRate || 0;
                finalSignal = existingWR >= killzoneWR ? existingSignal : killzoneSignal;
                console.log(`🤝 Both strategies signaled. Using ${finalSignal === existingSignal ? 'existing' : '9am'} (WR ${Math.max(existingWR, killzoneWR)}%)`);
            } else if (existingSignal.bias !== 'WAIT') finalSignal = existingSignal;
            else if (killzoneSignal) finalSignal = killzoneSignal;
            if (finalSignal && finalSignal.bias !== 'WAIT' && finalSignal.grade !== 'REJECT') {
                const tradeLevels = calculateTradeLevels(finalSignal.currentPrice || price, finalSignal.bias, assetConfig, candles, finalSignal.positionMultiplier || 1.0);
                if (tradeLevels && parseFloat(tradeLevels.rrRatio) >= 1.6) await sendTelegramAlert(displayName, finalSignal, tradeLevels, assetConfig);
            }
        } else console.log(`⏳ ${displayName}: building candles (${candles.length}/50)`);
    } catch (err) { console.error(`✗ ${displayName}: ${err.message}`); }
}
async function main() {
    console.log('--- OMNI-SIGNAL v10.1 (Persistent Session High/Low Strategy) ---');
    console.log(`Session H/L active: ${SESSION_CONFIG.tradingHours.start}:00-${SESSION_CONFIG.tradingHours.end}:00 UTC`);
    console.log(`Daily H/L data persisted to: ${DAILY_HL_FILE}`);
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Rules: Session H/L (priority during overlap) + sweep confirmation + persistent storage`);
    let eurusd, gbpusd, usdjpy, usdcad, usdchf, usdsek;
    try {
        eurusd = await fetchForexPrice('EUR', 'USD');
        gbpusd = await fetchForexPrice('GBP', 'USD');
        usdjpy = await fetchForexPrice('USD', 'JPY');
        usdcad = await fetchForexPrice('USD', 'CAD');
        usdchf = await fetchForexPrice('USD', 'CHF');
        usdsek = await fetchForexPrice('USD', 'SEK');
    } catch(e) { console.error('Forex error:', e.message); }
    if (eurusd && gbpusd && usdjpy && usdcad && usdchf && usdsek) {
        const dxyPrice = calculateDXY(eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf);
        console.log(`✓ DXY: ${dxyPrice.toFixed(4)}`);
        const dxyData = { currentPrice: dxyPrice, timestamp: Date.now(), candles: [] };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(dxyData, null, 2));
    }
    const assets = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD', config: ASSET_CONFIGS.eurusd },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD', config: ASSET_CONFIGS.gbpusd },
        { file: 'usdjpy', fetcher: () => fetchForexPrice('USD', 'JPY'), display: 'USD/JPY', config: ASSET_CONFIGS.usdjpy },
        { file: 'usdcad', fetcher: () => fetchForexPrice('USD', 'CAD'), display: 'USD/CAD', config: ASSET_CONFIGS.usdcad },
        { file: 'usdchf', fetcher: () => fetchForexPrice('USD', 'CHF'), display: 'USD/CHF', config: ASSET_CONFIGS.usdchf },
        { file: 'usdsek', fetcher: () => fetchForexPrice('USD', 'SEK'), display: 'USD/SEK', config: ASSET_CONFIGS.usdsek },
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD', config: ASSET_CONFIGS.btcusd },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD', config: ASSET_CONFIGS.ethusd },
        { file: 'solusd', fetcher: () => fetchCryptoPrice('solana'), display: 'SOL/USD', config: ASSET_CONFIGS.solusd },
        { file: 'xauusd', fetcher: fetchGoldPrice, display: 'XAUUSD (Gold)', config: ASSET_CONFIGS.xauusd },
        { file: 'xagusd', fetcher: fetchSilverPrice, display: 'XAGUSD (Silver)', config: ASSET_CONFIGS.xagusd },
        { file: 'wtiusd', fetcher: fetchOilPrice, display: 'WTI Oil', config: ASSET_CONFIGS.wtiusd }
    ];
    for (let i = 0; i < assets.length; i++) {
        await processAsset(assets[i].file, assets[i].fetcher, assets[i].display, assets[i].config);
        if (i < assets.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    console.log('--- Completed ---');
}
main().catch(err => console.error('Fatal error:', err));
