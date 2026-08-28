// ======================================================
// scannerDecisionPipeline.js
// v4.6 — Decision Integrity Pipeline
// ======================================================

const {
    makeDecision
} = require(
    './decisionEngine'
);


const {
    buildDataFreshness
} = require(
    './dataFreshness'
);


const {
    createCandleId,
    createAnalysisId
} = require(
    './candleIdentity'
);


const {
    appendDecision
} = require(
    './decisionLogger'
);


function buildDecisionRecord({
    symbol,
    analysis,
    marketData,
    newsRisk,
    source
}) {

    const newestClosedCandleTime =
        marketData &&
        marketData.newestClosedCandle
            ?
            marketData.newestClosedCandle
            :
            null;


    const freshness =
        buildDataFreshness({

            source:
                source ||
                (
                    marketData &&
                    marketData.source
                ) ||
                'UNKNOWN',

            newestClosedCandleTime:
                newestClosedCandleTime,

            livePriceUpdatedAt:
                marketData &&
                marketData.livePriceUpdatedAt
                    ?
                    marketData.livePriceUpdatedAt
                    :
                    null,

            historyUpdatedAt:
                marketData &&
                marketData.historyUpdatedAt
                    ?
                    marketData.historyUpdatedAt
                    :
                    null
        });


    const finalDecision =
        makeDecision({
            symbol,
            analysis,
            dataFreshness:
                freshness,
            newsRisk
        });


    const candleId =
        createCandleId(
            symbol,
            newestClosedCandleTime
        );


    const analysisId =
        createAnalysisId({
            symbol,
            candleId,
            decision:
                finalDecision.decision
        });


    const diagnostics =
        analysis &&
        analysis.signalDiagnostics
            ?
            analysis.signalDiagnostics
            :
            {};


    const entryZone =
        analysis &&
        analysis.entryZone
            ?
            analysis.entryZone
            :
            {};


    const entryEngine =
        analysis &&
        (
            analysis.entryEngine ||
            analysis.entryTiming
        )
            ?
            (
                analysis.entryEngine ||
                analysis.entryTiming
            )
            :
            {};


    const expiration =
        analysis &&
        analysis.expiration
            ?
            analysis.expiration
            :
            {};


    const record = {

        ...finalDecision,

        analysisId:
            analysisId,

        candleId:
            candleId,

        symbol:
            symbol,

        signal:
            analysis
                ?
                analysis.signal
                :
                null,

        score:
            analysis
                ?
                analysis.score
                :
                null,

        edge:
            diagnostics.actualEdge ??
            null,

        entryStatus:
            entryEngine.status ||
            null,

        entryQuality:
            entryZone.currentEntryQuality ||
            null,

        signalStrength:
            analysis &&
            analysis.signalStrength
                ?
                analysis.signalStrength.level
                :
                null,

        expirationMinutes:
            expiration.recommendedMinutes ??
            null,

        dataFreshness:
            freshness,

        source:
            source ||
            null
    };


    appendDecision(
        record
    );


    return record;
}


module.exports = {
    buildDecisionRecord
};
