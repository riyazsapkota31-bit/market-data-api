// fetch-prices.js – SCALPING OPTIMIZED v6
// MINOR levels filtered by quality (touches count) | MAJOR levels always trade

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
const SIGNAL_TRACKING_FILE = path.join(dataDir, 'signal_tracking.json');
let oilRunCounter = 0;

// ========== ASSET CONFIGURATIONS ==========
const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0 },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex', minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.6, maxLot: 5.0 },
    usdjpy: { multiplier: 100, spread: 0.03, digits: 3, class: 'forex', minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.6, maxLot: 5.0 },
    usdcad: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0 },
    usdchf: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.6, maxLot: 5.0 },
    usdsek: { multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex', minStopPips: 20, maxStopPips: 40, atrMultiplier: 0.6, maxLot: 5.0 },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto', minStopPips: 800, maxStopPips: 2000, atrMultiplier: 0.8, maxLot: 0.5 },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto', minStopPips: 50, maxStopPips: 120, atrMultiplier: 0.8, maxLot: 5.0 },
    solusd: { multiplier: 10, spread: 0.50, digits: 2, class: 'crypto', minStopPips: 5, maxStopPips: 15, atrMultiplier: 0.8, maxLot: 50.0 },
    xauusd: { multiplier: 100, spread: 0.35, digits: 2, class: 'commodities', minStopPips: 15.0, maxStopPips: 35.0, atrMultiplier: 0.8, maxLot: 0.5 },
    xagusd: { multiplier: 100, spread: 0.04, digits: 3, class: 'commodities', minStopPips: 0.50, maxStopPips: 1.20, atrMultiplier: 0.8, maxLot: 0.5 },
    wtiusd: { multiplier: 100, spread: 0.05, digits: 2, class: 'commodities', minStopPips: 0.60, maxStopPips: 1.50, atrMultiplier: 0.6, maxLot: 1.0 },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex', minStopPips: 15, maxStopPips: 40, atrMultiplier: 0.6, maxLot: 5.0 }
};

// ========== UTILITY FUNCTIONS ==========
function loadSignalTracking() {
    if (fs.existsSync(SIGNAL_TRACKING_FILE)) {
        try { return JSON.parse(fs.readFileSync(SIGNAL_TRACKING_FILE)); } catch(e) {}
    }
    return { signals: {} };
}

function saveSignalTracking(tracking) {
    const now = Date.now();
    const cleanedSignals = {};
    for (const [key, timestamp] of Object.entries(tracking.signals)) {
        if (now - timestamp < 4 * 60 * 60 * 1000) {
            cleanedSignals[key] = timestamp;
        }
    }
    tracking.signals = cleanedSignals;
    fs.writeFileSync(SIGNAL_TRACKING_FILE, JSON.stringify(tracking, null, 2));
}

function isDuplicateSignal(symbol, bias, currentPrice) {
    const tracking = loadSignalTracking();
    const now = Date.now();
    const priceRounded = Math.round(currentPrice / (currentPrice > 100 ? 100 : 10)) * (currentPrice > 100 ? 100 : 10);
    const hourKey = Math.floor(now / (60 * 60 * 1000));
    const key = `${symbol}_${bias}_${priceRounded}_${hourKey}`;
    
    if (tracking.signals[key]) {
        const timeSince = now - tracking.signals[key];
        if (timeSince < 60 * 60 * 1000) {
            console.log(`⏸️ Duplicate blocked: ${symbol} ${bias}`);
            return true;
        }
    }
    tracking.signals[key] = now;
    saveSignalTracking(tracking);
    return false;
}

function loadCooldown() {
    if (fs.existsSync(COOLDOWN_FILE)) {
        try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE)); } catch(e) {}
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
    return (Date.now() - lastAlert) < 15 * 60 * 1000;
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

let lastOilPrice = null;
let lastOilFetchTime = 0;

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

// ========== KEY LEVEL DETECTION WITH QUALITY SCORING ==========
function getKeyLevels(candles, currentPrice) {
    const levels = [];
    
    // ========== MAJOR LEVELS (Always include, quality 100) ==========
    const dayCandles = candles.slice(-288);
    if (dayCandles.length > 0) {
        levels.push({ 
            price: Math.max(...dayCandles.map(c => c.high)), 
            type: 'RESISTANCE', 
            strength: 'MAJOR',
            touches: 0,
            quality: 100
        });
        levels.push({ 
            price: Math.min(...dayCandles.map(c => c.low)), 
            type: 'SUPPORT', 
            strength: 'MAJOR',
            touches: 0,
            quality: 100
        });
    }
    
    // WEEKLY LEVELS
    if (candles.length >= 1440) {
        const weekCandles = candles.slice(-1440);
        levels.push({ 
            price: Math.max(...weekCandles.map(c => c.high)), 
            type: 'RESISTANCE', 
            strength: 'MAJOR',
            touches: 0,
            quality: 100
        });
        levels.push({ 
            price: Math.min(...weekCandles.map(c => c.low)), 
            type: 'SUPPORT', 
            strength: 'MAJOR',
            touches: 0,
            quality: 100
        });
    }
    
    // ========== MINOR LEVELS WITH QUALITY SCORE (based on touches) ==========
    const levelMap = new Map();
    
    for (let i = 20; i < candles.length - 5; i++) {
        const isSwingHigh = candles[i].high > candles[i-2].high && candles[i].high > candles[i-1].high &&
                            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        const isSwingLow = candles[i].low < candles[i-2].low && candles[i].low < candles[i-1].low &&
                           candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
        
        if (isSwingHigh) {
            const price = candles[i].high;
            const rounded = Math.round(price * 100) / 100;
            
            // Count touches at this level (how many times price respected it)
            let touches = 0;
            for (let j = Math.max(0, i - 30); j <= Math.min(candles.length - 1, i + 10); j++) {
                if (Math.abs(candles[j].high - price) / price < 0.0003) {
                    touches++;
                }
            }
            
            // Quality score: more touches = higher quality
            // 1 touch = 40 (REJECT), 2 touches = 60, 3+ touches = 80+
            let quality = Math.min(90, 30 + (touches * 20));
            
            if (!levelMap.has(rounded) && quality >= 60) {  // Only store quality 60+
                levelMap.set(rounded, { price, touches, quality, type: 'RESISTANCE' });
            }
        }
        
        if (isSwingLow) {
            const price = candles[i].low;
            const rounded = Math.round(price * 100) / 100;
            
            let touches = 0;
            for (let j = Math.max(0, i - 30); j <= Math.min(candles.length - 1, i + 10); j++) {
                if (Math.abs(candles[j].low - price) / price < 0.0003) {
                    touches++;
                }
            }
            
            let quality = Math.min(90, 30 + (touches * 20));
            
            if (!levelMap.has(rounded) && quality >= 60) {
                levelMap.set(rounded, { price, touches, quality, type: 'SUPPORT' });
            }
        }
    }
    
    // Add qualified MINOR levels
    for (const [_, level] of levelMap) {
        levels.push({
            price: level.price,
            type: level.type,
            strength: 'MINOR',
            touches: level.touches,
            quality: level.quality
        });
    }
    
    // ========== ROUND NUMBERS (Only if tested 2+ times) ==========
    const roundNumber = Math.round(currentPrice / 10) * 10;
    let roundTouches = 0;
    for (let i = Math.max(0, candles.length - 100); i < candles.length; i++) {
        if (Math.abs(candles[i].high - roundNumber) / roundNumber < 0.0003) roundTouches++;
        if (Math.abs(candles[i].low - roundNumber) / roundNumber < 0.0003) roundTouches++;
    }
    
    if (roundTouches >= 2) {
        levels.push({
            price: roundNumber,
            type: 'ROUND_NUMBER',
            strength: 'ROUND',
            touches: roundTouches,
            quality: Math.min(80, 50 + roundTouches * 10)
        });
    }
    
    // Remove duplicates and sort by distance
    const unique = [];
    for (const level of levels) {
        let duplicate = false;
        for (const existing of unique) {
            if (Math.abs(existing.price - level.price) / level.price < 0.0005) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) unique.push(level);
    }
    
    // Sort by distance to current price
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

// ========== PATTERN DETECTION ==========
function detectBOS(candles) {
    if (candles.length < 30) return null;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const recentHigh = Math.max(...highs.slice(-10));
    const previousHigh = Math.max(...highs.slice(-20, -10));
    const recentLow = Math.min(...lows.slice(-10));
    const previousLow = Math.min(...lows.slice(-20, -10));
    
    if (recentHigh > previousHigh) return { type: 'BULLISH', level: previousHigh };
    if (recentLow < previousLow) return { type: 'BEARISH', level: previousLow };
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
    if (prev.close < prev.open && last.close > last.open && last.close > prev.high) {
        return { type: 'BULLISH', level: prev.low };
    }
    if (prev.close > prev.open && last.close < last.open && last.close < prev.low) {
        return { type: 'BEARISH', level: prev.high };
    }
    return null;
}

function detectLiquiditySweep(candles, level) {
    if (candles.length < 5) return false;
    const last = candles[candles.length - 1];
    if (last.low < level && last.close > level && last.close > last.open) return true;
    if (last.high > level && last.close < level && last.close < last.open) return true;
    return false;
}

function checkRetracement(candles, level, bias) {
    if (candles.length < 15) return false;
    const recentCandles = candles.slice(-15);
    
    let sweepIndex = -1;
    for (let i = recentCandles.length - 1; i >= 0; i--) {
        if (bias === 'BUY' && recentCandles[i].low <= level) {
            sweepIndex = i;
            break;
        }
        if (bias === 'SELL' && recentCandles[i].high >= level) {
            sweepIndex = i;
            break;
        }
    }
    
    if (sweepIndex === -1 || sweepIndex >= recentCandles.length - 4) return false;
    const afterSweep = recentCandles.slice(sweepIndex + 1);
    if (afterSweep.length < 3) return false;
    
    if (bias === 'BUY') {
        let bullishCount = 0;
        for (let i = 0; i < afterSweep.length; i++) {
            if (afterSweep[i].close > afterSweep[i].open) bullishCount++;
            else break;
        }
        const closedAbove = afterSweep[afterSweep.length-1].close > level;
        const priceMovedUp = (afterSweep[afterSweep.length-1].close - level) / level > 0.0015;
        const lowestAfter = Math.min(...afterSweep.map(c => c.low));
        const noNewLow = lowestAfter > level - (level * 0.0005);
        return bullishCount >= 2 && closedAbove && priceMovedUp && noNewLow;
    } else {
        let bearishCount = 0;
        for (let i = 0; i < afterSweep.length; i++) {
            if (afterSweep[i].close < afterSweep[i].open) bearishCount++;
            else break;
        }
        const closedBelow = afterSweep[afterSweep.length-1].close < level;
        const priceMovedDown = (level - afterSweep[afterSweep.length-1].close) / level > 0.0015;
        const highestAfter = Math.max(...afterSweep.map(c => c.high));
        const noNewHigh = highestAfter < level + (level * 0.0005);
        return bearishCount >= 2 && closedBelow && priceMovedDown && noNewHigh;
    }
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

// ========== SCORING SYSTEM WITH QUALITY FILTER ==========
function calculateSignalScore(factors) {
    let score = 0;
    let positionMultiplier = 1.0;
    let expectedWinRate = 50;
    
    const hasBOS = factors.bos;
    const hasKeyLevel = factors.atLevel;
    const hasRetrace = factors.retraced;
    const hasSweep = factors.sweep;
    const levelQuality = factors.levelQuality || 0;
    const levelStrength = factors.levelStrength || 'MINOR';
    
    // CORE REQUIREMENTS
    if (!hasBOS || !hasKeyLevel || !hasRetrace || !hasSweep) {
        return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
    }
    
    // Base score for meeting core requirements
    score = 60;
    
    // ========== LEVEL QUALITY ADJUSTMENT ==========
    if (levelStrength === 'MAJOR') {
        score += 25;
        positionMultiplier = 1.0;
        expectedWinRate = 78;
    } else if (levelStrength === 'MINOR') {
        // MINOR levels NEED quality score to pass
        if (levelQuality >= 85) {
            score += 15;
            positionMultiplier = 0.95;
            expectedWinRate = 75;
        } else if (levelQuality >= 75) {
            score += 10;
            positionMultiplier = 0.85;
            expectedWinRate = 70;
        } else if (levelQuality >= 65) {
            score += 5;
            positionMultiplier = 0.75;
            expectedWinRate = 65;
        } else if (levelQuality >= 60) {
            score += 0;
            positionMultiplier = 0.6;
            expectedWinRate = 60;
        } else {
            // Quality below 60 = REJECT
            return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
        }
    } else if (levelStrength === 'ROUND') {
        if (levelQuality >= 70) {
            score += 8;
            positionMultiplier = 0.8;
            expectedWinRate = 68;
        } else {
            return { passed: false, grade: 'REJECT', positionMultiplier: 0, expectedWinRate: 35 };
        }
    }
    
    // MSS BONUS
    if (factors.mss && factors.mss.detected) {
        if (factors.mss.strength >= 80) {
            score += 12;
            expectedWinRate = Math.min(85, expectedWinRate + 6);
        } else {
            score += 6;
            expectedWinRate = Math.min(85, expectedWinRate + 3);
        }
    }
    
    // CANDLE PATTERN
    if (factors.candlePattern && factors.candlePattern.detected) {
        score += 10;
        expectedWinRate = Math.min(85, expectedWinRate + 5);
    }
    
    // FVG
    if (factors.fvg) {
        score += 8;
        expectedWinRate = Math.min(85, expectedWinRate + 3);
    }
    
    // ORDER BLOCK
    if (factors.ob) {
        score += 5;
        expectedWinRate = Math.min(85, expectedWinRate + 2);
    }
    
    // SESSION BOOST (only for MAJOR levels or high quality MINOR)
    if (factors.sessionBoost && (levelStrength === 'MAJOR' || levelQuality >= 75)) {
        score += 5;
        expectedWinRate = Math.min(85, expectedWinRate + 2);
    }
    
    score = Math.min(100, score);
    expectedWinRate = Math.min(85, expectedWinRate);
    
    let grade = 'B';
    let passed = true;
    
    if (expectedWinRate >= 75) {
        grade = 'A+';
        positionMultiplier = Math.min(positionMultiplier, 1.0);
    } else if (expectedWinRate >= 70) {
        grade = 'A';
        positionMultiplier = Math.min(positionMultiplier, 0.95);
    } else if (expectedWinRate >= 65) {
        grade = 'B+';
        positionMultiplier = Math.min(positionMultiplier, 0.85);
    } else if (expectedWinRate >= 60) {
        grade = 'B';
        positionMultiplier = Math.min(positionMultiplier, 0.7);
        passed = true;
    } else {
        passed = false;
    }
    
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
            const tr = Math.max(
                recentCandles[i].high - recentCandles[i].low,
                Math.abs(recentCandles[i].high - recentCandles[i-1].close),
                Math.abs(recentCandles[i].low - recentCandles[i-1].close)
            );
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
                recentCandles[i].low < recentCandles[i+2].low && recentCandles[i].low < recentCandles[i+3].low) {
                swingPoints.push({ price: recentCandles[i].low, type: 'LOW' });
            }
            if (recentCandles[i].high > recentCandles[i-1].high && recentCandles[i].high > recentCandles[i-2].high &&
                recentCandles[i].high > recentCandles[i-3].high && recentCandles[i].high > recentCandles[i+1].high &&
                recentCandles[i].high > recentCandles[i+2].high && recentCandles[i].high > recentCandles[i+3].high) {
                swingPoints.push({ price: recentCandles[i].high, type: 'HIGH' });
            }
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
    if (swingStop) {
        stopDistance = Math.abs(currentPrice - swingStop);
        finalStop = swingStop;
    } else {
        stopDistance = Math.max(atrStop, minStopPips);
        finalStop = bias === 'BUY' ? currentPrice - stopDistance : currentPrice + stopDistance;
    }
    
    if (stopDistance > maxStopPips) {
        stopDistance = maxStopPips;
        finalStop = bias === 'BUY' ? currentPrice - maxStopPips : currentPrice + maxStopPips;
    }
    
    const minSafeDistance = spread * 3;
    if (stopDistance < minSafeDistance) {
        finalStop = bias === 'BUY' ? currentPrice - minSafeDistance : currentPrice + minSafeDistance;
    }
    
    return finalStop;
}

function findLogicalTakeProfit(entry, stopLoss, bias, assetConfig, candles) {
    const risk = Math.abs(entry - stopLoss);
    const minRR = 2.0;
    const maxRR = 5.0;
    
    let logicalTP = null;
    let actualRR = minRR;
    
    if (candles && candles.length >= 50) {
        const recentCandles = candles.slice(-50);
        const resistanceLevels = [];
        const supportLevels = [];
        
        for (let i = 5; i < recentCandles.length - 5; i++) {
            if (recentCandles[i].high > recentCandles[i-1].high && 
                recentCandles[i].high > recentCandles[i+1].high &&
                recentCandles[i].high > recentCandles[i-2].high &&
                recentCandles[i].high > recentCandles[i+2].high) {
                resistanceLevels.push(recentCandles[i].high);
            }
            if (recentCandles[i].low < recentCandles[i-1].low && 
                recentCandles[i].low < recentCandles[i+1].low &&
                recentCandles[i].low < recentCandles[i-2].low &&
                recentCandles[i].low < recentCandles[i+2].low) {
                supportLevels.push(recentCandles[i].low);
            }
        }
        
        const buffer = entry * 0.0005;
        
        if (bias === 'BUY') {
            const validResistances = resistanceLevels.filter(r => r > entry);
            validResistances.sort((a, b) => a - b);
            if (validResistances.length > 0) {
                const nextResistance = validResistances[0] - buffer;
                const potentialRR = (nextResistance - entry) / risk;
                if (potentialRR >= minRR) {
                    logicalTP = nextResistance;
                    actualRR = Math.min(potentialRR, maxRR);
                }
            }
        } else {
            const validSupports = supportLevels.filter(s => s < entry);
            validSupports.sort((a, b) => b - a);
            if (validSupports.length > 0) {
                const nextSupport = validSupports[0] + buffer;
                const potentialRR = (entry - nextSupport) / risk;
                if (potentialRR >= minRR) {
                    logicalTP = nextSupport;
                    actualRR = Math.min(potentialRR, maxRR);
                }
            }
        }
    }
    
    let takeProfit;
    let isExtended = false;
    
    if (logicalTP && actualRR > minRR) {
        takeProfit = logicalTP;
        isExtended = true;
    } else if (logicalTP && actualRR === minRR) {
        takeProfit = logicalTP;
        isExtended = false;
    } else {
        takeProfit = bias === 'BUY' ? entry + (risk * minRR) : entry - (risk * minRR);
        actualRR = minRR;
        isExtended = false;
    }
    
    if (actualRR < minRR) {
        actualRR = minRR;
        takeProfit = bias === 'BUY' ? entry + (risk * minRR) : entry - (risk * minRR);
        isExtended = false;
    }
    
    return { takeProfit, rr: actualRR.toFixed(1), isExtended };
}

function calculateTradeLevels(price, bias, assetConfig, candles, positionMultiplier) {
    const stopLoss = findLogicalStopLoss(candles, price, bias, assetConfig);
    const entry = price;
    const { takeProfit, rr, isExtended } = findLogicalTakeProfit(entry, stopLoss, bias, assetConfig, candles);
    
    if (parseFloat(rr) < 2.0) return null;
    
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDistPoints = Math.abs(entry - stopLoss) + assetConfig.spread;
    let lotSize = riskAmount / (stopDistPoints * assetConfig.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, assetConfig.maxLot));
    lotSize = lotSize * positionMultiplier;
    lotSize = Math.floor(lotSize * 1000) / 1000;
    
    return {
        entry: entry.toFixed(assetConfig.digits),
        sl: stopLoss.toFixed(assetConfig.digits),
        tp: takeProfit.toFixed(assetConfig.digits),
        rrRatio: rr,
        lotSize: lotSize.toFixed(2),
        isExtendedRR: isExtended
    };
}

// ========== SIGNAL ANALYSIS WITH QUALITY FILTER ==========
function analyzeSignal(prices, candles, assetConfig) {
    if (candles.length < 50) {
        return { bias: 'WAIT', confidence: 30, currentPrice: prices[prices.length-1] };
    }
    
    const curPrice = prices[prices.length-1];
    const keyLevels = getKeyLevels(candles, curPrice);
    const atSupport = isAtSupport(curPrice, keyLevels);
    const atResistance = isAtResistance(curPrice, keyLevels);
    
    // ========== SESSION FILTER: Only London/NY (8 AM - 4 PM UTC) ==========
    const currentHour = new Date().getUTCHours();
    const isLondonOrNY = (currentHour >= 7 && currentHour < 16) || (currentHour >= 12 && currentHour < 20);
    if (!isLondonOrNY) {
        return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: ['⏸️ OFF_HOURS - London/NY only'] };
    }
    
    // Get level strength and quality
    let levelStrength = null;
    let levelQuality = 0;
    let levelPrice = null;
    let levelType = null;
    
    if (atSupport.atLevel) {
        levelStrength = atSupport.strength;
        levelQuality = atSupport.quality || 100;
        levelPrice = atSupport.level;
        levelType = 'SUPPORT';
    } else if (atResistance.atLevel) {
        levelStrength = atResistance.strength;
        levelQuality = atResistance.quality || 100;
        levelPrice = atResistance.level;
        levelType = 'RESISTANCE';
    }
    
    // ========== MINOR LEVEL QUALITY FILTER ==========
    if (levelStrength === 'MINOR' && levelQuality < 60) {
        return { 
            bias: 'WAIT', 
            grade: 'REJECT', 
            currentPrice: curPrice, 
            reasons: [`⏸️ MINOR level at ${levelPrice.toFixed(assetConfig.digits)} has quality ${levelQuality} (need 60+)`] 
        };
    }
    
    const bos = detectBOS(candles);
    const fvg = detectFVG(candles);
    const ob = detectOrderBlock(candles);
    const sessionBoost = getSessionMultiplier() >= 1.0;
    
    let bias = null;
    let targetLevel = null;
    let retraced = false;
    let sweep = false;
    let mss = { detected: false };
    let candlePattern = { detected: false };
    
    if (atSupport.atLevel) {
        bias = 'BUY';
        targetLevel = fvg ? (fvg.type === 'BULLISH' ? fvg.level2 : fvg.level) : (ob ? ob.level : null);
        if (targetLevel) {
            retraced = checkRetracement(candles, targetLevel, 'BUY');
            sweep = detectLiquiditySweep(candles, targetLevel);
        }
        mss = detectMSS(candles, 'BUY');
        candlePattern = detectCandlePattern(candles, 'BUY');
    } else if (atResistance.atLevel) {
        bias = 'SELL';
        targetLevel = fvg ? (fvg.type === 'BEARISH' ? fvg.level : fvg.level2) : (ob ? ob.level : null);
        if (targetLevel) {
            retraced = checkRetracement(candles, targetLevel, 'SELL');
            sweep = detectLiquiditySweep(candles, targetLevel);
        }
        mss = detectMSS(candles, 'SELL');
        candlePattern = detectCandlePattern(candles, 'SELL');
    }
    
    // REQUIRE both retracement AND sweep
    if (!retraced || !sweep) {
        return { bias: 'WAIT', grade: 'REJECT', currentPrice: curPrice, reasons: ['⏸️ Need BOTH retracement AND sweep'] };
    }
    
    const scoreResult = calculateSignalScore({
        bos: !!(bos && ((bias === 'BUY' && bos.type === 'BULLISH') || (bias === 'SELL' && bos.type === 'BEARISH'))),
        atLevel: !!(atSupport.atLevel || atResistance.atLevel),
        retraced: retraced,
        sweep: sweep,
        levelStrength: levelStrength,
        levelQuality: levelQuality,
        mss: mss,
        candlePattern: candlePattern,
        fvg: !!fvg,
        ob: !!ob,
        sessionBoost: sessionBoost
    });
    
    let reasons = [];
    if (scoreResult.passed) {
        reasons.push(`${bias === 'BUY' ? '🟢' : '🔴'} ${bias} | ${scoreResult.grade} | ${scoreResult.expectedWinRate}% WR expected`);
        
        if (atSupport.atLevel) {
            reasons.push(`📍 ${atSupport.strength} SUPPORT at ${atSupport.level.toFixed(assetConfig.digits)} (quality: ${atSupport.quality || 100})`);
        }
        if (atResistance.atLevel) {
            reasons.push(`📍 ${atResistance.strength} RESISTANCE at ${atResistance.level.toFixed(assetConfig.digits)} (quality: ${atResistance.quality || 100})`);
        }
        if (bos) reasons.push(`📈 BOS at ${bos.level.toFixed(assetConfig.digits)}`);
        if (retraced) reasons.push(`✅ Retracement confirmed`);
        if (sweep) reasons.push(`💧 Liquidity sweep confirmed`);
        if (mss.detected) reasons.push(`🔄 MSS confirmed (${mss.strength})`);
        if (candlePattern.detected) reasons.push(`🕯️ ${candlePattern.pattern}`);
        if (fvg) reasons.push(`📊 FVG: ${fvg.level.toFixed(assetConfig.digits)} → ${fvg.level2.toFixed(assetConfig.digits)}`);
        if (ob) reasons.push(`🔷 OB at ${ob.level.toFixed(assetConfig.digits)}`);
        
        if (scoreResult.positionMultiplier < 1.0 && scoreResult.positionMultiplier > 0) {
            reasons.push(`⚠️ Position size: ${Math.round(scoreResult.positionMultiplier * 100)}% of calculated`);
        }
        
        let confidence = Math.min(85, 50 + Math.floor(scoreResult.score / 2.5));
        
        return {
            bias: bias,
            confidence: confidence,
            grade: scoreResult.grade,
            expectedWinRate: scoreResult.expectedWinRate,
            positionMultiplier: scoreResult.positionMultiplier,
            reasons: reasons,
            currentPrice: curPrice
        };
    }
    
    return {
        bias: 'WAIT',
        confidence: 40,
        grade: 'REJECT',
        reasons: [`❌ ${scoreResult.breakdown?.join(', ') || 'Signal rejected'}`],
        currentPrice: curPrice
    };
}

async function sendTelegramAlert(symbolDisplay, signal, tradeLevels, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    if (isCooldownActive(symbolDisplay, signal.bias)) return false;
    if (isDuplicateSignal(symbolDisplay, signal.bias, signal.currentPrice)) return false;
    
    const session = getCurrentSession();
    const timestamp = new Date().toLocaleString();
    
    const rrDisplay = tradeLevels.isExtendedRR ? `1:${tradeLevels.rrRatio} 🚀 EXTENDED` : `1:${tradeLevels.rrRatio}`;
    
    const message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | ${signal.grade} (${signal.expectedWinRate}% WR expected)
⏰ ${timestamp} (${session})

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0, 6).join('\n')}

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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
        });
        const json = await res.json();
        if (json.ok) {
            console.log(`✅ ${symbolDisplay} ${signal.grade} | RR:${tradeLevels.rrRatio} | ${signal.expectedWinRate}% WR`);
            setCooldown(symbolDisplay, signal.bias);
            return true;
        }
    } catch(e) { console.error('Telegram error:', e.message); }
    return false;
}

// ========== CANDLE MANAGEMENT ==========
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
    data.high = Math.max(...data.candles.slice(-288).map(c => c.high));
    data.low = Math.min(...data.candles.slice(-288).map(c => c.low));
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

async function processAsset(file, priceFetcher, displayName, assetConfig) {
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
                
                if (candles.length >= 50) {
                    const prices = candles.map(c => c.close);
                    const signal = analyzeSignal(prices, candles, assetConfig);
                    console.log(`📊 ${displayName} - ${signal.bias} | ${signal.grade} | ${signal.expectedWinRate || 0}% WR`);
                    
                    if (signal.bias !== 'WAIT' && signal.grade !== 'REJECT') {
                        const tradeLevels = calculateTradeLevels(signal.currentPrice, signal.bias, assetConfig, candles, signal.positionMultiplier || 1.0);
                        if (tradeLevels && parseFloat(tradeLevels.rrRatio) >= 2.0) {
                            await sendTelegramAlert(displayName, signal, tradeLevels, assetConfig);
                        }
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
        }
        saveCandleState(file, state);
        console.log(`✓ ${displayName}: ${price}`);
    } catch (err) {
        console.error(`✗ ${displayName}: ${err.message}`);
    }
}

async function main() {
    console.log('--- OMNI-SIGNAL v6 (Quality-Filtered MINOR Levels) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Rules: MAJOR levels always | MINOR levels need quality 60+ | London/NY only`);

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
