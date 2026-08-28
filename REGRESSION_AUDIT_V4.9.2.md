# Forex Scanner v4.9.2 — Regression Audit

Date: 2026-08-27

## Scope

This release intentionally fixes the three technical issues identified in the v4.9.1 audit without changing SMC/MTF scoring thresholds or entry-zone mathematics.

## Fix 1 — Candle Confirmation is now a hard server-side gate

`server.js` now reads both `analysis.candleConfirmation` and `analysis.entryEngine` before the final execution decision.

A result can reach `TRADE` only when:

- closed-candle confirmation is explicitly `confirmed === true`;
- Entry Engine status is exactly `ENTER NOW`;
- no TOO LATE / WORST ENTRY / DO NOT ENTER / NOT RECOMMENDED / MTF CONFLICT hard block is present.

Therefore a high Score cannot bypass missing candle confirmation.

## Fix 2 — Telegram sends the current TRADE and uses a stable unique key

The old pre-`results.push()` Telegram call was removed.

The current TRADE result is now fully constructed first and includes:

- `decision: 'TRADE'`;
- `candleId` based on the newest closed signal candle;
- `analysisId` based on symbol + direction + signal candle + score.

Only after the result is constructed is `sendTradeAlert(currentTradeResult)` called.

This also makes duplicate protection meaningful across repeated scans of the same signal candle while allowing later signals on later candles.

WAIT / SKIP do not reach the Telegram call.

## Fix 3 — 3M Candle Confirmation uses only fully closed 3M buckets

A new `fullyClosedAggregates()` guard validates aggregated 3M candles against the close time of the newest closed 1M candle.

Example regression case:

- closed 1M candles at 12:48 and 12:49 only -> 12:48–12:51 3M bucket is excluded;
- once 12:50 1M is also closed -> that 3M bucket becomes eligible.

This prevents a partial 3M aggregate from carrying the 60% 3M confirmation weight.

## Regression checks performed

- `npm run check`
  - PASS: 24 server JavaScript files
  - PASS: inline GUI JavaScript
- Partial 3M bucket unit regression
  - PASS
- Fully closed 3M bucket unit regression
  - PASS
- Server hard-gate static regression
  - PASS
- Telegram current-result regression
  - PASS
- Broken local `require()` audit
  - PASS
- Duplicate literal API route audit
  - PASS (15 routes checked)
- `.env` absent from release
  - PASS
- `signal-history.json` absent from release
  - PASS
- `node_modules` removed from release
  - PASS

## Trading logic intentionally unchanged

No changes were made to:

- normal pair safety Score thresholds;
- userMinScore behavior;
- SMC calculations;
- MTF weighting;
- Entry Zone price mathematics;
- TOO LATE boundaries;
- expiration model.

## Non-critical cleanup notes

The source still contains legacy/reference copies such as root `index.html` and `public/realtimeMarketData.js`. They were not touched in this release because the requested scope was the three v4.9.1 technical fixes. They should be removed in a later repository-cleanup commit after confirming they are not used by any local workflow.

## Result

No regression blocker was found after the three fixes.

Recommended release name: **v4.9.2 Regression Audited**.

The next meaningful validation should be a live scan that produces at least one WAIT FOR CANDLE and, when market conditions permit, one real TRADE to verify the Telegram delivery path end-to-end with the user's configured bot/chat IDs.
