# Market Data API – Binance + Finnhub

Fetches real-time prices from Binance (crypto, forex, gold, silver, oil) and DXY from Finnhub. No keys for Binance; Finnhub key required.

## Setup

1. Create a new public repository.
2. Add `fetch-prices.js` and `.github/workflows/fetch.yml`.
3. Add secret `FINNHUB_API_KEY` with your Finnhub key.
4. Enable GitHub Pages (Settings → Pages → branch `main` /root).

Data will be available at:  
`https://<username>.github.io/market-data-api/data/xauusd.json`
