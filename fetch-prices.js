// fetch-prices.js – v18.0 (HTF direction + LTF confirmation, 30-min cooldown)

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

// ========== COOLDOWN TRACKING ==========
const lastAlertCache = {};
let oilRunCounter = 0;

// ========== XM SPREADS ==========
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

// ---------- FETCHERS (unchanged) ----------
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

// ---------- INDICATORS ----------
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

// ---------- SESSION ----------
function getCurrentSession() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    if (utcHour >= 7 && utcHour < 16) return 'LONDON';
    if (utcHour >= 12 && utcHour < 20) return 'NEW_YORK';
    if (utcHour >= 23 || utcHour < 8) return 'TOKYO';
    return 'OFF_HOURS';
}

// ========== HTF SUPPLY/DEMAND ZONES (200 candles, 0.2% cluster) ==========
function findHTFZones(candles) {
    if (!candles || candles.length < 50) return { supply: [], demand: [] };
    const swingHighs = [];
    const swingLows = [];
    for (let i = 5; i < candles.length - 5; i++) {
        const isHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                       candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
        const isLow  = candles[i].low  < candles[i-1].low  && candles[i].low  < candles[i-2].low &&
                       candles[i].low  < candles[i+1].low  && candles[i].low  < candles[i+2].low;
        if (isHigh) swingHighs.push(candles[i].high);
        if (isLow)  swingLows.push(candles[i].low);
    }
    // cluster within 0.2%
    const supply = [];
    const demand = [];
    for (const h of swingHighs) {
        let found = supply.find(z => Math.abs(z.price - h) / h < 0.002);
        if (found) found.count++;
        else supply.push({ price: h, count: 1 });
    }
    for (const l of swingLows) {
        let found = demand.find(z => Math.abs(z.price - l) / l < 0.002);
        if (found) found.count++;
        else demand.push({ price: l, count: 1 });
    }
    return {
        supply: supply.filter(z => z.count >= 2).map(z => z.price),
        demand: demand.filter(z => z.count >= 2).map(z => z.price)
    };
}

function isAtHTFZone(price, zones, type) {
    for (const zone of zones) {
        if (Math.abs(price - zone) / price < 0.002) return { atZone: true, zone, type };
    }
    return { atZone: false };
}

// ========== LTF ZONES (50 candles, 0.1% cluster) ==========
function findLTFZones(candles) {
    if (!candles || candles.length < 30) return { supply: [], demand: [] };
    const recent = candles.slice(-50);
    const swingHighs = [];
    const swingLows = [];
    for (let i = 3; i < recent.length - 3; i++) {
        const isHigh = recent[i].high > recent[i-1].high && recent[i].high > recent[i-2].high &&
                       recent[i].high > recent[i+1].high && recent[i].high > recent[i+2].high;
        const isLow  = recent[i].low  < recent[i-1].low  && recent[i].low  < recent[i-2].low &&
                       recent[i].low  < recent[i+1].low  && recent[i].low  < recent[i+2].low;
        if (isHigh) swingHighs.push(recent[i].high);
        if (isLow)  swingLows.push(recent[i].low);
    }
    const supply = [], demand = [];
    for (const h of swingHighs) {
        let found = supply.find(z => Math.abs(z.price - h) / h < 0.001);
        if (found) found.count++;
        else supply.push({ price: h, count: 1 });
    }
    for (const l of swingLows) {
        let found = demand.find(z => Math.abs(z.price - l) / l < 0.001);
        if (found) found.count++;
        else demand.push({ price: l, count: 1 });
    }
    return {
        supply: supply.filter(z => z.count >= 2).map(z => z.price),
        demand: demand.filter(z => z.count >= 2).map(z => z.price)
    };
}

// ---------- MARKET STRUCTURE (BOS/CHoCH) ----------
function detectMarketStructure(candles) {
    if (!candles || candles.length < 30) return { bos: null, choch: null };
    const swingHighs = [], swingLows = [];
    for (let i = 5; i < candles.length - 5; i++) {
        if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
            candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high)
            swingHighs.push(candles[i].high);
        if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
            candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low)
            swingLows.push(candles[i].low);
    }
    if (swingHighs.length < 2 || swingLows.length < 2) return { bos: null, choch: null };
    const lastHigh = swingHighs[swingHighs.length-1], prevHigh = swingHighs[swingHighs.length-2];
    const lastLow = swingLows[swingLows.length-1], prevLow = swingLows[swingLows.length-2];
    let bos = null;
    if (lastHigh > prevHigh) bos = 'BULLISH';
    if (lastLow < prevLow) bos = 'BEARISH';
    const lastCandle = candles[candles.length-1];
    let choch = null;
    if (bos === 'BULLISH' && lastCandle.close > prevHigh) choch = 'BULLISH';
    if (bos === 'BEARISH' && lastCandle.close < prevLow) choch = 'BEARISH';
    return { bos, choch };
}

// ---------- ORDER BLOCK ----------
function detectOrderBlock(candles) {
    if (candles.length < 3) return { direction: null };
    const last = candles[candles.length-1];
    const prev = candles[candles.length-2];
    if (prev.close < prev.open && last.close > last.open && last.close > prev.high)
        return { direction: 'BULLISH', strength: 15, reason: 'Order Block (bullish)' };
    if (prev.close > prev.open && last.close < last.open && last.close < prev.low)
        return { direction: 'BEARISH', strength: 15, reason: 'Order Block (bearish)' };
    return { direction: null };
}

// ---------- FAIR VALUE GAP ----------
function detectFVG(candles) {
    if (candles.length < 3) return { direction: null };
    const c1 = candles[candles.length-3];
    const c2 = candles[candles.length-2];
    const c3 = candles[candles.length-1];
    if (c1.high < c3.low && c2.close > c1.high)
        return { direction: 'BULLISH', strength: 10, reason: 'FVG' };
    if (c3.high < c1.low && c2.close < c1.low)
        return { direction: 'BEARISH', strength: 10, reason: 'FVG' };
    return { direction: null };
}

// ---------- LIQUIDITY SWEEP ----------
function detectLiquiditySweep(candles) {
    if (candles.length < 10) return { direction: null };
    const last = candles[candles.length-1];
    const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
    const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
    if (last.low < recentLow && last.close > recentLow && last.close > last.open)
        return { direction: 'BULLISH', strength: 25, reason: 'Liquidity sweep (bullish)' };
    if (last.high > recentHigh && last.close < recentHigh && last.close < last.open)
        return { direction: 'BEARISH', strength: 25, reason: 'Liquidity sweep (bearish)' };
    return { direction: null };
}

// ---------- BREAK & RETEST ----------
function detectBreakRetest(candles, price, zone, zoneType) {
    if (candles.length < 5) return { direction: null };
    const recent = candles.slice(-5);
    if (zoneType === 'SUPPLY') {
        const broke = recent.some(c => c.close > zone);
        const retest = Math.abs(price - zone) / price < 0.001;
        if (broke && retest) return { direction: 'BULLISH', strength: 15, reason: 'Break & retest' };
    } else if (zoneType === 'DEMAND') {
        const broke = recent.some(c => c.close < zone);
        const retest = Math.abs(price - zone) / price < 0.001;
        if (broke && retest) return { direction: 'BEARISH', strength: 15, reason: 'Break & retest' };
    }
    return { direction: null };
}

// ---------- CANDLESTICK PATTERNS ----------
function detectCandlePattern(candle) {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    if (lowerWick > body * 2 && upperWick < body && candle.close > candle.open)
        return { direction: 'BULLISH', strength: 15, reason: 'Hammer' };
    if (upperWick > body * 2 && lowerWick < body && candle.close < candle.open)
        return { direction: 'BEARISH', strength: 15, reason: 'Shooting star' };
    return { direction: null };
}

// ---------- RISK MANAGER ----------
function calculateTradeLevels(price, atr, zone, zoneType, bias, conf, mode, mult, spread, digits) {
    let entry, sl, tp1, tp2, rr = 0;
    const minRR = mode === 'scalp' ? 2.0 : 4.0;
    const maxRR = mode === 'scalp' ? 4.0 : 12.0;
    const targetRR = Math.min(minRR + (conf / 100) * 3, maxRR);
    const atrMult = mode === 'scalp' ? 0.45 : 1.0;
    if (bias === 'BUY') {
        entry = price;
        let slDist = atr * atrMult;
        sl = entry - slDist;
        if (sl > zone) sl = zone * 0.998;
        const risk = entry - sl;
        tp1 = entry + risk;
        tp2 = entry + risk * targetRR;
        rr = targetRR;
    } else {
        entry = price;
        let slDist = atr * atrMult;
        sl = entry + slDist;
        if (sl < zone) sl = zone * 1.002;
        const risk = sl - entry;
        tp1 = entry - risk;
        tp2 = entry - risk * targetRR;
        rr = targetRR;
    }
    const riskAmount = DEFAULT_BALANCE * (DEFAULT_RISK_PERCENT / 100);
    const stopDist = Math.abs(entry - sl) + spread;
    let lot = riskAmount / (stopDist * mult);
    lot = Math.floor(lot * 1000) / 1000;
    lot = Math.max(0.01, Math.min(lot, 50));
    return {
        entry: entry.toFixed(digits),
        sl: sl.toFixed(digits),
        tp1: tp1.toFixed(digits),
        tp2: tp2.toFixed(digits),
        rrRatio: rr.toFixed(1),
        lotSize: lot.toFixed(2)
    };
}

// ========== MAIN STRATEGY ==========
function analyzeSignal(prices, candles, assetClass) {
    if (prices.length < 50) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Building data'], rsi: 50, trend: 'SIDEWAYS', currentPrice: prices[prices.length-1] };
    }
    const curPrice = prices[prices.length-1];
    const rsi = calcRSI(prices);
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, 50);
    const atr = calcATR(prices, 14);

    let trend = 'SIDEWAYS';
    if (ema20 > ema50 && ema20 > ema20 * 1.001) trend = 'BULLISH';
    if (ema20 < ema50 && ema20 < ema20 * 0.999) trend = 'BEARISH';

    // ---- HTF zones (direction) ----
    const htfZones = findHTFZones(candles);
    const atHTFSupply = isAtHTFZone(curPrice, htfZones.supply, 'SUPPLY');
    const atHTFDemand = isAtHTFZone(curPrice, htfZones.demand, 'DEMAND');

    if (!atHTFSupply.atZone && !atHTFDemand.atZone) {
        return { bias: 'WAIT', confidence: 30, reasons: ['Not at HTF zone'], rsi, trend, currentPrice: curPrice, atr };
    }

    const htfDirection = atHTFSupply.atZone ? 'SELL' : 'BUY';
    const htfZonePrice = atHTFSupply.atZone ? atHTFSupply.zone : atHTFDemand.zone;
    const htfZoneType = atHTFSupply.atZone ? 'SUPPLY' : 'DEMAND';

    // ---- LTF zones (confirmation) ----
    const ltfZones = findLTFZones(candles);
    const atLTFSupply = isAtHTFZone(curPrice, ltfZones.supply, 'SUPPLY'); // reuse same helper
    const atLTFDemand = isAtHTFZone(curPrice, ltfZones.demand, 'DEMAND');
    const ltfConfirm = (atLTFSupply.atZone || atLTFDemand.atZone);

    // ---- Market structure alignment ----
    const ms = detectMarketStructure(candles);
    let structureOk = false;
    if (htfDirection === 'BUY' && (ms.bos === 'BULLISH' || ms.choch === 'BULLISH')) structureOk = true;
    if (htfDirection === 'SELL' && (ms.bos === 'BEARISH' || ms.choch === 'BEARISH')) structureOk = true;
    if (!structureOk) {
        return { bias: 'WAIT', confidence: 35, reasons: ['Structure not aligned'], rsi, trend, currentPrice: curPrice, atr };
    }

    // ---- Score accumulation ----
    let buyScore = 0, sellScore = 0;
    const reasons = [];

    // HTF zone base
    if (htfDirection === 'BUY') buyScore += 30;
    else sellScore += 30;
    reasons.push(`${htfZoneType} zone (HTF)`);

    // LTF zone confirmation
    if (ltfConfirm && htfDirection === 'BUY') { buyScore += 10; reasons.push('LTF demand zone'); }
    if (ltfConfirm && htfDirection === 'SELL') { sellScore += 10; reasons.push('LTF supply zone'); }

    // Order Block
    const ob = detectOrderBlock(candles);
    if (ob.direction === 'BULLISH') { buyScore += ob.strength; reasons.push(ob.reason); }
    if (ob.direction === 'BEARISH') { sellScore += ob.strength; reasons.push(ob.reason); }

    // FVG
    const fvg = detectFVG(candles);
    if (fvg.direction === 'BULLISH') { buyScore += fvg.strength; reasons.push(fvg.reason); }
    if (fvg.direction === 'BEARISH') { sellScore += fvg.strength; reasons.push(fvg.reason); }

    // Liquidity sweep (important)
    const sweep = detectLiquiditySweep(candles);
    if (sweep.direction === 'BULLISH') { buyScore += sweep.strength; reasons.push(sweep.reason); }
    if (sweep.direction === 'BEARISH') { sellScore += sweep.strength; reasons.push(sweep.reason); }

    // Break & retest (using the HTF zone)
    const br = detectBreakRetest(candles, curPrice, htfZonePrice, htfZoneType);
    if (br.direction === 'BULLISH') { buyScore += br.strength; reasons.push(br.reason); }
    if (br.direction === 'BEARISH') { sellScore += br.strength; reasons.push(br.reason); }

    // Candlestick pattern
    const candlePat = detectCandlePattern(candles[candles.length-1]);
    if (candlePat.direction === 'BULLISH') { buyScore += candlePat.strength; reasons.push(candlePat.reason); }
    if (candlePat.direction === 'BEARISH') { sellScore += candlePat.strength; reasons.push(candlePat.reason); }

    // Session bonus
    const session = getCurrentSession();
    const sessionBonus = (session === 'LONDON' || session === 'NEW_YORK') ? 10 : 0;
    buyScore += sessionBonus;
    sellScore += sessionBonus;
    if (sessionBonus) reasons.push(`${session} session`);

    // Overbought/oversold filter
    let finalBias = 'WAIT';
    let confidence = 40;
    const minScore = 50;

    if (htfDirection === 'BUY' && buyScore > minScore && buyScore > sellScore) finalBias = 'BUY';
    else if (htfDirection === 'SELL' && sellScore > minScore && sellScore > buyScore) finalBias = 'SELL';

    if (finalBias === 'BUY' && rsi > 70) finalBias = 'WAIT';
    if (finalBias === 'SELL' && rsi < 30) finalBias = 'WAIT';

    if (finalBias !== 'WAIT') {
        confidence = Math.min(85, 50 + Math.floor((finalBias === 'BUY' ? buyScore : sellScore) / 2));
    }

    // Sideways penalty
    if (trend === 'SIDEWAYS' && finalBias !== 'WAIT') {
        confidence = Math.max(50, confidence - 10);
        reasons.push('Sideways market - reduced confidence');
    }

    const uniqueReasons = [...new Set(reasons)];
    return {
        bias: finalBias,
        confidence,
        reasons: uniqueReasons.slice(0,5),
        rsi,
        trend,
        currentPrice: curPrice,
        atr,
        zone: htfZonePrice,
        zoneType: htfZoneType
    };
}

// ---------- TELEGRAM ALERT (with 30-min cooldown) ----------
async function sendTelegramAlert(symbolDisplay, signal, assetConfig) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    const cacheKey = `${symbolDisplay}_${signal.bias}`;
    const lastAlert = lastAlertCache[cacheKey];
    const now = Date.now();
    if (lastAlert && (now - lastAlert) < 1800000) {
        console.log(`⏸️ Skipping duplicate ${signal.bias} for ${symbolDisplay} (cooldown active)`);
        return false;
    }
    let tradeLevels = null;
    if (signal.bias !== 'WAIT') {
        tradeLevels = calculateTradeLevels(
            signal.currentPrice, signal.atr, signal.zone, signal.zoneType, signal.bias, signal.confidence, DEFAULT_MODE,
            assetConfig.multiplier, assetConfig.spread, assetConfig.digits
        );
    }
    const icon = signal.bias === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const timestamp = new Date().toLocaleString();
    const session = getCurrentSession();
    let msg = `
🤖 OMNI-SIGNAL ALERT 🤖
━━━━━━━━━━━━━━━━━━━
${icon} | ${signal.confidence}% confidence
⏰ ${timestamp} (${session} session)

📊 ${symbolDisplay}
💰 Price: ${signal.currentPrice.toFixed(assetConfig.digits)}
📈 RSI: ${signal.rsi.toFixed(1)} | Trend: ${signal.trend}
📊 ATR: ${signal.atr.toFixed(assetConfig.digits===5?5:2)}
📍 ${signal.zoneType} Zone: ${signal.zone?.toFixed(assetConfig.digits) || 'N/A'}

━━━━━━━━━━━━━━━━━━━
💡 ${signal.reasons.slice(0,4).join(', ') || 'Signal detected'}
`;
    if (tradeLevels) {
        msg += `
━━━━━━━━━━━━━━━━━━━
🎯 TRADE SETUP
📥 Entry: ${tradeLevels.entry}
🛑 Stop Loss: ${tradeLevels.sl}
🎯 TP1: ${tradeLevels.tp1} | TP2: ${tradeLevels.tp2}
📐 Risk/Reward: 1:${tradeLevels.rrRatio}
💰 Lot Size: ${tradeLevels.lotSize}
`;
    }
    msg += `\n⚠️ Mode: ${DEFAULT_MODE} | Risk: ${DEFAULT_RISK_PERCENT}% | Balance: $${DEFAULT_BALANCE}`;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
        });
        const json = await res.json();
        if (json.ok) {
            console.log(`✅ Alert sent for ${symbolDisplay}`);
            lastAlertCache[cacheKey] = now;
            return true;
        }
    } catch(e) { console.error('Telegram error:', e.message); }
    return false;
}

// ---------- CANDLE BUILDER ----------
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
    if (data.candles.length > 200) data.candles.shift();
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
                if (prices.length >= 50) {
                    const signal = analyzeSignal(prices, candles, assetConfig.class);
                    console.log(`📊 ${displayName} - ${signal.bias} (${signal.confidence}%) - ${signal.reasons.slice(0,2).join(', ')}`);
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

// ---------- MAIN ----------
async function main() {
    console.log('--- OMNI-SIGNAL v18.0 (HTF direction + LTF confirmation) ---');
    console.log(`Telegram: ${!!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
    console.log(`Alpha Vantage: ${!!ALPHA_VANTAGE_KEY ? '✅' : '❌'}`);
    console.log(`Mode: ${DEFAULT_MODE} | Balance: $${DEFAULT_BALANCE} | Risk: ${DEFAULT_RISK_PERCENT}%`);

    // Forex for DXY
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
    for (let i=0; i<crypto.length; i++) { await processAsset(crypto[i].file, crypto[i].fetcher, crypto[i].display, crypto[i].config); if (i<crypto.length-1) await new Promise(r => setTimeout(r, 1500)); }
    console.log('⏸️ 1.5s delay...'); await new Promise(r => setTimeout(r, 1500));
    for (let i=0; i<metals.length; i++) { await processAsset(metals[i].file, metals[i].fetcher, metals[i].display, metals[i].config); if (i<metals.length-1) await new Promise(r => setTimeout(r, 1500)); }
    console.log('⏸️ 1.5s delay...'); await new Promise(r => setTimeout(r, 1500));
    for (const a of oil) await processAsset(a.file, a.fetcher, a.display, a.config, true);

    if (dxyPrice) {
        const dxyData = { currentPrice: dxyPrice, timestamp: Date.now(), candles: [] };
        fs.writeFileSync(path.join(dataDir, 'dxy.json'), JSON.stringify(dxyData, null, 2));
    }
    console.log('--- Completed ---');
}

main().catch(err => console.error('Fatal error:', err));
