# TradePulse

Minimal black-and-white app to pull **free historical stock data** and **backtest indicator strategies** — including ATM options simulation and F&O universe scans.

**Live:** [https://tradepulse-nu.vercel.app](https://tradepulse-nu.vercel.app)

## Features

- **Data sources** (broker APIs — token required)
  - **Upstox** Historical Candle V3
  - **Dhan** DhanHQ historical (intraday + daily)
  - **Zerodha Kite** Connect historical
- **Strategy builder** — entry/exit conditions with AND/OR logic
- **Indicators** — EMA, SMA, RSI, Opening Range, Fib pivots, Prev Day High/Low
- **Trade modes** — equity or ATM options (signals on equity, execute options)
- **F&O scan** — run strategy across equity F&O names; single report with trade subtables
- **Results** — metrics, charts (15‑min P&L + hold-time P&L), trade list, CSV export

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

In production, paste the Upstox token in the UI (or set `UPSTOX_ACCESS_TOKEN` in the Vercel project env).

### Optional Firebase (auth + strategy cloud sync)

See **[docs/FIREBASE.md](docs/FIREBASE.md)**. Copy web config into `.env.local` / Vercel env as `NEXT_PUBLIC_FIREBASE_*`. Without it, strategies stay in browser localStorage.

## Hosting (Vercel)

Production is deployed at **https://tradepulse-nu.vercel.app** (project `tradepulse`, team `alpha-traders-club`). GitHub repo is connected, so pushes to `main` redeploy automatically.

```bash
npx vercel --prod --yes   # manual production deploy
```

Notes:

- Local `.data-cache` is ephemeral on Vercel (rebuilt per instance).
- Large F&O scans may hit serverless timeouts on Hobby; use a smaller symbol count or upgrade the plan.

## Stack

Next.js · TypeScript · Tailwind · Recharts · Vercel
