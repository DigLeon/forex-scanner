# Forex Scanner

Modular paper-analysis scanner using Twelve Data REST by default, optional realtime WebSocket support, SMC/MTF analysis, news filtering, signal logging, expiration analysis, and optional visual chart review.

## Setup

1. Copy `.env.example` to `.env`.
2. Add your Twelve Data API key as `TWELVE_DATA_API_KEY=...`.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Important defaults

- Twelve Data WebSocket is disabled by default: `ENABLE_TWELVE_WS=false`.
- REST history refresh is controlled by `TWELVE_REST_REFRESH_MS` and cached to reduce duplicate API use.
- `.env`, `node_modules/`, logs, and `signal-history.json` are ignored by Git.
- Visual review is disabled unless `OPENAI_API_KEY` is configured.
- Visual requests time out after `OPENAI_VISION_TIMEOUT_MS` (default 45000 ms).

## Scanner decisions

The scanner now separates market direction from execution status:

- `TRADE` — actionable and included in Active Signals.
- `WAIT` — setup exists but entry/strength is not ready.
- `SKIP` — no valid setup, news block, too-late entry, or hard entry restriction.
- `ERROR` — pair analysis failed.

`/api/scan` returns `results` (TRADE only), `decisions` (all pair outcomes), and `scanStats`.

## GitHub

Do not commit `.env` or API keys. Keep provider-specific data access isolated so Twelve Data can later be replaced without rewriting the analysis engine.

## v4.4 GUI Optimization

- Main table now contains TRADE opportunities only.
- WAIT / SKIP / ERROR decisions are shown separately in Scan Decisions.
- Added TRADE / WAIT / SKIP / ERROR summary counters.
- Simplified the main trade table to Direction, Confidence, Best Entry, Do Not Chase, Entry, Expiration, Age and Details.
- Removed dead frontend polling to a non-existent `/api/latest-signals` route in REST mode.
- Improved narrow-screen/mobile layout with compact decision cards and horizontal trade-table scrolling.
- Detailed SMC / MTF / strength / strategy information remains available under DETAILS.


## v4.5 Final Audit

- REST candles are sorted newest-first before open/closed-candle separation, so analysis no longer depends on provider response ordering.
- `/api/candles` now uses the shared market-data cache/retry/coalescing layer instead of bypassing it.
- Scanner and market-data helpers fail fast with a clear 503-style configuration error when the Twelve Data key is missing.
- Paper logger no longer creates overlapping PENDING trades for the same pair and direction.
- Signal history now receives UP/DOWN scores, MTF context, primary strategy, pair session, and market regime from the scan.
- API middleware errors (including visual-upload errors) are returned as JSON for reliable GUI handling.
- `npm run check` now validates both server JavaScript and the inline GUI JavaScript.

Before GitHub or a local run, use:

```bash
npm install
npm run check
npm start
```

The included `package-lock.json` is a legacy lockfile and current npm may print a one-time metadata-update warning during install.

## v4.6.2 audit note

The current production runtime remains the tested `server.js` decision flow.
The newer `decisionEngine.js`, `scannerDecisionPipeline.js`, `dataProvider.js`,
`dataFreshness.js`, `candleIdentity.js`, `decisionLogger.js`, and
`v46Integration.js` are present as the next modular architecture, but they are
**not yet wired into `server.js`**. Integrate them only after regression tests
confirm that TRADE / WAIT / SKIP behavior matches the current working scanner.

Release hygiene: generated signal history and JSONL decision logs are ignored;
`public/index.html` is the single GUI entry point; the obsolete browser copy of
server-side `realtimeMarketData.js` was removed.
