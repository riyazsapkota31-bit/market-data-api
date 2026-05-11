# OMNI—SIGNAL | XM Edition

**Auto trading signals sent to Telegram – no manual work required.**

---

## What It Does

- Fetches live prices for **14 assets** (Forex, Crypto, Gold, Silver, Oil)
- Analyzes every 5 minutes using RSI, EMA, Support/Resistance
- Sends **BUY/SELL alerts to Telegram** with Entry, SL, TP, Lot Size
- Runs 24/7 via GitHub Actions (free)

---

## Assets Monitored

| Type | Assets |
|------|--------|
| Forex | EUR/USD, GBP/USD, USD/JPY, USD/CAD, USD/CHF, USD/SEK |
| Crypto | BTC/USD, ETH/USD, SOL/USD, XRP/USD |
| Metals | Gold (XAU), Silver (XAG) |
| Energy | WTI Oil |
| Index | DXY (calculated) |

---

## How to Set Up (5 minutes)

### 1. Create Telegram Bot
- Message **@BotFather** → `/newbot` → save **token**
- Message **@userinfobot** → `/start` → save **chat ID**

### 2. Add GitHub Secrets
Go to `market-data-api` repo → Settings → Secrets → Add:

| Secret | Value |
|--------|-------|
| `TELEGRAM_BOT_TOKEN` | Your bot token |
| `TELEGRAM_CHAT_ID` | Your chat ID |
| `ALPHA_VANTAGE_KEY` | Get free from alphavantage.co |

### 3. Set Up Cron Job
- Sign up at [cron-job.org](https://cron-job.org)
- Create job with:
  - URL: `https://api.github.com/repos/riyazsapkota31-bit/market-data-api/dispatches`
  - Interval: **Every 3 minutes**
  - Payload: `{"event_type": "cron-job"}`

### 4. Done!
Wait for Telegram alerts. **No website needed.**

---

## What a Telegram Alert Looks Like

```

🤖 OMNI-SIGNAL ALERT 🤖
🟢 BUY | 72% confidence
📊 XAUUSD (Gold)
💰 Price: 4724.10
🎯 Entry: 4724.10
🛑 SL: 4718.50
🎯 TP1: 4730.60 | TP2: 4740.00
💰 Lot: 0.85
📐 R/R: 1:2.1

```

---

## Website (Optional)

Open `https://riyazsapkota31-bit.github.io/omi-ni-supreme/` to:
- Manually analyze any asset
- View open trades
- Track win rate

---

## Strategy (Conservative)

| Condition | Requirement |
|-----------|-------------|
| Minimum signals | 2+ strategies must agree |
| Score threshold | >100 points |
| Market filter | Not choppy (EMAs separated) |
| DXY filter | Confirms inverse correlation |

**No fake signals. Trades only when conditions are right.**

---

## Need Help?

Check GitHub Actions logs:
- `market-data-api` repo → Actions tab → latest run

---

**Made for XM.com | Free | No monthly fees**
