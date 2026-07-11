# TradePulse

Minimal black-and-white app to pull **free historical stock data** and **backtest indicator strategies** — including ATM options simulation and F&O universe scans.

## Features

- **Data sources**
  - **Yahoo Finance** (default, no API key) — NSE symbols like `RELIANCE.NS`
  - **Upstox** Historical Candle V3 (free API + access token; symbol resolved to instrument key)
- **Strategy builder** — entry/exit conditions with AND/OR logic
- **Indicators** — EMA, SMA, RSI, Opening Range, Fib pivots, Prev Day High/Low
- **Trade modes** — equity or ATM options (signals on equity, execute options)
- **F&O scan** — run strategy across equity F&O names; single report with trade subtables
- **Results** — metrics, equity curve, trade list, CSV export

## Quick start

```bash
cd TradePulse
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Optional Upstox

```bash
cp .env.example .env.local
# set UPSTOX_ACCESS_TOKEN=...
```

## Stack

Next.js · TypeScript · Tailwind · Recharts
