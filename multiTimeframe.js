const {
    clamp,
    round,
    toChronological,
    aggregateCandles
} = require('./utils');

const {
    analyzeSMC
} = require('./smc');


// ======================================================
// SCORE ONE TIMEFRAME
// ======================================================

function scoreTimeframe(
    smc,
    weight
) {
    let bullish = 0;
    let bearish = 0;

    const reasons = [];

    if (!smc) {
        return {
            bullish: 0,
            bearish: 0,
            reasons: []
        };
    }


    // ==================================================
    // STRUCTURE
    // ==================================================

    if (
        smc.structure &&
        smc.structure.trend ===
        'BULLISH'
    ) {
        bullish +=
            weight * 0.30;

        reasons.push(
            'Bullish structure'
        );
    }


    if (
        smc.structure &&
        smc.structure.trend ===
        'BEARISH'
    ) {
        bearish +=
            weight * 0.30;

        reasons.push(
            'Bearish structure'
        );
    }


    // ==================================================
    // BOS
    // ==================================================

    if (
        smc.structure &&
        smc.structure.bosDirection ===
        'UP'
    ) {
        bullish +=
            weight * 0.18;

        reasons.push(
            'BOS UP'
        );
    }


    if (
        smc.structure &&
        smc.structure.bosDirection ===
        'DOWN'
    ) {
        bearish +=
            weight * 0.18;

        reasons.push(
            'BOS DOWN'
        );
    }


    // ==================================================
    // CHOCH
    // ==================================================

    if (
        smc.structure &&
        smc.structure.chochDirection ===
        'UP'
    ) {
        bullish +=
            weight * 0.15;

        reasons.push(
            'CHoCH UP'
        );
    }


    if (
        smc.structure &&
        smc.structure.chochDirection ===
        'DOWN'
    ) {
        bearish +=
            weight * 0.15;

        reasons.push(
            'CHoCH DOWN'
        );
    }


    // ==================================================
    // LIQUIDITY
    // ==================================================

    if (
        smc.liquiditySweep &&
        smc.liquiditySweep.bullishSweep
    ) {
        bullish +=
            weight * 0.12;

        reasons.push(
            'Bullish liquidity sweep'
        );
    }


    if (
        smc.liquiditySweep &&
        smc.liquiditySweep.bearishSweep
    ) {
        bearish +=
            weight * 0.12;

        reasons.push(
            'Bearish liquidity sweep'
        );
    }


    // ==================================================
    // DISPLACEMENT
    // ==================================================

    if (
        smc.displacement &&
        smc.displacement.bullish
    ) {
        bullish +=
            weight * 0.10;

        reasons.push(
            'Bullish displacement'
        );
    }


    if (
        smc.displacement &&
        smc.displacement.bearish
    ) {
        bearish +=
            weight * 0.10;

        reasons.push(
            'Bearish displacement'
        );
    }


    // ==================================================
    // ORDER BLOCK
    // ==================================================

    if (
        smc.orderBlock &&
        smc.orderBlock.bullish
    ) {
        bullish +=
            weight * 0.08;

        reasons.push(
            'Bullish order block'
        );
    }


    if (
        smc.orderBlock &&
        smc.orderBlock.bearish
    ) {
        bearish +=
            weight * 0.08;

        reasons.push(
            'Bearish order block'
        );
    }


    // ==================================================
    // IMBALANCE
    // ==================================================

    if (
        smc.imbalances
    ) {
        if (
            Array.isArray(
                smc.imbalances
                .activeBullish
            ) &&
            smc.imbalances
            .activeBullish
            .length > 0
        ) {
            bullish +=
                weight * 0.07;

            reasons.push(
                'Active bullish imbalance'
            );
        }


        if (
            Array.isArray(
                smc.imbalances
                .activeBearish
            ) &&
            smc.imbalances
            .activeBearish
            .length > 0
        ) {
            bearish +=
                weight * 0.07;

            reasons.push(
                'Active bearish imbalance'
            );
        }


        if (
            smc.imbalances
            .currentInsideBullish
        ) {
            bullish +=
                weight * 0.10;

            reasons.push(
                'Price inside bullish imbalance'
            );
        }


        if (
            smc.imbalances
            .currentInsideBearish
        ) {
            bearish +=
                weight * 0.10;

            reasons.push(
                'Price inside bearish imbalance'
            );
        }
    }


    return {
        bullish,
        bearish,
        reasons
    };
}


// ======================================================
// LAYER CONFIDENCE
//
// Measures how clearly one direction dominates
// inside a layer.
// This is NOT win probability.
// ======================================================

function calculateLayerConfidence(
    bullish,
    bearish
) {
    const bull =
        Number(
            bullish
        ) || 0;

    const bear =
        Number(
            bearish
        ) || 0;


    const total =
        bull +
        bear;


    if (
        total <= 0
    ) {
        return 0;
    }


    return clamp(
        Math.round(
            (
                Math.abs(
                    bull -
                    bear
                ) /
                total
            ) *
            100
        ),
        0,
        100
    );
}


// ======================================================
// MULTI TIMEFRAME ENGINE
//
// CONTEXT:
// 1H + 30M
//
// SETUP:
// 15M + 5M
//
// ENTRY:
// 3M + 1M
// ======================================================

function analyzeMultiTimeframe(
    symbol,
    oneMinuteCandles
) {
    if (!oneMinuteCandles ||
        oneMinuteCandles.length < 120
    ) {
        return {
            symbol,

            signal: 'NO SIGNAL',

            direction: 'NEUTRAL',

            score: 0,

            bullishScore: 0,

            bearishScore: 0,

            alignmentScore: 0,

            entryStatus: 'WAIT',

            entryMessage: 'Not enough candles',

            layers: {

                context: {
                    direction: 'NEUTRAL',

                    confidence: 0,

                    edge: 0,

                    bullishScore: 0,

                    bearishScore: 0
                },


                setup: {
                    direction: 'NEUTRAL',

                    confidence: 0,

                    edge: 0,

                    bullishScore: 0,

                    bearishScore: 0
                },


                entry: {
                    direction: 'NEUTRAL',

                    confidence: 0,

                    edge: 0,

                    bullishScore: 0,

                    bearishScore: 0,

                    ready: false
                }
            }
        };
    }


    // ==================================================
    // BUILD TIMEFRAMES
    // ==================================================

    const candles1m =
        toChronological(
            oneMinuteCandles
        );


    const candles3m =
        aggregateCandles(
            oneMinuteCandles,
            3
        );


    const candles5m =
        aggregateCandles(
            oneMinuteCandles,
            5
        );


    const candles15m =
        aggregateCandles(
            oneMinuteCandles,
            15
        );


    const candles30m =
        aggregateCandles(
            oneMinuteCandles,
            30
        );


    const candles1h =
        aggregateCandles(
            oneMinuteCandles,
            60
        );


    // ==================================================
    // SMC EACH TIMEFRAME
    // ==================================================

    const smc1m =
        analyzeSMC(
            candles1m,
            { symbol, timeframe: '1M' }
        );


    const smc3m =
        analyzeSMC(
            candles3m,
            { symbol, timeframe: '3M' }
        );


    const smc5m =
        analyzeSMC(
            candles5m,
            { symbol, timeframe: '5M' }
        );


    const smc15m =
        analyzeSMC(
            candles15m,
            { symbol, timeframe: '15M' }
        );


    const smc30m =
        analyzeSMC(
            candles30m,
            { symbol, timeframe: '30M' }
        );


    const smc1h =
        analyzeSMC(
            candles1h,
            { symbol, timeframe: '1H' }
        );


    // ==================================================
    // WEIGHTS
    //
    // Пока оставляем как было.
    // Не меняем одновременно слишком много параметров.
    // ==================================================

    const score1h =
        scoreTimeframe(
            smc1h,
            20
        );


    const score30m =
        scoreTimeframe(
            smc30m,
            20
        );


    const score15m =
        scoreTimeframe(
            smc15m,
            20
        );


    const score5m =
        scoreTimeframe(
            smc5m,
            20
        );


    const score3m =
        scoreTimeframe(
            smc3m,
            10
        );


    const score1m =
        scoreTimeframe(
            smc1m,
            10
        );


    // ==================================================
    // CONTEXT
    // 1H + 30M
    // ==================================================

    const contextBullish =
        score1h.bullish +
        score30m.bullish;


    const contextBearish =
        score1h.bearish +
        score30m.bearish;


    const contextEdge =
        Math.abs(
            contextBullish -
            contextBearish
        );


    let contextDirection =
        'NEUTRAL';


    // Minimum directional strength + edge.
    // Less restrictive than old "+3" rule,
    // but weak noise still remains NEUTRAL.

    if (
        contextBullish >= 5 &&
        contextBullish >
        contextBearish &&
        contextEdge >= 2
    ) {
        contextDirection =
            'BULLISH';
    }


    if (
        contextBearish >= 5 &&
        contextBearish >
        contextBullish &&
        contextEdge >= 2
    ) {
        contextDirection =
            'BEARISH';
    }


    // ==================================================
    // SETUP
    // 15M + 5M
    // ==================================================

    const setupBullish =
        score15m.bullish +
        score5m.bullish;


    const setupBearish =
        score15m.bearish +
        score5m.bearish;


    const setupEdge =
        Math.abs(
            setupBullish -
            setupBearish
        );


    let setupDirection =
        'NEUTRAL';


    if (
        setupBullish >= 4 &&
        setupBullish >
        setupBearish &&
        setupEdge >= 2
    ) {
        setupDirection =
            'BULLISH';
    }


    if (
        setupBearish >= 4 &&
        setupBearish >
        setupBullish &&
        setupEdge >= 2
    ) {
        setupDirection =
            'BEARISH';
    }


    // ==================================================
    // ENTRY
    // 3M + 1M
    // ==================================================

    const entryBullish =
        score3m.bullish +
        score1m.bullish;


    const entryBearish =
        score3m.bearish +
        score1m.bearish;


    const entryEdge =
        Math.abs(
            entryBullish -
            entryBearish
        );


    let entryDirection =
        'NEUTRAL';


    // Entry is intentionally more sensitive.
    // It controls timing, not the existence of Signal.

    if (
        entryBullish >= 2.5 &&
        entryBullish >
        entryBearish &&
        entryEdge >= 1.2
    ) {
        entryDirection =
            'BULLISH';
    }


    if (
        entryBearish >= 2.5 &&
        entryBearish >
        entryBullish &&
        entryEdge >= 1.2
    ) {
        entryDirection =
            'BEARISH';
    }


    // ==================================================
    // LAYER CONFIDENCE
    // ==================================================

    const contextConfidence =
        calculateLayerConfidence(
            contextBullish,
            contextBearish
        );


    const setupConfidence =
        calculateLayerConfidence(
            setupBullish,
            setupBearish
        );


    const entryConfidence =
        calculateLayerConfidence(
            entryBullish,
            entryBearish
        );


    // ==================================================
    // GLOBAL SCORE
    // ==================================================

    let bullishScore =
        contextBullish +
        setupBullish +
        entryBullish;


    let bearishScore =
        contextBearish +
        setupBearish +
        entryBearish;


    let alignmentScore =
        50;


    const bullishLayers = [
            contextDirection,
            setupDirection,
            entryDirection
        ]
        .filter(
            direction =>
            direction ===
            'BULLISH'
        )
        .length;


    const bearishLayers = [
            contextDirection,
            setupDirection,
            entryDirection
        ]
        .filter(
            direction =>
            direction ===
            'BEARISH'
        )
        .length;


    // ==================================================
    // ALIGNMENT BONUS
    // ==================================================

    if (
        bullishLayers === 3
    ) {
        bullishScore +=
            15;

        alignmentScore =
            100;
    } else if (
        bullishLayers === 2
    ) {
        bullishScore +=
            8;

        alignmentScore =
            80;
    }


    if (
        bearishLayers === 3
    ) {
        bearishScore +=
            15;

        alignmentScore =
            100;
    } else if (
        bearishLayers === 2
    ) {
        bearishScore +=
            8;

        alignmentScore =
            80;
    }


    // ==================================================
    // CONTEXT VS SETUP CONFLICT
    //
    // Still serious.
    // Context vs Setup disagreement should reduce quality.
    // ==================================================

    if (
        contextDirection !==
        'NEUTRAL' &&
        setupDirection !==
        'NEUTRAL' &&
        contextDirection !==
        setupDirection
    ) {
        bullishScore -=
            8;

        bearishScore -=
            8;

        alignmentScore =
            Math.min(
                alignmentScore,
                45
            );
    }


    // ==================================================
    // ENTRY CONFLICT
    //
    // IMPORTANT CHANGE:
    //
    // Old penalty = 10
    // New penalty = 3
    //
    // Entry should affect timing more than it affects
    // the existence of the market setup.
    // ==================================================

    let entryReady =
        true;


    if (
        setupDirection ===
        'BULLISH' &&
        entryDirection ===
        'BEARISH'
    ) {
        entryReady =
            false;


        bullishScore -=
            3;


        alignmentScore =
            Math.min(
                alignmentScore,
                55
            );
    }


    if (
        setupDirection ===
        'BEARISH' &&
        entryDirection ===
        'BULLISH'
    ) {
        entryReady =
            false;


        bearishScore -=
            3;


        alignmentScore =
            Math.min(
                alignmentScore,
                55
            );
    }


    // ==================================================
    // FINAL NORMALIZATION
    // ==================================================

    bullishScore =
        clamp(
            Math.round(
                bullishScore
            ),
            0,
            100
        );


    bearishScore =
        clamp(
            Math.round(
                bearishScore
            ),
            0,
            100
        );


    // ==================================================
    // INTERNAL MTF DIRECTION
    //
    // This is still independent from analysisEngine.js
    // final signal decision.
    // ==================================================

    let signal =
        'NO SIGNAL';


    let direction =
        'NEUTRAL';


    if (
        bullishScore >= 60 &&
        bullishScore >
        bearishScore + 8
    ) {
        direction =
            'BULLISH';


        signal =
            bullishScore >= 85 ?
            'STRONG UP' :
            'UP';
    }


    if (
        bearishScore >= 60 &&
        bearishScore >
        bullishScore + 8
    ) {
        direction =
            'BEARISH';


        signal =
            bearishScore >= 85 ?
            'STRONG DOWN' :
            'DOWN';
    }


    // ==================================================
    // ENTRY READY
    // ==================================================

    let entryStatus =
        'WAIT';


    let entryMessage =
        'Waiting for 1M / 3M confirmation';


    if (
        direction ===
        'BULLISH' &&
        entryDirection ===
        'BULLISH' &&
        entryReady
    ) {
        entryStatus =
            'READY';


        entryMessage =
            '1M / 3M confirm bullish entry';
    }


    if (
        direction ===
        'BEARISH' &&
        entryDirection ===
        'BEARISH' &&
        entryReady
    ) {
        entryStatus =
            'READY';


        entryMessage =
            '1M / 3M confirm bearish entry';
    }


    // ==================================================
    // HTF IMBALANCE
    // ==================================================

    let imbalanceConfluence =
        'NONE';


    const bullishHTF =
        smc1h &&
        smc1h.imbalances &&
        Array.isArray(
            smc1h.imbalances.activeBullish
        ) &&
        smc1h.imbalances
        .activeBullish
        .length > 0 &&

        smc30m &&
        smc30m.imbalances &&
        Array.isArray(
            smc30m.imbalances.activeBullish
        ) &&
        smc30m.imbalances
        .activeBullish
        .length > 0;


    const bearishHTF =
        smc1h &&
        smc1h.imbalances &&
        Array.isArray(
            smc1h.imbalances.activeBearish
        ) &&
        smc1h.imbalances
        .activeBearish
        .length > 0 &&

        smc30m &&
        smc30m.imbalances &&
        Array.isArray(
            smc30m.imbalances.activeBearish
        ) &&
        smc30m.imbalances
        .activeBearish
        .length > 0;


    if (
        bullishHTF
    ) {
        imbalanceConfluence =
            'BULLISH';
    }


    if (
        bearishHTF
    ) {
        imbalanceConfluence =
            'BEARISH';
    }


    // ==================================================
    // RESPONSE
    // ==================================================

    return {

        symbol,


        signal,


        direction,


        score: Math.max(
            bullishScore,
            bearishScore
        ),


        bullishScore,


        bearishScore,


        alignmentScore,


        entryStatus,


        entryMessage,


        imbalanceConfluence,


        // ==================================================
        // MTF LAYERS
        // ==================================================

        layers: {

            context: {

                direction: contextDirection,


                confidence: contextConfidence,


                edge: round(
                    contextEdge,
                    1
                ),


                bullishScore: round(
                    contextBullish,
                    1
                ),


                bearishScore: round(
                    contextBearish,
                    1
                ),


                timeframes: [
                    '1h',
                    '30m'
                ]
            },


            setup: {

                direction: setupDirection,


                confidence: setupConfidence,


                edge: round(
                    setupEdge,
                    1
                ),


                bullishScore: round(
                    setupBullish,
                    1
                ),


                bearishScore: round(
                    setupBearish,
                    1
                ),


                timeframes: [
                    '15m',
                    '5m'
                ]
            },


            entry: {

                direction: entryDirection,


                confidence: entryConfidence,


                edge: round(
                    entryEdge,
                    1
                ),


                bullishScore: round(
                    entryBullish,
                    1
                ),


                bearishScore: round(
                    entryBearish,
                    1
                ),


                ready: entryReady,


                timeframes: [
                    '3m',
                    '1m'
                ]
            }
        },


        // ==================================================
        // RAW SMC BY TIMEFRAME
        // ==================================================

        m1: smc1m,


        m3: smc3m,


        m5: smc5m,


        m15: smc15m,


        m30: smc30m,


        h1: smc1h,


        // ==================================================
        // DEBUG / DIAGNOSTICS
        // ==================================================

        timeframeScores: {

            m1: score1m,


            m3: score3m,


            m5: score5m,


            m15: score15m,


            m30: score30m,


            h1: score1h
        }
    };
}


// ======================================================
// EXPORT
// ======================================================

module.exports = {
    analyzeMultiTimeframe
};