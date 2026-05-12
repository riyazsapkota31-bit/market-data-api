// fetch-prices.js – v17.0 (Institutional Order Flow Strategy)

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// ========== GITHUB SECRETS ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

// ========== YOUR PERSONAL TRADING PARAMETERS ==========
const DEFAULT_BALANCE = 7200;
const DEFAULT_RISK_PERCENT = 1.0;
const DEFAULT_MODE = 'scalp';

// ========== COOLDOWN TRACKING (30 minutes) ==========
const lastAlertCache = {};
let oilRunCounter = 0;

// ========== XM STANDARD ACCOUNT SPREADS ==========
const ASSET_CONFIGS = {
    eurusd: { multiplier: 10000, spread: 0.00016, digits: 5, class: 'forex' },
    gbpusd: { multiplier: 10000, spread: 0.00019, digits: 5, class: 'forex' },
    usdjpy: { multiplier: 100, spread: 0.03, digits: 3, class: 'forex' },
    usdcad: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex' },
    usdchf: { multiplier: 10000, spread: 0.00015, digits: 5, class: 'forex' },
    usdsek: { multiplier: 10000, spread: 0.0003, digits: 5, class: 'forex' },
    btcusd: { multiplier: 10, spread: 75.00, digits: 0, class: 'crypto' },
    ethusd: { multiplier: 10, spread: 6.00, digits: 0, class: 'crypto' },
    solusd: { multiplier: 10, spread: 0.50, digits: 2, class: 'crypto' },
    xauusd: { multiplier: 100, spread: 0.040, digits: 2, class: 'commodities' },
    xagusd: { multiplier: 100, spread: 0.030, digits: 3, class: 'commodities' },
    wtiusd: { multiplier: 100, spread: 0.030, digits: 2, class: 'commodities' },
    dxy: { multiplier: 100, spread: 0.05, digits: 4, class: 'forex' }
};

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

// ========== FOREX ==========
async function fetchForexPrice(base, quote) {
    const url = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`;
    const data = await fetchJSON(url);
    return data.rates[quote];
}

// ========== CRYPTO ==========
async function fetchCryptoPrice(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const data = await fetchJSON(url);
    if (!data[id]?.usd) throw new Error(`No price for ${id}`);
    return data[id].usd;
}

// ========== GOLD & SILVER ==========
async function fetchGoldPrice() {
    const url = 'https://api.gold-api.com/price/XAU';
    const data = await fetchJSON(url);
    if (data && data.price && data.price > 0) return data.price;
    throw new Error('Invalid gold price response');
}

async function fetchSilverPrice() {
    const url = 'https://api.gold-api.com/price/XAG';
    const data = await fetchJSON(url);
    if (data && data.price && data.price > 0) return data.price;
    throw new Error('Invalid silver price response');
}

// ========== OIL ==========
let lastOilPrice = null;
let lastOilFetchTime = 0;

async function fetchOilPrice() {
    if (!ALPHA_VANTAGE_KEY) throw new Error('ALPHA_VANTAGE_KEY missing');
    
    oilRunCounter++;
    if (oilRunCounter % 3 !== 1) {
        console.log('⏸️ Skipping oil fetch (3-min interval)');
        if (lastOilPrice) return lastOilPrice;
        throw new Error('No cached oil price');
    }
    
    const now = Date.now();
    if (lastOilPrice && (now - lastOilFetchTime) < 120000) {
        console.log('⚠️ Using cached oil price');
        return lastOilPrice;
    }
    
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=CL&apikey=${ALPHA_VANTAGE_KEY}`;
    const data = await fetchJSON(url);
    const quote = data['Global Quote'];
    
    if (quote && quote['05. price']) {
        const price = parseFloat(quote['05. price']);
        if (!isNaN(price) && price > 50 && price < 150) {
            console.log(`✓ Oil price via Alpha Vantage: $${price}`);
            lastOilPrice = price;
            lastOilFetchTime = now;
            return price;
        }
    }
    throw new Error('Oil price not found');
}

// ========== DXY CALCULATION ==========
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

// ========== SESSION TIMING ==========
function getCurrentSession() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    
    if (utcHour >= 7 && utcHour < 16) return 'LONDON';
    if (utcHour >= 12 && utcHour < 20) return 'NEW_YORK';
    if (utcHour >= 23 || utcHour < 8) return 'TOKYO';
    return 'OFF_HOURS';
}

// ========== STEP 1: SUPPLY & DEMAND ZONES ==========
function findSupplyDemandZones(candles) {
    if (!candles || candles.length < 50) return { supplyZones: [], demandZones: [] };
    
    const supplyZones = [];
    const demandZones = [];
    
    // Find swing highs (potential supply)
    for (let i = 10; i < candles.length - 10; i++) {
        const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        if (isSwingHigh) {
            supplyZones.push(candles[i].high);
        }
        
        const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                           candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
        if (isSwingLow) {
            demandZones.push(candles[i].low);
        }
    }
    
    // Find clusters (areas with multiple touches)
    const supplyClusters = [];
    const demandClusters = [];
    
    for (const price of supplyZones) {
        let cluster = supplyClusters.find(c => Math.abs(c.price - price) / price < 0.002);
        if (cluster) cluster.count++;
        else supplyClusters.push({ price, count: 1 });
    }
    
    for (const price of demandZones) {
        let cluster = demandClusters.find(c => Math.abs(c.price - price) / price < 0.002);
        if (cluster) cluster.count++;
        else demandClusters.push({ price, count: 1 });
    }
    
    return {
        supplyZones: supplyClusters.filter(z => z.count >= 2).map(z => z.price),
        demandZones: demandClusters.filter(z => z.count >= 2).map(z => z.price)
    };
}

function isAtSupplyZone(currentPrice, supplyZones) {
    for (const zone of supplyZones) {
        if (Math.abs(currentPrice - zone) / currentPrice < 0.002) {
            return { isAtZone: true, zone, type: 'SUPPLY' };
        }
    }
    return { isAtZone: false };
}

function isAtDemandZone(currentPrice, demandZones) {
    for (const zone of demandZones) {
        if (Math.abs(currentPrice - zone) / currentPrice < 0.002) {
            return { isAtZone: true, zone, type: 'DEMAND' };
        }
    }
    return { isAtZone: false };
}

// ========== STEP 2: MARKET STRUCTURE (BOS/CHoCH) ==========
function detectMarketStructure(candles) {
    if (!candles || candles.length < 30) return { structure: 'UNKNOWN', bos: null, choch: null };
    
    const swingHighs = [];
    const swingLows = [];
    
    for (let i = 10; i < candles.length - 10; i++) {
        const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                           candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
        
        if (isSwingHigh) swingHighs.push({ index: i, price: candles[i].high });
        if (isSwingLow) swingLows.push({ index: i, price: candles[i].low });
    }
    
    if (swingHighs.length < 2 || swingLows.length < 2) return { structure: 'UNKNOWN', bos: null, choch: null };
    
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const prevSwingHigh = swingHighs[swingHighs.length - 2];
    const lastSwingLow = swingLows[swingLows.length - 1];
    const prevSwingLow = swingLows[swingLows.length - 2];
    
    let bosDirection = null;
    let chochDirection = null;
    
    if (lastSwingHigh.price > prevSwingHigh.price) bosDirection = 'BULLISH';
    if (lastSwingLow.price < prevSwingLow.price) bosDirection = 'BEARISH';
    
    const lastCandle = candles[candles.length - 1];
    if (bosDirection === 'BULLISH' && lastCandle.close > prevSwingHigh.price) {
        chochDirection = 'BULLISH';
    }
    if (bosDirection === 'BEARISH' && lastCandle.close < prevSwingLow.price) {
        chochDirection = 'BEARISH';
    }
    
    return { structure: bosDirection === 'BULLISH' ? 'UPTREND' : (bosDirection === 'BEARISH' ? 'DOWNTREND' : 'CONSOLIDATION'), bos: bosDirection, choch: chochDirection };
}

// ========== STEP 3: ORDER BLOCK ==========
function detectOrderBlock(candles) {
    if (!candles || candles.length < 5) return { signal: null, strength: 0 };
    
    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const prevPrevCandle = candles[candles.length - 3];
    
    // Bullish Order Block: Strong bullish candle after a bearish candle
    const isBullishOB = prevCandle.close < prevCandle.open && 
                        lastCandle.close > lastCandle.open && 
                        lastCandle.close > prevCandle.high &&
                        lastCandle.close > prevPrevCandle.close;
    
    // Bearish Order Block: Strong bearish candle after a bullish candle
    const isBearishOB = prevCandle.close > prevCandle.open && 
                        lastCandle.close < lastCandle.open && 
                        lastCandle.close < prevCandle.low &&
                        lastCandle.close < prevPrevCandle.close;
    
    if (isBullishOB) return { direction: 'BULLISH', strength: 15, reason: 'Order Block (bullish)' };
    if (isBearishOB) return { direction: 'BEARISH', strength: 15, reason: 'Order Block (bearish)' };
    return { direction: null, strength: 0 };
}

// ========== STEP 4: FAIR VALUE GAP ==========
function detectFVG(candles) {
    if (!candles || candles.length < 3) return { direction: null, strength: 0 };
    
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];
    
    const bullishFVG = c1.high < c3.low && c2.close > c1.high;
    const bearishFVG = c3.high < c1.low && c2.close < c1.low;
    
    if (bullishFVG) return { direction: 'BULLISH', strength: 10, reason: 'Fair Value Gap' };
    if (bearishFVG) return { direction: 'BEARISH', strength: 10, reason: 'Fair Value Gap' };
    return { direction: null, strength: 0 };
}

// ========== STEP 5: LIQUIDITY SWEEP (Candlestick Confirmation) ==========
function detectLiquiditySweep(candles) {
    if (!candles || candles.length < 10) return { direction: null, strength: 0 };
    
    const lastCandle = candles[candles.length - 1];
    const recentHighs = Math.max(...candles.slice(-20).map(c => c.high));
    const recentLows = Math.min(...candles.slice(-20).map(c => c.low));
    
    // Bullish: Price swept below recent low, then closed above it (stop hunt)
    const bullishSweep = lastCandle.low < recentLows && lastCandle.close > recentLows && lastCandle.close > lastCandle.open;
    
    // Bearish: Price swept above recent high, then closed below it (stop hunt)
    const bearishSweep = lastCandle.high > recentHighs && lastCandle.close < recentHighs && lastCandle.close < lastCandle.open;
    
    if (bullishSweep) return { direction: 'BULLISH', strength: 25, reason: 'Liquidity sweep (bullish)' };
    if (bearishSweep) return { direction: 'BEARISH', strength: 25, reason: 'Liquidity sweep (bearish)' };
    return { direction: null, strength: 0 };
}

// ========== STEP 6: RETEST / BREAK CONFIRMATION ==========
function detectRetestBreak(candles, currentPrice, zone, zoneType) {
    if (!candles || candles.length < 5) return { signal: null, strength: 0 };
    
    const recentCandles = candles.slice(-10);
    
    if (zoneType === 'SUPPLY') {
        // Price broke above supply, now retesting
        const brokeResistance = recentCandles.some(c => c.close > zone);
        const retested = Math.abs(currentPrice - zone) / currentPrice < 0.001;
        
        if (brokeResistance && retested) {
            return { direction: 'BULLISH', strength: 15, reason: 'Break & retest (supply becomes support)' };
        }
    }
    
    if (zoneType === 'DEMAND') {
        // Price broke below demand, now retesting
        const brokeSupport = recentCandles.some(c => c.close < zone);
        const retested = Math.abs(currentPrice - zone) / currentPrice < 0.001;
        
        if (brokeSupport && retested) {
            return { direction: 'BEARISH', strength: 15, reason: 'Break & retest (demand becomes resistance)' };
        }
    }
    
    return { direction: null, strength: 0 };
}

// ========== STEP 7: CANDLESTICK PATTERNS ==========
function detectCandlePatterns(candle) {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    
    // Bullish Hammer: Long lower wick, small body at top
    const hammer = lowerWick > body * 2 && upperWick < body && candle.close > candle.open;
    
    // Bearish Shooting Star: Long upper wick, small body at bottom
    const shootingStar = upperWick > body * 2 && lowerWick < body && candle.close < candle.open;
    
    if (hammer) return { direction: 'BULLISH', strength: 15, reason: 'Hammer candle' };
    if (shootingStar) return { direction: 'BEARISH', strength: 15, reason: 'Shooting star candle' };
    
    return { direction: null, strength: 0 };
}

// ========== RISK MANAGER ==========
function calculateTradeLevels(currentPrice, atr, zone, zoneType, direction, confidence, mode, multiplier, spread, digits) {
    let entry, sl, tp1, tp2, rrRatio = 0;
    
    const minRR = mode === 'scalp' ? 2.0 : 4.0;
    const maxRR = mode === 'scalp' ? 4.0 : 12.0;
    const targetRR = Math.min(minRR + (confidence / 100) * 3, maxRR);
    
    if (direction === 'BUY') {
        entry = currentPrice;
        const atrMult = mode === 'scalp' ? 0.45 : 1.0;
        let slDist = atr * atrMult;
        sl = entry - slDist;
        
        // Place stop below demand zone
        if (zoneType === 'DEMAND' && sl > zone) sl = zone * 0.998;
        
        const risk = entry - sl;
        tp1 = entry + risk;
        tp2 = entry + risk * targetRR;
        rrRatio = targetRR;
        
    } else if (direction === 'SELL') {
        entry = currentPrice;
        const atrMult = mode === 'scalp' ? 0.45 : 1.0;
        let slDist = atr * atrMult;
        sl = entry + slDist;
        
        // Place stop above supply zone
        if (zoneType === 'SUPPLY' && sl < zone) sl = zone * 1.002;
        
        const risk = sl - entry;
        tp1 = entry - risk;
        tp2 = entry - risk * targetRR;
        rrRatio = targetRR;
        
    } else return null;
    
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

// ========== MAIN STRATEGY (Institutional Order Flow) ==========
function analyzeSignal(prices, candles, assetClass) {
    // Minimum data requirement
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Building data (need 50 candles)'], rsi: 50, trend: 'SIDEWAYS', currentPrice: prices[prices.length-1] };
    }
    
    const currentPrice = prices[prices.length-1];
    const rsi = calcRSI(prices);
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, 50);
    const atr = calcATR(prices, 14);
    
    // Trend detection
    let trend = 'SIDEWAYS';
    if (ema20 > ema50 && ema20 > ema20 * 1.001) trend = 'BULLISH';
    if (ema20 < ema50 && ema20 < ema20 * 0.999) trend = 'BEARISH';
    
    // ========== STEP 1: FIND S&D ZONES ==========
    const { supplyZones, demandZones } = findSupplyDemandZones(candles);
    const atSupply = isAtSupplyZone(currentPrice, supplyZones);
    const atDemand = isAtDemandZone(currentPrice, demandZones);
    
    // If not at a key zone, WAIT
    if (!atSupply.isAtZone && !atDemand.isAtZone) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Not at key supply/demand zone'], rsi, trend, currentPrice, atr };
    }
    
    const zone = atSupply.isAtZone ? atSupply.zone : atDemand.zone;
    const zoneType = atSupply.isAtZone ? 'SUPPLY' : 'DEMAND';
    const expectedDirection = zoneType === 'SUPPLY' ? 'SELL' : 'BUY';
    
    // ========== STEP 2: MARKET STRUCTURE ==========
    const marketStructure = detectMarketStructure(candles);
    
    // Structure must align with expected direction
    let structureAligned = false;
    if (expectedDirection === 'BUY' && (marketStructure.bos === 'BULLISH' || marketStructure.choch === 'BULLISH')) {
        structureAligned = true;
    }
    if (expectedDirection === 'SELL' && (marketStructure.bos === 'BEARISH' || marketStructure.choch === 'BEARISH')) {
        structureAligned = true;
    }
    
    if (!structureAligned) {
        return { bias: 'WAIT', confidence: 35, reasons: [`Structure not aligned for ${expectedDirection}`], rsi, trend, currentPrice, atr };
    }
    
    // ========== STEP 3-7: INSTITUTIONAL FOOTPRINTS & CONFIRMATIONS ==========
    let buyScore = 0, sellScore = 0;
    const reasons = [];
    
    // Order Block (15 points)
    const orderBlock = detectOrderBlock(candles);
    if (orderBlock.direction === 'BULLISH') { buyScore += orderBlock.strength; reasons.push(orderBlock.reason); }
    if (orderBlock.direction === 'BEARISH') { sellScore += orderBlock.strength; reasons.push(orderBlock.reason); }
    
    // FVG (10 points)
    const fvg = detectFVG(candles);
    if (fvg.direction === 'BULLISH') { buyScore += fvg.strength; reasons.push(fvg.reason); }
    if (fvg.direction === 'BEARISH') { sellScore += fvg.strength; reasons.push(fvg.reason); }
    
    // Liquidity Sweep (25 points) - REQUIRED
    const liquiditySweep = detectLiquiditySweep(candles);
    if (liquiditySweep.direction === 'BULLISH') { buyScore += liquiditySweep.strength; reasons.push(liquiditySweep.reason); }
    if (liquiditySweep.direction === 'BEARISH') { sellScore += liquiditySweep.strength; reasons.push(liquiditySweep.reason); }
    
    // Retest/Break (15 points) - REQUIRED
    const retestBreak = detectRetestBreak(candles, currentPrice, zone, zoneType);
    if (retestBreak.direction === 'BULLISH') { buyScore += retestBreak.strength; reasons.push(retestBreak.reason); }
    if (retestBreak.direction === 'BEARISH') { sellScore += retestBreak.strength; reasons.push(retestBreak.reason); }
    
    // Candlestick Pattern (15 points)
    const lastCandle = candles[candles.length - 1];
    const candlePattern = detectCandlePatterns(lastCandle);
    if (candlePattern.direction === 'BULLISH') { buyScore += candlePattern.strength; reasons.push(candlePattern.reason); }
    if (candlePattern.direction === 'BEARISH') { sellScore += candlePattern.strength; reasons.push(candlePattern.reason); }
    
    // Session bonus (10 points)
    const currentSession = getCurrentSession();
    const sessionBonus = (currentSession === 'LONDON' || currentSession === 'NEW_YORK') ? 10 : 0;
    
    // Apply session bonus to expected direction
    if (expectedDirection === 'BUY') buyScore += sessionBonus;
    else sellScore += sessionBonus;
    
    // ========== DETERMINE SIGNAL ==========
    let bias = 'WAIT';
    let confidence = 40;
    let finalDirection = null;
    
    // Minimum score required: 50 points (liquidity sweep 25 + retest 15 + zone 10 + one more = 50+)
    const minScore = 50;
    
    if (expectedDirection === 'BUY' && buyScore > minScore && buyScore > sellScore) {
        bias = 'BUY';
        finalDirection = 'BUY';
        confidence = Math.min(85, 50 + Math.floor(buyScore / 2));
    } else if (expectedDirection === 'SELL' && sellScore > minScore && sellScore > buyScore) {
        bias = 'SELL';
        finalDirection = 'SELL';
        confidence = Math.min(85, 50 + Math.floor(sellScore / 2));
    }
    
    // Overbought/Oversold filter
    if (bias === 'BUY' && rsi > 70) {
        bias = 'WAIT';
        confidence = 40;
        reasons.push('RSI overbought (>70) - waiting for pullback');
    }
    if (bias === 'SELL' && rsi < 30) {
        bias = 'WAIT';
        confidence = 40;
        reasons.push('RSI oversold (<30) - waiting for bounce');
    }
    
    // Sideways penalty (reduce confidence by 10%)
    if (trend === 'SIDEWAYS' && bias !== 'WAIT') {
        confidence = Math.max(50, confidence - 10);
        reasons.push('Sideways market - reduced confidence');
    }
    
    const uniqueReasons = [...new Set(reasons)];
    
    return { 
        bias, 
        confidence, 
        reasons: uniqueReasons.slice(0,5), 
        rsi, 
        trend, 
        currentPrice, 
        atr,
        zone,
        zoneType
    };
}

// ========== TELEGRAM ALERT ==========
async function sendTelegramAlert(symbolDisplay, signal, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    const cacheKey = `${symbolDisplay}_${signal.bias}`;
    const lastAlert = lastAlertCache[cacheKey];
    const now = Date.now();
    
    if (lastAlert && (now - lastAlert) < 1800000) { // 30 minutes
        const minutesLeft = Math.round((1800000 - (now - lastAlert)) / 60000);
        console.log(`⏸️ Skipping duplicate ${signal.bias} for ${symbolDisplay} (${minutesLeft} min left)`);
        return false;
    }
    
    let tradeLevels = null;
    if (signal.bias !== 'WAIT') {
        const direction = signal.bias;
        const zoneType = signal.zoneType;
        const zone = signal.zone;
        
        tradeLevels = calculateTradeLevels(
            signal.currentPrice, signal.atr, zone, zoneType, direction, signal.confidence, DEFAULT_MODE,
            assetConfig.multiplier, assetConfig.spread, assetConfig.digits
        );
    }
    
    const icon = signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const timestamp = new Date().toLocaleString();
    const currentSession = getCurrentSession();
    
    let message = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${icon} | ${signal.confidence}% confidence
⏰ ${timestamp} (${currentSession} session)

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}
📈 RSI: ${signal.rsi.toFixed(1)} | Trend: ${signal.trend}
📊 ATR: ${signal.atr.toFixed(assetConfig.digits === 5 ? 5 : 2)}
📍 ${signal.zoneType} Zone: ${signal.zone?.toFixed(assetConfig.digits) || 'N/A'}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0,4).join(', ') || 'Signal detected'}
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
        if (json.ok) {
            console.log(`✅ Telegram alert sent for ${symbolDisplay}`);
            lastAlertCache[cacheKey] = now;
            return true;
        }
    } catch(e) { console.error('Telegram send error:', e.message); }
    return false;
}

// ========== CANDLE BUILDER ==========
function loadCandleHistory(file) {
    const historyFile = path.join(dataDir, `${file}.json`);
    if (fs.existsSync(historyFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(historyFile));
            return data.candles || [];
        } catch(e) {}
    }
    return [];
}

function saveCandleToHistory(file, candle) {
    const historyFile = path.join(dataDir, `${file}.json`);
    let data = { candles: [] };
    if (fs.existsSync(historyFile)) {
        try { data = JSON.parse(fs.readFileSync(historyFile)); } catch(e) {}
    }
    if (!data.candles) data.candles = [];
    data.candles.push(candle);
    if (data.candles.length > 200) data.candles.shift();
    data.currentPrice = candle.close;
    data.timestamp = Date.now();
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
}

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

async function processAsset(file, priceFetcher, displayName, assetConfig, isOil = false) {
    try {
        let price = await priceFetcher();
        if (price === undefined || price === null) throw new Error('No price');
        
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        const current5minBucket = Math.floor(minute / 5);
        
        let state = loadCandleState(file);
        let candles = loadCandleHistory(file);
        
        if (!state || state.bucket !== current5minBucket) {
            if (state && state.candle && state.lastPrice) {
                const completedCandle = {
                    timestamp: state.startTime,
                    open: state.candle.open,
                    high: state.candle.high,
                    low: state.candle.low,
                    close: state.lastPrice
                };
                saveCandleToHistory(file, completedCandle);
                candles.push(completedCandle);
                
                const prices = candles.map(c => c.close);
                if (prices.length >= 50) {
                    const signal = analyzeSignal(prices, candles, assetConfig.class);
                    console.log(`📊 ${displayName} - Signal: ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0,2).join(', ') || 'No confluence'}`);
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

// ========== MAIN EXECUTION ==========
async function main() {
    console.log('--- OMNI-SIGNAL v17.0 (Institutional Order Flow Strategy) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: ${DEFAULT_MODE} | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);
    
    // Fetch forex for DXY
    let eurusd, gbpusd, usdjpy, usdcad, usdchf, usdsek;
    try {
        eurusd = await fetchForexPrice('EUR', 'USD');
        gbpusd = await fetchForexPrice('GBP', 'USD');
        usdjpy = await fetchForexPrice('USD', 'JPY');
        usdcad = await fetchForexPrice('USD', 'CAD');
        usdchf = await fetchForexPrice('USD', 'CHF');
        usdsek = await fetchForexPrice('USD', 'SEK');
    } catch (err) { console.error('Forex fetch failed:', err.message); }
    
    let dxyPrice = null;
    if (eurusd && gbpusd && usdjpy && usdcad && usdchf && usdsek) {
        dxyPrice = calculateDXY(eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf);
        console.log(`✓ DXY calculated: ${dxyPrice.toFixed(4)}`);
    }
    
    const forexAssets = [
        { file: 'eurusd', fetcher: () => fetchForexPrice('EUR', 'USD'), display: 'EUR/USD', config: ASSET_CONFIGS.eurusd, isOil: false },
        { file: 'gbpusd', fetcher: () => fetchForexPrice('GBP', 'USD'), display: 'GBP/USD', config: ASSET_CONFIGS.gbpusd, isOil: false },
        { file: 'usdjpy', fetcher: () => fetchForexPrice('USD', 'JPY'), display: 'USD/JPY', config: ASSET_CONFIGS.usdjpy, isOil: false },
        { file: 'usdcad', fetcher: () => fetchForexPrice('USD', 'CAD'), display: 'USD/CAD', config: ASSET_CONFIGS.usdcad, isOil: false },
        { file: 'usdchf', fetcher: () => fetchForexPrice('USD', 'CHF'), display: 'USD/CHF', config: ASSET_CONFIGS.usdchf, isOil: false },
        { file: 'usdsek', fetcher: () => fetchForexPrice('USD', 'SEK'), display: 'USD/SEK', config: ASSET_CONFIGS.usdsek, isOil: false }
    ];
    
    const cryptoAssets = [
        { file: 'btcusd', fetcher: () => fetchCryptoPrice('bitcoin'), display: 'BTC/USD', config: ASSET_CONFIGS.btcusd, isOil: false },
        { file: 'ethusd', fetcher: () => fetchCryptoPrice('ethereum'), display: 'ETH/USD', config: ASSET_CONFIGS.ethusd, isOil: false },
        { file: 'solusd', fetcher: () => fetchCryptoPrice('solana'), display: 'SOL/USD', config: ASSET_CONFIGS.solusd, isOil: false }
    ];
    
    const metalAssets = [
        { file: 'xauusd', fetcher: fetchGoldPrice, display: 'XAUUSD (Gold)', config: ASSET_CONFIGS.xauusd, isOil: false },
        { file: 'xagusd', fetcher: fetchSilverPrice, display: 'XAGUSD (Silver)', config: ASSET_CONFIGS.xagusd, isOil: false }
    ];
    
    const oilAssets = [
        { file: 'wtiusd', fetcher: fetchOilPrice, display: 'WTI Oil', config: ASSET_CONFIGS.wtiusd, isOil: true }
    ];
    
    // Execute with delays
    for (const asset of forexAssets) {
        await processAsset(asset.file, asset.fetcher, asset.display, asset.config, asset.isOil);
    }
    
    console.log('⏸️ 1.5s delay before crypto...');
    await new Promise(r => setTimeout(r, 1500));
    
    for (let i = 0; i < cryptoAssets.length; i++) {
        await processAsset(cryptoAssets[i].file, cryptoAssets[i].fetcher, cryptoAssets[i].display, cryptoAssets[i].config, cryptoAssets[i].isOil);
        if (i < cryptoAssets.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    
    console.log('⏸️ 1.5s delay before metals...');
    await new Promise(r => setTimeout(r, 1500));
    
    for (let i = 0; i < metalAssets.length; i++) {
        await processAsset(metalAssets[i].file, metalAssets[i].fetcher, metalAssets[i].display, metalAssets[i].config, metalAssets[i].isOil);
        if (i < metalAssets.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    
    console.log('⏸️ 1.5s delay before oil...');
    await new Promise(r => setTimeout(r, 1500));
    
    for (const asset of oilAssets) {
        await processAsset(asset.file, asset.fetcher, asset.display, asset.config, asset.isOil);
    }
    
    if (dxyPrice) {
        const dxyData = { currentPrice: dxyPrice, timestamp: Date.now(), candles: [] };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(dxyData, null, 2));
    }
    
    console.log('--- Completed ---');
}

main().catch(err => console.error('Fatal error:', err));
