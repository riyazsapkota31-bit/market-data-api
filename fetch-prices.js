// fetch-prices.js – INSTITUTIONAL SCALPING FINAL (LOGICAL TP/SL + FIXED RETRACEMENT)

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

const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    usdjpy: { multiplier: 100, spread: 0.03, digits: 3, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    usdcad: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    usdchf: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    usdsek: { multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto', stopPercent: 0.005, maxLot: 0.5 },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto', stopPercent: 0.005, maxLot: 5.0 },
    solusd: { multiplier: 10, spread: 0.50, digits: 2, class: 'crypto', stopPercent: 0.005, maxLot: 50.0 },
    xauusd: { multiplier: 100, spread: 0.040, digits: 2, class: 'commodities', stopPercent: 0.002, maxLot: 0.5 },
    xagusd: { multiplier: 100, spread: 0.030, digits: 3, class: 'commodities', stopPercent: 0.002, maxLot: 0.5 },
    wtiusd: { multiplier: 100, spread: 0.030, digits: 2, class: 'commodities', stopPercent: 0.002, maxLot: 1.0 },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex', stopPercent: 0.0008, maxLot: 5.0 }
};

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
    return (Date.now() - lastAlert) < 1800000;
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

// ========== FIXED RETRACEMENT FUNCTION ==========
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

// ========== LOGICAL STOP LOSS (based on market structure) ==========
function findLogicalStopLoss(candles, currentPrice, bias, assetConfig) {
    if (!candles || candles.length < 20) {
        // Fallback to percentage-based
        const stopDistance = currentPrice * assetConfig.stopPercent;
        return bias === 'BUY' ? currentPrice - stopDistance : currentPrice + stopDistance;
    }
    
    const recentCandles = candles.slice(-30);
    const swingPoints = [];
    
    // Find swing lows and highs
    for (let i = 2; i < recentCandles.length - 2; i++) {
        // Swing low
        if (recentCandles[i].low < recentCandles[i-1].low && 
            recentCandles[i].low < recentCandles[i-2].low &&
            recentCandles[i].low < recentCandles[i+1].low &&
            recentCandles[i].low < recentCandles[i+2].low) {
            swingPoints.push({ price: recentCandles[i].low, type: 'LOW' });
        }
        // Swing high
        if (recentCandles[i].high > recentCandles[i-1].high && 
            recentCandles[i].high > recentCandles[i-2].high &&
            recentCandles[i].high > recentCandles[i+1].high &&
            recentCandles[i].high > recentCandles[i+2].high) {
            swingPoints.push({ price: recentCandles[i].high, type: 'HIGH' });
        }
    }
    
    const buffer = currentPrice * 0.0005; // 0.05% buffer
    
    if (bias === 'BUY') {
        // Find nearest swing low BELOW current price
        const validLows = swingPoints.filter(p => p.type === 'LOW' && p.price < currentPrice);
        if (validLows.length > 0) {
            const nearestLow = Math.max(...validLows.map(p => p.price));
            return nearestLow - buffer;
        }
    } else {
        // Find nearest swing high ABOVE current price
        const validHighs = swingPoints.filter(p => p.type === 'HIGH' && p.price > currentPrice);
        if (validHighs.length > 0) {
            const nearestHigh = Math.min(...validHighs.map(p => p.price));
            return nearestHigh + buffer;
        }
    }
    
    // Fallback to percentage
    const stopDistance = currentPrice * assetConfig.stopPercent;
    return bias === 'BUY' ? currentPrice - stopDistance : currentPrice + stopDistance;
}

// ========== LOGICAL TAKE PROFIT (ONE RELIABLE TARGET) ==========
function findLogicalTakeProfit(candles, currentPrice, entry, stopLoss, bias, assetConfig) {
    if (!candles || candles.length < 20) {
        // Fallback to 2.5x risk
        const risk = Math.abs(entry - stopLoss);
        return bias === 'BUY' ? entry + (risk * 2.5) : entry - (risk * 2.5);
    }
    
    const recentCandles = candles.slice(-50);
    const resistanceLevels = [];
    const supportLevels = [];
    
    // Find key levels
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
    
    const risk = Math.abs(entry - stopLoss);
    const buffer = currentPrice * 0.0005; // 0.05% buffer
    let takeProfit = null;
    let actualRR = 0;
    
    if (bias === 'BUY') {
        // Find next resistance above entry
        const validResistances = resistanceLevels.filter(r => r > entry);
        validResistances.sort((a, b) => a - b);
        
        if (validResistances.length > 0) {
            // Place TP just below the resistance level
            takeProfit = validResistances[0] - buffer;
            actualRR = (takeProfit - entry) / risk;
            
            // Cap RR at 4:1 (don't chase unrealistic targets)
            if (actualRR > 4.0) {
                takeProfit = entry + (risk * 4.0);
                actualRR = 4.0;
            }
            // Ensure minimum RR of 1.5:1
            if (actualRR < 1.5) {
                takeProfit = entry + (risk * 1.5);
                actualRR = 1.5;
            }
        } else {
            // No clear resistance, use 2.5x risk
            takeProfit = entry + (risk * 2.5);
            actualRR = 2.5;
        }
    } else {
        // Find next support below entry
        const validSupports = supportLevels.filter(s => s < entry);
        validSupports.sort((a, b) => b - a); // Descending (closest first)
        
        if (validSupports.length > 0) {
            // Place TP just above the support level
            takeProfit = validSupports[0] + buffer;
            actualRR = (entry - takeProfit) / risk;
            
            if (actualRR > 4.0) {
                takeProfit = entry - (risk * 4.0);
                actualRR = 4.0;
            }
            if (actualRR < 1.5) {
                takeProfit = entry - (risk * 1.5);
                actualRR = 1.5;
            }
        } else {
            takeProfit = entry - (risk * 2.5);
            actualRR = 2.5;
        }
    }
    
    return { takeProfit, rr: actualRR.toFixed(1) };
}

// ========== UPDATED TRADE LEVELS CALCULATION ==========
function calculateTradeLevels(price, bias, assetConfig, candles) {
    // Find logical stop loss first
    const stopLoss = findLogicalStopLoss(candles, price, bias, assetConfig);
    
    // Calculate entry (current price for market orders)
    const entry = price;
    
    // Find logical take profit based on stop loss
    const { takeProfit, rr } = findLogicalTakeProfit(candles, price, entry, stopLoss, bias, assetConfig);
    
    // Verify stop distance meets minimum requirement
    const stopDistance = Math.abs(entry - stopLoss);
    const minStopDistance = price * assetConfig.stopPercent;
    
    if (stopDistance < minStopDistance * 0.8) {
        // Stop is too tight, adjust to minimum
        const adjustedSL = bias === 'BUY' 
            ? entry - minStopDistance 
            : entry + minStopDistance;
        // Recalculate TP with adjusted SL
        const adjustedTP = findLogicalTakeProfit(candles, price, entry, adjustedSL, bias, assetConfig);
        return {
            entry: entry.toFixed(assetConfig.digits),
            sl: adjustedSL.toFixed(assetConfig.digits),
            tp: adjustedTP.takeProfit.toFixed(assetConfig.digits),
            rrRatio: adjustedTP.rr,
            riskDistance: minStopDistance
        };
    }
    
    // Calculate lot size
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDistPoints = stopDistance + assetConfig.spread;
    let lotSize = riskAmount / (stopDistPoints * assetConfig.multiplier);
    lotSize = Math.floor(lotSize * 1000) / 1000;
    lotSize = Math.max(0.01, Math.min(lotSize, assetConfig.maxLot));
    
    return {
        entry: entry.toFixed(assetConfig.digits),
        sl: stopLoss.toFixed(assetConfig.digits),
        tp: takeProfit.toFixed(assetConfig.digits),
        rrRatio: rr,
        lotSize: lotSize.toFixed(2),
        riskDistance: stopDistance
    };
}

function analyzeSignal(prices, candles, assetConfig) {
    if (candles.length < 50) {
        return { bias: 'WAIT', confidence: 30, reason: `Building data (${candles.length}/50)`, currentPrice: prices[prices.length-1] };
    }
    
    const curPrice = prices[prices.length-1];
    const keyLevels = getKeyLevels(candles, curPrice);
    const atSupport = isAtSupport(curPrice, keyLevels);
    const atResistance = isAtResistance(curPrice, keyLevels);
    
    const bos = detectBOS(candles);
    const fvg = detectFVG(candles);
    const ob = detectOrderBlock(candles);
    
    let signal = null;
    let reasons = [];
    let confidence = 0;
    
    if (atSupport.atLevel) {
        const targetLevel = fvg ? (fvg.type === 'BULLISH' ? fvg.level2 : fvg.level) : (ob ? ob.level : null);
        const retraced = targetLevel ? checkRetracement(candles, targetLevel, 'BUY') : false;
        const sweep = targetLevel ? detectLiquiditySweep(candles, targetLevel) : false;
        
        if (bos && bos.type === 'BULLISH' && retraced && sweep) {
            signal = 'BUY';
            confidence = 75;
            reasons.push(`🟢 BUY at ${atSupport.type} support (${atSupport.level.toFixed(assetConfig.digits)})`);
            reasons.push(`📈 BOS confirmed (broke ${bos.level.toFixed(assetConfig.digits)})`);
            if (fvg) reasons.push(`📊 FVG retraced (${fvg.level.toFixed(assetConfig.digits)} → ${fvg.level2.toFixed(assetConfig.digits)})`);
            if (ob) reasons.push(`🔷 OB retraced (${ob.level.toFixed(assetConfig.digits)})`);
            reasons.push(`💧 Liquidity sweep confirmed`);
            reasons.push(`✅ Price reversed with 2 bullish candles after touch`);
        }
    }
    
    if (atResistance.atLevel && !signal) {
        const targetLevel = fvg ? (fvg.type === 'BEARISH' ? fvg.level : fvg.level2) : (ob ? ob.level : null);
        const retraced = targetLevel ? checkRetracement(candles, targetLevel, 'SELL') : false;
        const sweep = targetLevel ? detectLiquiditySweep(candles, targetLevel) : false;
        
        if (bos && bos.type === 'BEARISH' && retraced && sweep) {
            signal = 'SELL';
            confidence = 75;
            reasons.push(`🔴 SELL at ${atResistance.type} resistance (${atResistance.level.toFixed(assetConfig.digits)})`);
            reasons.push(`📉 BOS confirmed (broke ${bos.level.toFixed(assetConfig.digits)})`);
            if (fvg) reasons.push(`📊 FVG retraced (${fvg.level.toFixed(assetConfig.digits)} → ${fvg.level2.toFixed(assetConfig.digits)})`);
            if (ob) reasons.push(`🔷 OB retraced (${ob.level.toFixed(assetConfig.digits)})`);
            reasons.push(`💧 Liquidity sweep confirmed`);
            reasons.push(`✅ Price reversed with 2 bearish candles after touch`);
        }
    }
    
    const sessionMult = getSessionMultiplier();
    if (signal && sessionMult >= 1.0) reasons.push('🔥 High volatility session');
    
    if (signal) {
        confidence = Math.min(85, Math.floor(65 + (sessionMult * 10)));
    }
    
    return {
        bias: signal || 'WAIT',
        confidence: signal ? confidence : 40,
        reasons: signal ? reasons : ['⏸️ No setup found - waiting for reversal confirmation'],
        currentPrice: curPrice
    };
}

async function sendTelegramAlert(symbolDisplay, signal, tradeLevels, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    if (isCooldownActive(symbolDisplay, signal.bias)) {
        console.log(`⏸️ Cooldown active for ${symbolDisplay} ${signal.bias}`);
        return false;
    }
    
    const session = getCurrentSession();
    const timestamp = new Date().toLocaleString();
    
    const message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | ${signal.confidence}% confidence
⏰ ${timestamp} (${session} session)

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0, 4).join('\n')}

━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop Loss: ${tradeLevels.sl}
🎯 Take Profit: ${tradeLevels.tp}
📐 Risk/Reward: 1:${tradeLevels.rrRatio}
💰 Lot Size: ${tradeLevels.lotSize}

━━━━━━━━━━━━━━━━━━━
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
                    const signal = analyzeSignal(prices, candles, assetConfig);
                    console.log(`📊 ${displayName} - ${signal.bias} (${signal.confidence}%) - ${signal.reasons[0]}`);
                    if (signal.bias !== 'WAIT' && signal.confidence >= 60) {
                        // Calculate logical trade levels using candle data
                        const tradeLevels = calculateTradeLevels(signal.currentPrice, signal.bias, assetConfig, candles);
                        await sendTelegramAlert(displayName, signal, tradeLevels, assetConfig);
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
    console.log('--- OMNI-SIGNAL INSTITUTIONAL SCALPING FINAL ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: ${DEFAULT_MODE} | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);
    console.log(`🔧 Features:`);
    console.log(`   - Fixed retracement (requires 2 confirmation candles)`);
    console.log(`   - Logical SL based on swing points`);
    console.log(`   - Logical TP based on next major level`);
    console.log(`   - Single reliable TP target (1.5x - 4.0x risk)`);

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
