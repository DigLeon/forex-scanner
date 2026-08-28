FOREX SCANNER v4.6 — Decision Integrity & Statistics

IMPORTANT
=========
The archive you supplied with the request contains an older monolithic server.js
with WebSocket code still inside it. Your written v4.5 description says that the
current project already has realtimeMarketData.js, REST-only ~60 sec refresh and
TRADE/WAIT/SKIP/ERROR separation.

Because replacing that newer server.js with the older archived one would regress
your project, this v4.6 package is intentionally modular. Add these files to the
actual v4.5 project and integrate them at the final scanner-decision stage.

NEW FILES
=========
decisionEngine.js
dataFreshness.js
candleIdentity.js
decisionLogger.js
dataProvider.js
scannerDecisionPipeline.js
v46Integration.js

WHAT v4.6 ADDS
==============

1. ONE FINAL DECISION GATE
   makeDecision() is the only place allowed to produce TRADE.

2. REASON CODES
   Examples:
   SKIP_TOO_LATE
   SKIP_WORST_ENTRY
   SKIP_NOT_RECOMMENDED
   WAIT_RETEST
   WAIT_CANDLE
   WAIT_CONFIRMATION
   SKIP_DATA_STALE

3. UNIFIED DATA FRESHNESS
   newestClosedCandleTime
   livePriceUpdatedAt
   historyUpdatedAt
   source
   stale
   problems

4. CANDLE ID + ANALYSIS ID
   Candle ID:
   EUR/USD|2026-08-27T11:42:00.000Z

5. DEDUPE
   CandleAnalysisDeduper prevents repeated processing of the same closed candle.

6. ALL DECISIONS LOGGER
   Logs TRADE / WAIT / SKIP / ERROR to:
   data/scan-decisions.jsonl

7. PROVIDER ABSTRACTION
   Scanner can call:
   dataProvider.getCandles()
   dataProvider.getPrice()
   dataProvider.getStatus()

8. VISUAL REVIEW SAFETY
   Keep Visual/OpenCV review AFTER numerical decision.
   Never let visual analysis override:
   TOO LATE
   WORST ENTRY
   DO NOT ENTER
   NOT RECOMMENDED


SERVER.JS INTEGRATION
=====================

At imports:

const {
    buildDecisionRecord
} = require('./scannerDecisionPipeline');

const {
    dataProvider,
    candleDeduper,
    getDecisionStats
} = require('./v46Integration');


After combinedAnalysis():

const decisionRecord =
    buildDecisionRecord({
        symbol,
        analysis,
        marketData: {
            newestClosedCandle:
                candleData.newestClosedCandle,

            livePriceUpdatedAt:
                candleData.livePriceUpdatedAt || null,

            historyUpdatedAt:
                data._marketData &&
                data._marketData.fetchedAt
                    ? data._marketData.fetchedAt
                    : new Date().toISOString(),

            source:
                data._marketData &&
                data._marketData.source
                    ? data._marketData.source
                    : 'REST'
        },
        newsRisk,
        source: 'REST'
    });


CANDLE DEDUPE
=============

Before combinedAnalysis():

const candleId =
    `${symbol}|${candleData.newestClosedCandle}`;

if (
    !candleDeduper.shouldProcess(
        candleId
    )
) {
    // For automatic scanner runs:
    // do not re-run analysis for the same closed candle.
    continue;
}


ACTIVE SIGNALS vs SCAN DECISIONS
================================

const scanDecisions = [];
const activeSignals = [];

scanDecisions.push({
    ...resultForGui,
    decision:
        decisionRecord.decision,
    reasonCode:
        decisionRecord.reasonCode,
    decisionReason:
        decisionRecord.reason,
    candleId:
        decisionRecord.candleId,
    analysisId:
        decisionRecord.analysisId,
    dataFreshness:
        decisionRecord.dataFreshness
});

if (
    decisionRecord.decision ===
    'TRADE'
) {
    activeSignals.push(
        scanDecisions[
            scanDecisions.length - 1
        ]
    );
}


API RESPONSE
============

res.json({
    status: 'ok',
    activeSignals,
    scanDecisions,
    results: activeSignals
});

Keeping "results: activeSignals" preserves old GUI compatibility.


STATISTICS ENDPOINT
===================

app.get(
    '/api/decision-stats',
    (req, res) => {
        res.json({
            status: 'ok',
            stats: getDecisionStats()
        });
    }
);


IMPORTANT HARD RULE
===================
Do not add any code after makeDecision() that changes SKIP/WAIT back into TRADE.
Visual Review may add:
visualAlignment: AGREES / MIXED / DISAGREES
but it must not overwrite decisionRecord.decision.


EXPECTED BEHAVIOR
=================

TOO LATE
-> SKIP / SKIP_TOO_LATE

WORST ENTRY / DO NOT ENTER
-> SKIP / SKIP_WORST_ENTRY

NOT RECOMMENDED
-> SKIP / SKIP_NOT_RECOMMENDED

WAIT FOR RETEST
-> WAIT / WAIT_RETEST

WAIT FOR CANDLE
-> WAIT / WAIT_CANDLE

ENTER NOW + all hard checks pass
-> TRADE / TRADE_CONFIRMED
