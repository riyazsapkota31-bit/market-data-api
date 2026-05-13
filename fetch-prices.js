// fetch-prices.js – SCALPING OPTIMIZED with SCORING SYSTEM (60+ points = B grade minimum)
// Features: No C trades | Score breakdown | Dynamic lot sizing | 1:2+ RR

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

// ========== ASSET-SPECIFIC REASONABLE LEVELS (1:2 MIN RR) ==========
const ASSET_CONFIGS = {
    // FOREX (1:2 RR, 15-30 pip stops)
    eurusd: { 
        multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex',
        minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    gbpusd: { 
        multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex',
        minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    usdjpy: { 
        multiplier: 100, spread: 0.03, digits: 3, class: 'forex',
        minStopPips: 18, maxStopPips: 35, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    usdcad: { 
        multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex',
        minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    usdchf: { 
        multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex',
        minStopPips: 15, maxStopPips: 30, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    usdsek: { 
        multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex',
        minStopPips: 20, maxStopPips: 40, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    },
    
    // CRYPTO (1:2.5 RR, wider stops for volatility)
    btcusd: { 
        multiplier: 10, spread: 75.00, digits: 0, class: 'crypto',
        minStopPips: 800, maxStopPips: 2000, atrMultiplier: 0.6, tpMultiplier: 2.5, maxLot: 0.5
    },
    ethusd: { 
        multiplier: 10, spread: 6.00, digits: 0, class: 'crypto',
        minStopPips: 50, maxStopPips: 120, atrMultiplier: 0.6, tpMultiplier: 2.5, maxLot: 5.0
    },
    solusd: { 
        multiplier: 10, spread: 0.50, digits: 2, class: 'crypto',
        minStopPips: 5, maxStopPips: 15, atrMultiplier: 0.6, tpMultiplier: 2.5, maxLot: 50.0
    },
    
    // METALS (1:2 RR, Gold needs wider stop!)
    xauusd: { 
        multiplier: 100, spread: 0.35, digits: 2, class: 'commodities',
        minStopPips: 12.0, maxStopPips: 25.0, atrMultiplier: 0.6, tpMultiplier: 2.0, maxLot: 0.5
    },
    xagusd: { 
        multiplier: 100, spread: 0.04, digits: 3, class: 'commodities',
        minStopPips: 0.40, maxStopPips: 1.00, atrMultiplier: 0.6, tpMultiplier: 2.0, maxLot: 0.5
    },
    
    // OIL (1:2 RR)
    wtiusd: { 
        multiplier: 100, spread: 0.05, digits: 2, class: 'commodities',
        minStopPips: 0.60, maxStopPips: 1.50, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 1.0
    },
    dxy: { 
        multiplier: 100, spread: 0.05, digits: 4, class: 'forex',
        minStopPips: 15, maxStopPips: 40, atrMultiplier: 0.5, tpMultiplier: 2.0, maxLot: 5.0
    }
};

// ========== DUPLICATE SIGNAL PREVENTION ==========
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
            console.log(`⏸️ Duplicate blocked: ${symbol} ${bias} (${Math.round(timeSince/60000)} mins ago)`);
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

function getKeyLevels(candles, currentPrice) {
    const levels = [];
    
    const dayCandles = candles.slice(-288);
    if (dayCandles.length > 0) {
        levels.push({ price: Math.max(...dayCandles.map(c => c.high)), type: 'MAJOR_RESISTANCE', strength: 'MAJOR' });
        levels.push({ price: Math.min(...dayCandles.map(c => c.low)), type: 'MAJOR_SUPPORT', strength: 'MAJOR' });
    }
    
    for (let i = 10; i < candles.length - 10; i++) {
        if (candles[i].high > candles[i-5].high && candles[i].high > candles[i+5].high) {
            levels.push({ price: candles[i].high, type: 'MINOR_RESISTANCE', strength: 'MINOR' });
        }
        if (candles[i].low < candles[i-5].low && candles[i].low < candles[i+5].low) {
            levels.push({ price: candles[i].low, type: 'MINOR_SUPPORT', strength: 'MINOR' });
        }
    }
    
    const roundNumber = Math.round(currentPrice / (currentPrice > 100 ? 100 : 10)) * (currentPrice > 100 ? 100 : 10);
    levels.push({ price: roundNumber, type: 'ROUND_NUMBER', strength: 'MINOR' });
    
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

function isAtSupport(price, levels) {
    for (const level of levels) {
        if (level.type.includes('SUPPORT') && Math.abs(price - level.price) / price < 0.001) {
            return { atLevel: true, level: level.price, type: level.strength };
        }
    }
    return { atLevel: false };
}

function isAtResistance(price, levels) {
    for (const level of levels) {
        if (level.type.includes('RESISTANCE') && Math.abs(price - level.price) / price < 0.001) {
            return { atLevel: true, level: level.price, type: level.strength };
        }
    }
    return { atLevel: false };
}

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
    if (candles.length < 6) return false;
    
    let touchCandleIndex = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
        if (bias === 'BUY' && candles[i].low <= level) {
            touchCandleIndex = i;
            break;
        }
        if (bias === 'SELL' && candles[i].high >= level) {
            touchCandleIndex = i;
            break;
        }
    }
    
    if (touchCandleIndex === -1 || touchCandleIndex === candles.length - 1) return false;
    
    const candlesAfter = candles.slice(touchCandleIndex + 1);
    if (candlesAfter.length < 2) return false;
    
    if (bias === 'BUY') {
        const firstCandleBullish = candlesAfter[0].close > candlesAfter[0].open;
        const secondCandleHigher = candlesAfter[1].close > candlesAfter[0].close;
        const priceMovedUp = (candlesAfter[1].close - level) / level > 0.0005;
        return firstCandleBullish && secondCandleHigher && priceMovedUp;
    } else {
        const firstCandleBearish = candlesAfter[0].close < candlesAfter[0].open;
        const secondCandleLower = candlesAfter[1].close < candlesAfter[0].close;
        const priceMovedDown = (level - candlesAfter[1].close) / level > 0.0005;
        return firstCandleBearish && secondCandleLower && priceMovedDown;
    }
}

function detectMSS(candles, bias) {
    if (candles.length < 15) return { detected: false, strength: 0 };
    
    const recentCandles = candles.slice(-12);
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);
    
    let lastSwingHigh = -Infinity;
    let lastSwingLow = Infinity;
    let swingIndex = -1;
    
    for (let i = 3; i < recentCandles.length - 3; i++) {
        const isSwingHigh = recentCandles[i].high > recentCandles[i-1].high && 
                            recentCandles[i].high > recentCandles[i-2].high &&
                            recentCandles[i].high > recentCandles[i+1].high &&
                            recentCandles[i].high > recentCandles[i+2].high;
        const isSwingLow = recentCandles[i].low < recentCandles[i-1].low && 
                           recentCandles[i].low < recentCandles[i-2].low &&
                           recentCandles[i].low < recentCandles[i+1].low &&
                           recentCandles[i].low < recentCandles[i+2].low;
        
        if (isSwingHigh && recentCandles[i].high > lastSwingHigh) {
            lastSwingHigh = recentCandles[i].high;
            swingIndex = i;
        }
        if (isSwingLow && recentCandles[i].low < lastSwingLow) {
            lastSwingLow = recentCandles[i].low;
            swingIndex = i;
        }
    }
    
    if (swingIndex === -1 || swingIndex >= recentCandles.length - 2) {
        return { detected: false, strength: 0 };
    }
    
    const candlesAfter = recentCandles.slice(swingIndex + 1);
    if (candlesAfter.length < 2) return { detected: false, strength: 0 };
    
    if (bias === 'BUY') {
        const brokeLow = lastSwingLow < Math.min(...lows.slice(0, -3));
        const higherLow = candlesAfter[0].low > lastSwingLow;
        const higherHigh = Math.max(...candlesAfter.map(c => c.high)) > lastSwingHigh;
        
        if (brokeLow && higherLow && higherHigh) {
            return { detected: true, strength: 80 };
        }
        if (higherLow && higherHigh) {
            return { detected: true, strength: 60 };
        }
    } else {
        const brokeHigh = lastSwingHigh > Math.max(...highs.slice(0, -3));
        const lowerHigh = candlesAfter[0].high < lastSwingHigh;
        const lowerLow = Math.min(...candlesAfter.map(c => c.low)) < lastSwingLow;
        
        if (brokeHigh && lowerHigh && lowerLow) {
            return { detected: true, strength: 80 };
        }
        if (lowerHigh && lowerLow) {
            return { detected: true, strength: 60 };
        }
    }
    
    return { detected: false, strength: 0 };
}

function detectCandlePattern(candles, bias) {
    if (candles.length < 2) return { detected: false, pattern: null, strength: 0 };
    
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    
    if (bias === 'BUY') {
        const bullishEngulfing = prev.close < prev.open && 
                                  last.close > last.open &&
                                  last.close > prev.open &&
                                  last.open < prev.close;
        if (bullishEngulfing) {
            return { detected: true, pattern: 'BULLISH_ENGULFING', strength: 75 };
        }
        
        const bodySize = Math.abs(last.close - last.open);
        const lowerWick = Math.min(last.open, last.close) - last.low;
        const bullishPinBar = lowerWick > bodySize * 2 && last.close > last.open;
        if (bullishPinBar) {
            return { detected: true, pattern: 'BULLISH_PINBAR', strength: 70 };
        }
    } else {
        const bearishEngulfing = prev.close > prev.open && 
                                  last.close < last.open &&
                                  last.close < prev.open &&
                                  last.open > prev.close;
        if (bearishEngulfing) {
            return { detected: true, pattern: 'BEARISH_ENGULFING', strength: 75 };
        }
        
        const bodySize = Math.abs(last.close - last.open);
        const upperWick = last.high - Math.max(last.open, last.close);
        const bearishPinBar = upperWick > bodySize * 2 && last.close < last.open;
        if (bearishPinBar) {
            return { detected: true, pattern: 'BEARISH_PINBAR', strength: 70 };
        }
    }
    
    return { detected: false, pattern: null, strength: 0 };
}

// ========== SCORING SYSTEM (60+ points = B grade minimum) ==========
function calculateSignalScore(factors) {
    let score = 0;
    let breakdown = [];
    
    // Core requirements (must have these to even consider)
    if (!factors.bos || !factors.atLevel) {
        return { score: 0, breakdown: ['Missing BOS or key level'], passed: false, grade: 'F', recommendedLotPercent: 0 };
    }
    
    // BOS (required - 25 points)
    if (factors.bos) {
        score += 25;
        breakdown.push('BOS: 25');
    }
    
    // At key level (required - 15 points)
    if (factors.atLevel) {
        score += 15;
        breakdown.push('Key level: 15');
    }
    
    // Retracement (20 points)
    if (factors.retraced) {
        score += 20;
        breakdown.push('Retracement: 20');
    }
    
    // Liquidity Sweep (20 points)
    if (factors.sweep) {
        score += 20;
        breakdown.push('Liquidity sweep: 20');
    }
    
    // MSS/CHoCH (15 points)
    if (factors.mss && factors.mss.detected) {
        score += 15;
        breakdown.push(`MSS: 15`);
    }
    
    // Candle Pattern (10 points)
    if (factors.candlePattern && factors.candlePattern.detected) {
        score += 10;
        breakdown.push(`${factors.candlePattern.pattern}: 10`);
    }
    
    // FVG (10 points)
    if (factors.fvg) {
        score += 10;
        breakdown.push('FVG: 10');
    }
    
    // Order Block (10 points)
    if (factors.ob) {
        score += 10;
        breakdown.push('Order block: 10');
    }
    
    // Session boost (+5)
    if (factors.sessionBoost) {
        score += 5;
        breakdown.push('London/NY session: +5');
    }
    
    // Cap at 100
    score = Math.min(100, score);
    
    // Determine grade (60 points minimum to PASS)
    let grade = 'F';
    let passed = false;
    let recommendedLotPercent = 0;
    
    if (score >= 80) {
        grade = 'A+';
        passed = true;
        recommendedLotPercent = 100;
    } else if (score >= 70) {
        grade = 'A';
        passed = true;
        recommendedLotPercent = 100;
    } else if (score >= 60) {
        grade = 'B';
        passed = true;
        recommendedLotPercent = 75;
    } else if (score >= 50) {
        grade = 'C';
        passed = false;
        recommendedLotPercent = 0;
    } else {
        grade = 'D/F';
        passed = false;
        recommendedLotPercent = 0;
    }
    
    return {
        score: score,
        grade: grade,
        passed: passed,
        recommendedLotPercent: recommendedLotPercent,
        breakdown: breakdown
    };
}

function findLogicalStopLoss(candles, currentPrice, bias, assetConfig) {
    const { minStopPips, maxStopPips, atrMultiplier, class: assetClass } = assetConfig;
    
    let atrStop = 0;
    if (candles && candles.length >= 20) {
        const recentCandles = candles.slice(-20);
        const avgTrueRange = recentCandles.reduce((sum, c, i, arr) => {
            if (i === 0) return 0;
            const tr = Math.max(c.high - c.low, Math.abs(c.high - arr[i-1].close), Math.abs(c.low - arr[i-1].close));
            return sum + tr;
        }, 0) / (recentCandles.length - 1);
        atrStop = avgTrueRange * atrMultiplier;
    }
    
    let swingStop = null;
    if (candles && candles.length >= 30) {
        const recentCandles = candles.slice(-30);
        const swingPoints = [];
        
        for (let i = 2; i < recentCandles.length - 2; i++) {
            if (recentCandles[i].low < recentCandles[i-1].low && 
                recentCandles[i].low < recentCandles[i-2].low &&
                recentCandles[i].low < recentCandles[i+1].low &&
                recentCandles[i].low < recentCandles[i+2].low) {
                swingPoints.push({ price: recentCandles[i].low, type: 'LOW' });
            }
            if (recentCandles[i].high > recentCandles[i-1].high && 
                recentCandles[i].high > recentCandles[i-2].high &&
                recentCandles[i].high > recentCandles[i+1].high &&
                recentCandles[i].high > recentCandles[i+2].high) {
                swingPoints.push({ price: recentCandles[i].high, type: 'HIGH' });
            }
        }
        
        const buffer = currentPrice * 0.0005;
        if (bias === 'BUY') {
            const validLows = swingPoints.filter(p => p.type === 'LOW' && p.price < currentPrice);
            if (validLows.length > 0) {
                const nearestLow = Math.max(...validLows.map(p => p.price));
                swingStop = nearestLow - buffer;
            }
        } else {
            const validHighs = swingPoints.filter(p => p.type === 'HIGH' && p.price > currentPrice);
            if (validHighs.length > 0) {
                const nearestHigh = Math.min(...validHighs.map(p => p.price));
                swingStop = nearestHigh + buffer;
            }
        }
    }
    
    let stopDistance = 0;
    let finalStop = null;
    
    if (swingStop) {
        stopDistance = Math.abs(currentPrice - swingStop);
        finalStop = swingStop;
    } else if (atrStop > 0) {
        stopDistance = atrStop;
        finalStop = bias === 'BUY' ? currentPrice - atrStop : currentPrice + atrStop;
    } else {
        stopDistance = minStopPips;
        finalStop = bias === 'BUY' ? currentPrice - minStopPips : currentPrice + minStopPips;
    }
    
    let stopPips = stopDistance;
    if (assetClass === 'forex') stopPips = stopDistance * 10000;
    else if (assetClass === 'commodities') stopPips = stopDistance;
    else stopPips = stopDistance;
    
    if (stopPips < minStopPips) {
        const adjustment = minStopPips - stopPips;
        finalStop = bias === 'BUY' ? finalStop - adjustment : finalStop + adjustment;
    } else if (stopPips > maxStopPips) {
        const adjustment = stopPips - maxStopPips;
        finalStop = bias === 'BUY' ? finalStop + adjustment : finalStop - adjustment;
    }
    
    return finalStop;
}

function findLogicalTakeProfit(candles, currentPrice, entry, stopLoss, bias, assetConfig) {
    const { tpMultiplier } = assetConfig;
    const risk = Math.abs(entry - stopLoss);
    
    let levelTP = null;
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
        
        const buffer = currentPrice * 0.0005;
        if (bias === 'BUY') {
            const validResistances = resistanceLevels.filter(r => r > entry);
            validResistances.sort((a, b) => a - b);
            if (validResistances.length > 0) {
                levelTP = validResistances[0] - buffer;
            }
        } else {
            const validSupports = supportLevels.filter(s => s < entry);
            validSupports.sort((a, b) => b - a);
            if (validSupports.length > 0) {
                levelTP = validSupports[0] + buffer;
            }
        }
    }
    
    let takeProfit = null;
    let actualRR = 0;
    const minRR = 2.0;
    const targetRR = Math.max(minRR, tpMultiplier);
    
    if (levelTP) {
        if (bias === 'BUY') {
            actualRR = (levelTP - entry) / risk;
            if (actualRR >= minRR) {
                takeProfit = levelTP;
            } else {
                takeProfit = entry + (risk * minRR);
                actualRR = minRR;
            }
        } else {
            actualRR = (entry - levelTP) / risk;
            if (actualRR >= minRR) {
                takeProfit = levelTP;
            } else {
                takeProfit = entry - (risk * minRR);
                actualRR = minRR;
            }
        }
    } else {
        if (bias === 'BUY') {
            takeProfit = entry + (risk * targetRR);
        } else {
            takeProfit = entry - (risk * targetRR);
        }
        actualRR = targetRR;
    }
    
    if (actualRR > 4.0) {
        if (bias === 'BUY') {
            takeProfit = entry + (risk * 4.0);
        } else {
            takeProfit = entry - (risk * 4.0);
        }
        actualRR = 4.0;
    }
    
    return { takeProfit, rr: actualRR.toFixed(1) };
}

function calculateTradeLevels(price, bias, assetConfig, candles) {
    const stopLoss = findLogicalStopLoss(candles, price, bias, assetConfig);
    const entry = price;
    const { takeProfit, rr } = findLogicalTakeProfit(candles, price, entry, stopLoss, bias, assetConfig);
    const riskDistance = Math.abs(entry - stopLoss);
    
    if (parseFloat(rr) < 2.0) {
        console.log(`⚠️ RR ${rr} below minimum 2:1, skipping`);
        return null;
    }
    
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDistPoints = riskDistance + assetConfig.spread;
    let lotSize = riskAmount / (stopDistPoints * assetConfig.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, assetConfig.maxLot));
    
    return {
        entry: entry.toFixed(assetConfig.digits),
        sl: stopLoss.toFixed(assetConfig.digits),
        tp: takeProfit.toFixed(assetConfig.digits),
        rrRatio: rr,
        lotSize: lotSize.toFixed(2),
        riskDistance: riskDistance
    };
}

// ========== SIGNAL ANALYSIS WITH SCORING SYSTEM ==========
function analyzeSignal(prices, candles, assetConfig) {
    if (candles.length < 30) {
        return { bias: 'WAIT', confidence: 30, currentPrice: prices[prices.length-1] };
    }
    
    const curPrice = prices[prices.length-1];
    const keyLevels = getKeyLevels(candles, curPrice);
    const atSupport = isAtSupport(curPrice, keyLevels);
    const atResistance = isAtResistance(curPrice, keyLevels);
    const atLevel = atSupport.atLevel || atResistance.atLevel;
    
    const bos = detectBOS(candles);
    const fvg = detectFVG(candles);
    const ob = detectOrderBlock(candles);
    const sessionBoost = getSessionMultiplier() >= 1.0;
    
    let bias = null;
    let targetLevel = null;
    let retraced = false;
    let sweep = false;
    let mss = { detected: false, strength: 0 };
    let candlePattern = { detected: false, pattern: null, strength: 0 };
    
    if (atSupport.atLevel) {
        bias = 'BUY';
        targetLevel = fvg ? (fvg.type === 'BULLISH' ? fvg.level2 : fvg.level) : (ob ? ob.level : null);
        retraced = targetLevel ? checkRetracement(candles, targetLevel, 'BUY') : false;
        sweep = targetLevel ? detectLiquiditySweep(candles, targetLevel) : false;
        mss = detectMSS(candles, 'BUY');
        candlePattern = detectCandlePattern(candles, 'BUY');
    } else if (atResistance.atLevel) {
        bias = 'SELL';
        targetLevel = fvg ? (fvg.type === 'BEARISH' ? fvg.level : fvg.level2) : (ob ? ob.level : null);
        retraced = targetLevel ? checkRetracement(candles, targetLevel, 'SELL') : false;
        sweep = targetLevel ? detectLiquiditySweep(candles, targetLevel) : false;
        mss = detectMSS(candles, 'SELL');
        candlePattern = detectCandlePattern(candles, 'SELL');
    }
    
    // Calculate score
    const scoreResult = calculateSignalScore({
        bos: !!(bos && ((bias === 'BUY' && bos.type === 'BULLISH') || (bias === 'SELL' && bos.type === 'BEARISH'))),
        atLevel: atLevel,
        retraced: retraced,
        sweep: sweep,
        mss: mss,
        candlePattern: candlePattern,
        fvg: !!fvg,
        ob: !!ob,
        sessionBoost: sessionBoost
    });
    
    // Build reasons
    let reasons = [];
    if (scoreResult.passed) {
        reasons.push(`${bias === 'BUY' ? '🟢' : '🔴'} ${bias} Signal | Grade: ${scoreResult.grade} (${scoreResult.score}/100 pts)`);
        if (atSupport.atLevel) reasons.push(`📍 Support at ${atSupport.level.toFixed(assetConfig.digits)} (${atSupport.type})`);
        if (atResistance.atLevel) reasons.push(`📍 Resistance at ${atResistance.level.toFixed(assetConfig.digits)} (${atResistance.type})`);
        if (bos) reasons.push(`📈 BOS confirmed (broke ${bos.level.toFixed(assetConfig.digits)})`);
        if (retraced) reasons.push(`✅ Retracement confirmed (2 candles)`);
        if (sweep) reasons.push(`💧 Liquidity sweep confirmed`);
        if (mss.detected) reasons.push(`🔄 MSS confirmed (strength: ${mss.strength})`);
        if (candlePattern.detected) reasons.push(`🕯️ ${candlePattern.pattern} detected`);
        if (fvg) reasons.push(`📊 FVG: ${fvg.level.toFixed(assetConfig.digits)} → ${fvg.level2.toFixed(assetConfig.digits)}`);
        if (ob) reasons.push(`🔷 OB at ${ob.level.toFixed(assetConfig.digits)}`);
        if (sessionBoost) reasons.push(`🔥 London/NY session boost (+5 pts)`);
        reasons.push(`📊 Score breakdown: ${scoreResult.breakdown.join(' + ')} = ${scoreResult.score}`);
        
        if (scoreResult.recommendedLotPercent < 100) {
            reasons.push(`⚠️ B-grade signal: Use ${scoreResult.recommendedLotPercent}% of calculated lot size`);
        }
        
        let confidence = Math.min(85, 50 + Math.floor(scoreResult.score / 2.5));
        
        return {
            bias: bias,
            confidence: confidence,
            grade: scoreResult.grade,
            score: scoreResult.score,
            lotPercent: scoreResult.recommendedLotPercent,
            reasons: reasons,
            currentPrice: curPrice,
            targetLevel: targetLevel
        };
    }
    
    return {
        bias: 'WAIT',
        confidence: 40,
        grade: scoreResult.grade,
        score: scoreResult.score,
        reasons: [`❌ Signal rejected: ${scoreResult.score}/100 pts (need 60+ for B grade)`],
        currentPrice: curPrice
    };
}

async function sendTelegramAlert(symbolDisplay, signal, tradeLevels, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    if (isCooldownActive(symbolDisplay, signal.bias)) {
        console.log(`⏸️ Cooldown active for ${symbolDisplay} ${signal.bias}`);
        return false;
    }
    
    if (isDuplicateSignal(symbolDisplay, signal.bias, signal.currentPrice)) {
        return false;
    }
    
    const session = getCurrentSession();
    const timestamp = new Date().toLocaleString();
    
    // Adjust lot size based on grade
    let finalLotSize = parseFloat(tradeLevels.lotSize);
    let lotAdjustmentNote = "";
    if (signal.grade === 'B' && signal.lotPercent === 75) {
        finalLotSize = finalLotSize * 0.75;
        lotAdjustmentNote = " (75% of calculated - B-grade signal)";
    }
    finalLotSize = Math.floor(finalLotSize * 1000) / 1000;
    
    const message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | ${signal.grade} Grade (${signal.score}/100) | ${signal.confidence}% confidence
⏰ ${timestamp} (${session} session)

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0, 6).join('\n')}

━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop Loss: ${tradeLevels.sl}
🎯 Take Profit: ${tradeLevels.tp}
📐 Risk/Reward: 1:${tradeLevels.rrRatio}
💰 Lot Size: ${finalLotSize.toFixed(2)}${lotAdjustmentNote}

━━━━━━━━━━━━━━━━━━━
⚠️ Mode: SCALP | Risk: ${DEFAULT_RISK_PERCENT}% | Balance: $${DEFAULT_BALANCE}
    `;
    
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        const json = await res.json();
        if (json.ok) {
            console.log(`✅ Alert sent for ${symbolDisplay} (${signal.grade} - ${signal.score}pts)`);
            setCooldown(symbolDisplay, signal.bias);
            return true;
        }
    } catch(e) { console.error('Telegram error:', e.message); }
    return false;
}

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
    data.change = ((data.currentPrice - data.candles[data.candles.length-2]?.close) / data.candles[data.candles.length-2]?.close * 100) || 0;
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
                const prices = candles.map(c => c.close);
                if (candles.length >= 30) {
                    const signal = analyzeSignal(prices, candles, assetConfig);
                    console.log(`📊 ${displayName} - ${signal.bias} | ${signal.grade} (${signal.score}pts) | ${signal.confidence}%`);
                    
                    // ONLY send B grade or higher (60+ points)
                    if (signal.bias !== 'WAIT' && signal.grade === 'B' || signal.grade === 'A' || signal.grade === 'A+') {
                        const tradeLevels = calculateTradeLevels(signal.currentPrice, signal.bias, assetConfig, candles);
                        if (tradeLevels && parseFloat(tradeLevels.rrRatio) >= 2.0) {
                            await sendTelegramAlert(displayName, signal, tradeLevels, assetConfig);
                        } else {
                            console.log(`⏸️ ${displayName} skipped - RR ${tradeLevels?.rrRatio} below 2:1`);
                        }
                    } else if (signal.bias !== 'WAIT') {
                        console.log(`⏸️ ${displayName} skipped - Grade ${signal.grade} (below B threshold)`);
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

async function main() {
    console.log('--- OMNI-SIGNAL SCALPING OPTIMIZED (SCORING SYSTEM) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: SCALP | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);
    console.log(`🔧 SCORING SYSTEM RULES:`);
    console.log(`   - A+ (80-100pts): Full lot size | A (70-79pts): Full lot size`);
    console.log(`   - B (60-69pts): 75% lot size | C (50-59pts): ❌ NO SEND`);
    console.log(`   - Minimum threshold: 60 points (B grade)`);
    console.log(`   - Minimum RR: 1:2`);
    console.log(`   - Duplicate prevention: 1 hour | Cooldown: 15 min`);

    let eurusd, gbpusd, usdjpy, usdcad, usdchf, usdsek;
    try {
        eurusd = await fetchForexPrice('EUR', 'USD');
        gbpusd = await fetchForexPrice('GBP', 'USD');
        usdjpy = await fetchForexPrice('USD', 'JPY');
        usdcad = await fetchForexPrice('USD', 'CAD');
        usdchf = await fetchForexPrice('USD', 'CHF');
        usdsek = await fetchForexPrice('USD', 'SEK');
    } catch(e) { console.error('Forex error:', e.message); }

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
        { file: 'wtiusd', fetcher: fetchOilPrice, display: 'WTI Oil', config: ASSET_CONFIGS.wtiusd }
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
    for (const a of oil) await processAsset(a.file, a.fetcher, a.display, a.config);

    if (dxyPrice) {
        const dxyData = { currentPrice: dxyPrice, timestamp: Date.now(), candles: [] };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(dxyData, null, 2));
    }
    console.log('--- Completed ---');
}

main().catch(err => console.error('Fatal error:', err));
