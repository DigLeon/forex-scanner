# Forex Scanner v4.9.3 — Merge / Regression Audit

Base: v4.9.2 Regression Audited.

Integrated from collaborator build:
- Dynamic Montreal-session currency ranking with Top-5 pair selection.
- Expanded 17-pair supported pool in `config.js`.
- `config.js -> PAIRS` as the single supported-pair source.
- Startup validation for malformed or duplicate pair symbols.
- GUI version label updated to v4.9.3.

Explicitly preserved from v4.9.2:
- Hard server-side Candle Confirmation gate.
- Fully closed 3-minute aggregate filtering.
- Entry Engine `ENTER NOW` hard requirement and MTF/TOO LATE blockers.
- Telegram alert is sent only after the current TRADE result is built.
- TRADE `decision`, `candleId`, and `analysisId` fields for Telegram deduplication.
- Normal effective score thresholds and existing SMC/MTF/expiration logic.

Excluded from collaborator archive:
- `node_modules/`
- `signal-history.json`
- collaborator regressions that reverted the v4.9.2 protections above.
