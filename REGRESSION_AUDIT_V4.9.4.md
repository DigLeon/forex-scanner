# Regression Audit v4.9.4

- Base: v4.9.3 audited release.
- Added sessionPrefilter.js and SESSION_PREFILTER config only around pair selection.
- Main full-analysis trading logic was not edited.
- Existing hard Candle Confirmation / Entry Engine gates remain present.
- Existing fully-closed 3M confirmation guard remains present.
- Existing currentTradeResult Telegram ordering and TRADE decision metadata remain present.
- Prefilter aggregates only fully closed higher-timeframe buckets.
- Syntax check: `node scripts/check.js` passes for 25 server JavaScript files and GUI script.
- Cold-request budget: Top-8 prefilter uses same 1M/1500 cache key as full scan; at most 3 additional history requests versus Top-5.


## RC2 live-test adjustment
- Prefilter min score: 28.
- Target full-scan count: 5 when at least five candidates were successfully scored.
- Below-threshold pairs may only backfill empty target slots; they do not become trading signals.
- Trading thresholds/gates unchanged.
