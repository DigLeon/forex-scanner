const {
    num,
    clamp,
    round,
    toChronological,
    calculateSignalAgeSeconds
} = require('./utils');

const {
    atr,
    analyzeTechnical,
    analyzeCandles
} = require('./indicators');

const {
    analyzeStrategies
} = require('./strategies');

const {
    analyzeMultiTimeframe
} = require('./multiTimeframe');

const {
    getPairSession,
    analyzeMarketRegime,
    newsRiskPlaceholder
} = require('./market');

const {
    getPairSettings
} = require('./config');

const DEFAULT_SCORE_WEIGHTS = Object.freeze({
    context: 20,
    setup: 30,
    entry: 25,
    strategy: 15,
    session: 10
});

function normalizeScoreWeights(input) {
    const source = input && typeof input === 'object' ? input : DEFAULT_SCORE_WEIGHTS;
    const keys = ['context','setup','entry','strategy','session'];
    const out = {};
    let total = 0;

    for (const key of keys) {
        const value = Number(source[key]);
        out[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_SCORE_WEIGHTS[key];
        total += out[key];
    }

    if (total <= 0) return { ...DEFAULT_SCORE_WEIGHTS };

    for (const key of keys) {
        out[key] = out[key] / total * 100;
    }

    return out;
}


const {
    calculateExpirationEngine
} = require('./expirationEngine');

const {
    analyzeCandleConfirmation
} = require('./candleConfirmationEngine');


// ======================================================
// NORMALIZE MTF LAYER
// ======================================================

function normalizeLayerScore(
    layer,
    direction,
    maxRaw
) {
    if (!layer || !maxRaw) {
        return 0;
    }

    const raw =
        direction === 'UP' ?
        layer.bullishScore || 0 :
        layer.bearishScore || 0;

    return clamp(
        Math.round(
            (raw / maxRaw) * 100
        ),
        0,
        100
    );
}


// ======================================================
// IMBALANCE QUALITY
// ======================================================

function calculateImbalanceQuality(
    zone,
    timeframe
) {
    if (!zone) {
        return 0;
    }

    let score = 0;

    const ratio =
        zone.atrRatio || 0;

    if (
        ratio >= 0.20 &&
        ratio <= 1.20
    ) {
        score += 25;
    } else if (
        ratio >= 0.10 &&
        ratio <= 1.60
    ) {
        score += 12;
    }

    if (
        zone.status === 'UNTOUCHED'
    ) {
        score += 25;
    } else if (
        zone.status === 'MITIGATED' &&
        !zone.filled
    ) {
        score += 12;
    }

    const timeframeWeight = {
        '1h': 25,
        '30m': 22,
        '15m': 17,
        '5m': 12,
        '3m': 8,
        '1m': 5
    };

    score +=
        timeframeWeight[timeframe] || 0;

    if (!zone.filled) {
        score += 15;
    }

    return clamp(
        Math.round(score),
        0,
        100
    );
}


// ======================================================
// FIND BEST FVG
// ======================================================

function getBestImbalanceQuality(
    mtf,
    direction
) {
    const frames = [
        ['1h', mtf && mtf.h1],
        ['30m', mtf && mtf.m30],
        ['15m', mtf && mtf.m15],
        ['5m', mtf && mtf.m5],
        ['3m', mtf && mtf.m3],
        ['1m', mtf && mtf.m1]
    ];

    let best = {
        score: 0,
        timeframe: null,
        zone: null
    };

    for (
        const [timeframe, smc] of frames
    ) {
        if (!smc ||
            !smc.imbalances
        ) {
            continue;
        }

        const zones =
            direction === 'UP' ?
            smc.imbalances.activeBullish :
            smc.imbalances.activeBearish;

        if (!Array.isArray(zones)) {
            continue;
        }

        for (const zone of zones) {
            const score =
                calculateImbalanceQuality(
                    zone,
                    timeframe
                );

            if (score > best.score) {
                best = {
                    score,
                    timeframe,
                    zone
                };
            }
        }
    }

    return best;
}


// ======================================================
// HTF IMBALANCE CONFLUENCE
// ======================================================

function calculateHtfImbalanceConfluence(
    mtf,
    direction
) {
    if (!mtf) {
        return 0;
    }

    const key =
        direction === 'UP' ?
        'activeBullish' :
        'activeBearish';

    const frames = [
        mtf.h1,
        mtf.m30,
        mtf.m15,
        mtf.m5
    ];

    const weights = [
        35,
        30,
        20,
        15
    ];

    let score = 0;

    frames.forEach(
        (
            smc,
            index
        ) => {
            if (
                smc &&
                smc.imbalances &&
                Array.isArray(
                    smc.imbalances[key]
                ) &&
                smc.imbalances[key].length
            ) {
                score +=
                    weights[index];
            }
        }
    );

    return clamp(
        score,
        0,
        100
    );
}


// ======================================================
// DATA AGE STATUS
// ======================================================

function getDataAgeStatus(
    ageSeconds
) {
    if (
        ageSeconds === null ||
        ageSeconds === undefined ||
        !Number.isFinite(
            Number(ageSeconds)
        )
    ) {
        return 'UNKNOWN';
    }

    const age =
        Number(ageSeconds);

    if (age <= 30) {
        return 'FRESH';
    }

    if (age <= 60) {
        return 'ACTIVE';
    }

    if (age <= 120) {
        return 'LATE';
    }

    return 'STALE';
}


// ======================================================
// ENTRY ENGINE
// ======================================================

function calculateEntryEngine({
    signal,
    setupScore,
    entryScore,
    multiTimeframe,
    currentPrice,
    watchPrice,
    atrValue,
    signalAgeSeconds,
    candleAnalysis,
    imbalanceConfluence,
    sessionQuality,
    marketRegime
}) {
    const distanceAtr =
        atrValue &&
        Number.isFinite(currentPrice) &&
        Number.isFinite(watchPrice) ?
        Math.abs(
            currentPrice - watchPrice
        ) / atrValue :
        0;

    const roundedDistanceAtr =
        round(
            distanceAtr,
            3
        );

    if (!signal ||
        signal === 'NO SIGNAL'
    ) {
        return {
            status: 'WAIT',
            color: 'YELLOW',
            reason: 'No confirmed market setup',
            distanceAtr: roundedDistanceAtr,

            details: {
                type: 'NO SIGNAL',
                timeframe: null,
                expectedDirection: null,
                currentDirection: null,
                targetType: null,
                targetPrice: null,
                zoneLow: null,
                zoneHigh: null
            }
        };
    }

    const dataStatus =
        getDataAgeStatus(
            signalAgeSeconds
        );

    if (
        dataStatus === 'STALE'
    ) {
        return {
            status: 'STALE DATA',
            color: 'RED',
            reason: 'Market data is too old for entry timing',

            distanceAtr: roundedDistanceAtr,

            dataStatus,

            details: {
                type: 'DATA FRESHNESS',
                timeframe: '1M / 3M',
                currentAgeSeconds: signalAgeSeconds,
                requiredAgeSeconds: 60,

                expectedDirection: signal === 'UP' ?
                    'BULLISH' : 'BEARISH'
            }
        };
    }

    if (
        dataStatus === 'LATE'
    ) {
        return {
            status: 'WAIT FOR FRESH DATA',

            color: 'YELLOW',

            reason: 'Market signal may still be valid, but 1M / 3M timing data is delayed',

            distanceAtr: roundedDistanceAtr,

            dataStatus,

            details: {
                type: 'DATA FRESHNESS',
                timeframe: '1M / 3M',
                currentAgeSeconds: signalAgeSeconds,
                requiredAgeSeconds: 60,

                expectedDirection: signal === 'UP' ?
                    'BULLISH' : 'BEARISH'
            }
        };
    }

    const expected =
        signal === 'UP' ?
        'BULLISH' :
        'BEARISH';

    const context =
        multiTimeframe &&
        multiTimeframe.layers ?
        multiTimeframe.layers.context :
        null;

    const setup =
        multiTimeframe &&
        multiTimeframe.layers ?
        multiTimeframe.layers.setup :
        null;

    const entry =
        multiTimeframe &&
        multiTimeframe.layers ?
        multiTimeframe.layers.entry :
        null;

    if (
        context &&
        context.direction !== 'NEUTRAL' &&
        context.direction !== expected
    ) {
        return {
            status: 'MTF CONFLICT',
            color: 'RED',

            reason: '1H / 30M context conflicts with signal',

            distanceAtr: roundedDistanceAtr,

            details: {
                type: 'CONTEXT CONFLICT',

                timeframe: '1H / 30M',

                expectedDirection: expected,

                currentDirection: context.direction
            }
        };
    }

    if (
        setup &&
        setup.direction !== 'NEUTRAL' &&
        setup.direction !== expected
    ) {
        return {
            status: 'MTF CONFLICT',
            color: 'RED',

            reason: '15M / 5M setup conflicts with signal',

            distanceAtr: roundedDistanceAtr,

            details: {
                type: 'SETUP CONFLICT',

                timeframe: '15M / 5M',

                expectedDirection: expected,

                currentDirection: setup.direction
            }
        };
    }

    if (!entry ||
        entry.direction === 'NEUTRAL'
    ) {
        return {
            status: 'WAIT FOR CANDLE',

            color: 'YELLOW',

            reason: signal === 'UP' ?
                'Waiting for bullish 1M / 3M closed-candle confirmation' : 'Waiting for bearish 1M / 3M closed-candle confirmation',

            distanceAtr: roundedDistanceAtr,

            details: {
                type: 'CANDLE CONFIRMATION',

                timeframe: '1M / 3M',

                expectedDirection: expected,

                currentDirection: entry ?
                    entry.direction : 'UNKNOWN',

                entryReady: entry ?
                    Boolean(entry.ready) : false,

                confirmationRequired: signal === 'UP' ?
                    'BULLISH CLOSED CANDLE' : 'BEARISH CLOSED CANDLE'
            }
        };
    }

    if (
        entry.direction !== expected
    ) {
        const retest =
            getBestImbalanceQuality(
                multiTimeframe,
                signal
            );

        const zone =
            retest &&
            retest.zone ?
            retest.zone :
            null;

        const zoneLow =
            zone &&
            Number.isFinite(
                Number(zone.zoneLow)
            ) ?
            Number(zone.zoneLow) :
            null;

        const zoneHigh =
            zone &&
            Number.isFinite(
                Number(zone.zoneHigh)
            ) ?
            Number(zone.zoneHigh) :
            null;

        const targetPrice =
            zoneLow !== null &&
            zoneHigh !== null ?
            (
                zoneLow +
                zoneHigh
            ) / 2 :
            null;

        return {
            status: 'WAIT FOR RETEST',

            color: 'YELLOW',

            reason: zone ?
                `Waiting for ${String(
                        retest.timeframe || ''
                    ).toUpperCase()} imbalance/FVG retest` : 'Lower timeframe is moving against the signal; waiting for pullback/retest to resolve',

            distanceAtr: roundedDistanceAtr,

            details: {
                type: zone ?
                    'IMBALANCE / FVG RETEST' : 'LOWER-TF PULLBACK',

                timeframe: zone ?
                    String(
                        retest.timeframe || ''
                    ).toUpperCase() : '3M / 1M',

                expectedDirection: expected,

                currentDirection: entry.direction,

                targetType: zone ?
                    'IMBALANCE / FVG' : 'NO EXACT ZONE AVAILABLE',

                targetPrice: targetPrice !== null ?
                    round(
                        targetPrice,
                        6
                    ) : null,

                zoneLow: zoneLow !== null ?
                    round(
                        zoneLow,
                        6
                    ) : null,

                zoneHigh: zoneHigh !== null ?
                    round(
                        zoneHigh,
                        6
                    ) : null,

                currentPrice: Number.isFinite(
                        Number(
                            currentPrice
                        )
                    ) ?
                    Number(
                        currentPrice
                    ) : null
            }
        };
    }

    const candleConfirmed =
        signal === 'UP' ?
        (
            candleAnalysis &&
            candleAnalysis.scoreUp >=
            candleAnalysis.scoreDown
        ) :
        (
            candleAnalysis &&
            candleAnalysis.scoreDown >=
            candleAnalysis.scoreUp
        );

    if (!candleConfirmed) {
        return {
            status: 'WAIT FOR CANDLE',

            color: 'YELLOW',

            reason: signal === 'UP' ?
                '1M / 3M direction is aligned, but the latest closed candle does not confirm UP yet' : '1M / 3M direction is aligned, but the latest closed candle does not confirm DOWN yet',

            distanceAtr: roundedDistanceAtr,

            details: {
                type: 'CANDLE CONFIRMATION',

                timeframe: '1M / 3M',

                expectedDirection: expected,

                currentDirection: entry.direction,

                entryReady: Boolean(
                    entry.ready
                ),

                confirmationRequired: signal === 'UP' ?
                    'BULLISH CLOSED CANDLE' : 'BEARISH CLOSED CANDLE',

                candleScoreUp: candleAnalysis ?
                    candleAnalysis.scoreUp : null,

                candleScoreDown: candleAnalysis ?
                    candleAnalysis.scoreDown : null
            }
        };
    }

    let qualityScore = 0;

    qualityScore +=
        clamp(
            entryScore,
            0,
            100
        ) * 0.50;

    qualityScore +=
        clamp(
            setupScore,
            0,
            100
        ) * 0.25;

    qualityScore +=
        clamp(
            imbalanceConfluence || 0,
            0,
            100
        ) * 0.10;

    qualityScore +=
        clamp(
            sessionQuality || 0,
            0,
            100
        ) * 0.10;

    let regimeBonus = 3;

    if (
        marketRegime === 'TRENDING'
    ) {
        regimeBonus = 5;
    } else if (
        marketRegime === 'RANGE'
    ) {
        regimeBonus = 2;
    } else if (
        marketRegime ===
        'LOW VOLATILITY'
    ) {
        regimeBonus = 1;
    } else if (
        marketRegime ===
        'HIGH VOLATILITY'
    ) {
        regimeBonus = 3;
    }

    qualityScore +=
        regimeBonus;

    qualityScore =
        clamp(
            Math.round(
                qualityScore
            ),
            0,
            100
        );

    if (
        qualityScore < 55
    ) {
        return {
            status: 'WAIT',
            color: 'YELLOW',

            reason: 'Entry direction is aligned, but entry quality is still weak',

            distanceAtr: roundedDistanceAtr,

            qualityScore,

            details: {
                type: 'ENTRY QUALITY',

                timeframe: '5M / 3M / 1M',

                expectedDirection: expected,

                currentDirection: entry.direction,

                qualityScore,

                requiredQuality: 55
            }
        };
    }

    if (
        qualityScore < 65
    ) {
        return {
            status: 'CAUTION',

            color: 'YELLOW',

            reason: 'Entry confirmation is moderate',

            distanceAtr: roundedDistanceAtr,

            qualityScore,

            details: {
                type: 'ENTRY QUALITY',

                timeframe: '5M / 3M / 1M',

                expectedDirection: expected,

                currentDirection: entry.direction,

                qualityScore,

                requiredQuality: 65
            }
        };
    }

    return {
        status: 'ENTER NOW',

        color: 'GREEN',

        reason: 'Signal confirmed and lower-timeframe entry is aligned',

        distanceAtr: roundedDistanceAtr,

        qualityScore,

        details: {
            type: 'ENTRY CONFIRMED',

            timeframe: '5M / 3M / 1M',

            expectedDirection: expected,

            currentDirection: entry.direction,

            qualityScore,

            dataStatus
        }
    };
}


// ======================================================
// ENTRY ZONE ENGINE
//
// NEW MODULE #1
//
// Best Entry
// Best Entry Zone
// Last Acceptable Entry
// Too Late
// ======================================================

function calculateEntryZoneEngine({
    signal,
    multiTimeframe,
    currentPrice,
    watchPrice,
    atrValue
}) {
    const hasSignal =
        signal === 'UP' ||
        signal === 'DOWN';

    const safeCurrentPrice =
        Number.isFinite(
            Number(currentPrice)
        ) ?
        Number(currentPrice) :
        null;

    const safeWatchPrice =
        Number.isFinite(
            Number(watchPrice)
        ) ?
        Number(watchPrice) :
        safeCurrentPrice;

    const safeAtr =
        Number.isFinite(
            Number(atrValue)
        ) &&
        Number(atrValue) > 0 ?
        Number(atrValue) :
        0;


    // ==================================================
    // NO SIGNAL
    // ==================================================

    if (!hasSignal ||
        safeWatchPrice === null
    ) {
        return {
            available: false,

            status: 'NO ENTRY ZONE',

            color: 'GRAY',

            source: null,

            timeframe: null,

            bestEntryPrice: null,

            bestZoneLow: null,

            bestZoneHigh: null,

            lastAcceptablePrice: null,

            worstEntryPrice: null,

            currentPrice: safeCurrentPrice,

            currentEntryQuality: 'NO SIGNAL',

            currentEntryScore: 0,

            distanceToBestAtr: null,

            distanceToLastAcceptableAtr: null,

            distanceToWorstAtr: null,

            worstEntrySource: null,

            reason: 'No confirmed market signal'
        };
    }


    // ==================================================
    // FIND BEST STRUCTURAL ENTRY ZONE
    // ==================================================

    const bestImbalance =
        getBestImbalanceQuality(
            multiTimeframe,
            signal
        );

    const zone =
        bestImbalance &&
        bestImbalance.zone ?
        bestImbalance.zone :
        null;


    let bestZoneLow =
        zone &&
        Number.isFinite(
            Number(
                zone.zoneLow
            )
        ) ?
        Number(
            zone.zoneLow
        ) :
        null;


    let bestZoneHigh =
        zone &&
        Number.isFinite(
            Number(
                zone.zoneHigh
            )
        ) ?
        Number(
            zone.zoneHigh
        ) :
        null;


    const source =
        zone ?
        'IMBALANCE / FVG' :
        'REFERENCE / ATR';


    const timeframe =
        zone ?
        String(
            bestImbalance.timeframe || ''
        ).toUpperCase() :
        '1M';


    // ==================================================
    // FALLBACK ENTRY ZONE
    //
    // If no FVG / imbalance exists,
    // create an ATR-based entry zone around
    // the reference price.
    // ==================================================

    if (
        bestZoneLow === null ||
        bestZoneHigh === null
    ) {
        const fallbackHalfWidth =
            safeAtr > 0 ?
            safeAtr * 0.08 :
            Math.abs(
                safeWatchPrice
            ) * 0.00008;


        bestZoneLow =
            safeWatchPrice -
            fallbackHalfWidth;


        bestZoneHigh =
            safeWatchPrice +
            fallbackHalfWidth;
    }


    // Make sure LOW < HIGH

    if (
        bestZoneLow >
        bestZoneHigh
    ) {
        const temp =
            bestZoneLow;

        bestZoneLow =
            bestZoneHigh;

        bestZoneHigh =
            temp;
    }


    // ==================================================
    // BEST ENTRY PRICE
    //
    // Exact preferred price.
    // ==================================================

    const bestEntryPrice =
        (
            bestZoneLow +
            bestZoneHigh
        ) / 2;


    // ==================================================
    // LAST ACCEPTABLE / WORST ENTRY
    //
    // LAST ACCEPTABLE =
    // entry is still possible but not ideal.
    //
    // WORST ENTRY =
    // DO NOT ENTER after this price.
    // ==================================================

    const lastAllowance =
        safeAtr > 0 ?
        safeAtr * 0.30 :
        Math.abs(
            bestEntryPrice
        ) * 0.00030;


    const worstAllowance =
        safeAtr > 0 ?
        safeAtr * 0.60 :
        Math.abs(
            bestEntryPrice
        ) * 0.00060;


    /*
        For UP:
        price moving upward away from the zone
        becomes progressively worse.

        For DOWN:
        price moving downward away from the zone
        becomes progressively worse.
    */

    const favorableEdge =
        signal === 'UP' ?
        bestZoneHigh :
        bestZoneLow;


    let lastAcceptablePrice =
        signal === 'UP' ?
        favorableEdge +
        lastAllowance :
        favorableEdge -
        lastAllowance;


    let worstEntryPrice =
        signal === 'UP' ?
        favorableEdge +
        worstAllowance :
        favorableEdge -
        worstAllowance;


    let worstEntrySource =
        'ATR EXTENSION';


    // ==================================================
    // STRUCTURAL WORST ENTRY
    //
    // If an opposing FVG / imbalance exists before
    // the ATR worst boundary, use that market level
    // instead.
    // ==================================================

    const opposingZone =
        getNearestOpposingImbalance(
            multiTimeframe,
            signal,
            bestEntryPrice,
            safeAtr
        );


    if (
        opposingZone &&
        opposingZone.distanceAtr !== null &&
        opposingZone.distanceAtr <= 1.00
    ) {
        const structuralWorst =
            signal === 'UP' ?
            Number(
                opposingZone.zoneLow
            ) :
            Number(
                opposingZone.zoneHigh
            );


        const validStructuralWorst =
            Number.isFinite(
                structuralWorst
            ) &&
            (
                signal === 'UP' ?
                structuralWorst >
                favorableEdge :
                structuralWorst <
                favorableEdge
            );


        if (
            validStructuralWorst
        ) {
            const structuralIsCloser =
                signal === 'UP' ?
                structuralWorst <
                worstEntryPrice :
                structuralWorst >
                worstEntryPrice;


            if (
                structuralIsCloser
            ) {
                worstEntryPrice =
                    structuralWorst;


                worstEntrySource =
                    `OPPOSING ${opposingZone.timeframe} IMBALANCE / FVG`;
            }
        }
    }


    // ==================================================
    // KEEP LAST ACCEPTABLE BEFORE WORST
    // ==================================================

    const worstDistanceFromEdge =
        Math.abs(
            worstEntryPrice -
            favorableEdge
        );


    const minimumUsefulDistance =
        safeAtr > 0 ?
        safeAtr * 0.05 :
        Math.abs(
            bestEntryPrice
        ) * 0.00005;


    if (
        worstDistanceFromEdge >
        minimumUsefulDistance
    ) {
        const lastIsBeyondWorst =
            signal === 'UP' ?
            lastAcceptablePrice >=
            worstEntryPrice :
            lastAcceptablePrice <=
            worstEntryPrice;


        if (
            lastIsBeyondWorst
        ) {
            /*
                Put LAST ACCEPTABLE
                at 65% of distance toward WORST.
            */

            lastAcceptablePrice =
                signal === 'UP' ?
                favorableEdge +
                worstDistanceFromEdge *
                0.65 :
                favorableEdge -
                worstDistanceFromEdge *
                0.65;
        }
    }


    // ==================================================
    // DISTANCE FROM CURRENT PRICE
    // ==================================================

    const distanceToBestAtr =
        safeCurrentPrice !== null &&
        safeAtr > 0 ?
        Math.abs(
            safeCurrentPrice -
            bestEntryPrice
        ) / safeAtr :
        null;


    const distanceToLastAcceptableAtr =
        safeCurrentPrice !== null &&
        safeAtr > 0 ?
        Math.abs(
            safeCurrentPrice -
            lastAcceptablePrice
        ) / safeAtr :
        null;


    const distanceToWorstAtr =
        safeCurrentPrice !== null &&
        safeAtr > 0 ?
        Math.abs(
            safeCurrentPrice -
            worstEntryPrice
        ) / safeAtr :
        null;


    // ==================================================
    // CURRENT ENTRY QUALITY
    //
    // BEST ENTRY
    // GOOD ENTRY
    // ACCEPTABLE
    // BAD ENTRY
    // WORST ENTRY / DO NOT ENTER
    // WAIT FOR BEST ENTRY
    // ==================================================

    let status =
        'WAIT FOR BEST ENTRY';


    let color =
        'YELLOW';


    let currentEntryQuality =
        'WAIT FOR BEST ENTRY';


    let currentEntryScore =
        55;


    let reason =
        'Wait for price to reach the preferred entry zone';


    // ==================================================
    // CURRENT PRICE INSIDE BEST ZONE
    // ==================================================

    const insideBestZone =
        safeCurrentPrice !== null &&
        safeCurrentPrice >=
        bestZoneLow &&
        safeCurrentPrice <=
        bestZoneHigh;


    // ==================================================
    // CURRENT PRICE PASSED WORST ENTRY
    // ==================================================

    const passedWorst =
        safeCurrentPrice !== null &&
        (
            signal === 'UP' ?
            safeCurrentPrice >=
            worstEntryPrice :
            safeCurrentPrice <=
            worstEntryPrice
        );


    // ==================================================
    // CURRENT PRICE BETWEEN LAST AND WORST
    // ==================================================

    const passedLastButBeforeWorst =
        safeCurrentPrice !== null &&
        (
            signal === 'UP' ?
            safeCurrentPrice >
            lastAcceptablePrice &&
            safeCurrentPrice <
            worstEntryPrice :
            safeCurrentPrice <
            lastAcceptablePrice &&
            safeCurrentPrice >
            worstEntryPrice
        );


    // ==================================================
    // PRICE BETWEEN BEST ZONE AND LAST ACCEPTABLE
    // ==================================================

    const afterBestBeforeLast =
        safeCurrentPrice !== null &&
        (
            signal === 'UP' ?
            safeCurrentPrice >
            bestZoneHigh &&
            safeCurrentPrice <=
            lastAcceptablePrice :
            safeCurrentPrice <
            bestZoneLow &&
            safeCurrentPrice >=
            lastAcceptablePrice
        );


    // ==================================================
    // BEST ENTRY
    // ==================================================

    if (
        insideBestZone
    ) {
        status =
            'BEST ENTRY';


        color =
            'GREEN';


        currentEntryQuality =
            'BEST ENTRY';


        currentEntryScore =
            100;


        reason =
            `Price is inside the preferred ${source.toLowerCase()} zone`;
    }


    // ==================================================
    // WORST ENTRY / DO NOT ENTER
    // ==================================================
    else if (
        passedWorst
    ) {
        status =
            'TOO LATE';


        color =
            'RED';


        currentEntryQuality =
            'WORST ENTRY / DO NOT ENTER';


        currentEntryScore =
            0;


        reason =
            signal === 'UP' ?
            `Do not enter UP at or above ${round(
                    worstEntryPrice,
                    6
                )}; price has reached the worst-entry boundary` :
            `Do not enter DOWN at or below ${round(
                    worstEntryPrice,
                    6
                )}; price has reached the worst-entry boundary`;
    }


    // ==================================================
    // BAD ENTRY
    // ==================================================
    else if (
        passedLastButBeforeWorst
    ) {
        status =
            'BAD ENTRY';


        color =
            'RED';


        currentEntryQuality =
            'BAD ENTRY';


        currentEntryScore =
            30;


        reason =
            'Entry quality is poor; price is between LAST ACCEPTABLE and WORST ENTRY';
    }


    // ==================================================
    // GOOD / ACCEPTABLE ENTRY
    // ==================================================
    else if (
        afterBestBeforeLast
    ) {
        const usableRange =
            Math.abs(
                lastAcceptablePrice -
                favorableEdge
            );


        const progress =
            usableRange > 0 ?
            Math.abs(
                safeCurrentPrice -
                favorableEdge
            ) /
            usableRange :
            0;


        /*
            First 50% after the best zone = GOOD.

            Second 50% before LAST = ACCEPTABLE.
        */

        if (
            progress <= 0.50
        ) {
            status =
                'GOOD ENTRY';


            color =
                'GREEN';


            currentEntryQuality =
                'GOOD ENTRY';


            currentEntryScore =
                85;


            reason =
                'Price has left the ideal zone but is still close to the best entry';
        } else {
            status =
                'ACCEPTABLE';


            color =
                'YELLOW';


            currentEntryQuality =
                'ACCEPTABLE';


            currentEntryScore =
                65;


            reason =
                'Entry is still acceptable, but the price is approaching the last acceptable level';
        }
    }


    // ==================================================
    // PRICE HAS NOT REACHED BEST ENTRY YET
    // ==================================================
    else if (
        safeCurrentPrice !== null
    ) {
        status =
            'WAIT FOR BEST ENTRY';


        color =
            'YELLOW';


        currentEntryQuality =
            'WAIT FOR BEST ENTRY';


        currentEntryScore =
            55;


        reason =
            signal === 'UP' ?
            `Best UP entry is near ${round(
                    bestEntryPrice,
                    6
                )}; wait for price to reach the preferred zone` :
            `Best DOWN entry is near ${round(
                    bestEntryPrice,
                    6
                )}; wait for price to reach the preferred zone`;
    }


    // ==================================================
    // RESPONSE
    // ==================================================

    return {
        available: true,


        status,


        color,


        source,


        timeframe,


        // Exact GOOD / BEST price
        bestEntryPrice: round(
            bestEntryPrice,
            6
        ),


        // Preferred entry zone
        bestZoneLow: round(
            bestZoneLow,
            6
        ),


        bestZoneHigh: round(
            bestZoneHigh,
            6
        ),


        // Still possible, but getting worse
        lastAcceptablePrice: round(
            lastAcceptablePrice,
            6
        ),


        // Exact BAD / DO NOT ENTER boundary
        worstEntryPrice: round(
            worstEntryPrice,
            6
        ),


        worstEntrySource,


        currentPrice: safeCurrentPrice !== null ?
            round(
                safeCurrentPrice,
                6
            ) : null,


        currentEntryQuality,


        currentEntryScore,


        distanceToBestAtr: distanceToBestAtr !== null ?
            round(
                distanceToBestAtr,
                3
            ) : null,


        distanceToLastAcceptableAtr: distanceToLastAcceptableAtr !== null ?
            round(
                distanceToLastAcceptableAtr,
                3
            ) : null,


        distanceToWorstAtr: distanceToWorstAtr !== null ?
            round(
                distanceToWorstAtr,
                3
            ) : null,


        zoneQuality: bestImbalance ?
            bestImbalance.score || 0 : 0,


        zoneStatus: zone ?
            zone.status || null : null,


        zoneFilled: zone ?
            Boolean(
                zone.filled
            ) : false,


        reason
    };
}


// ======================================================
// NEAREST OPPOSING IMBALANCE
//
// Used by Signal Strength Engine.
// Example:
//
// UP is moving toward a fresh bearish FVG.
// First interaction may reject.
// Therefore recommendation must be weaker.
// ======================================================

function getNearestOpposingImbalance(
    multiTimeframe,
    signal,
    currentPrice,
    atrValue
) {
    if (!multiTimeframe ||
        !Number.isFinite(
            Number(currentPrice)
        )
    ) {
        return null;
    }

    const frames = [
        ['1h', multiTimeframe.h1],
        ['30m', multiTimeframe.m30],
        ['15m', multiTimeframe.m15],
        ['5m', multiTimeframe.m5],
        ['3m', multiTimeframe.m3],
        ['1m', multiTimeframe.m1]
    ];

    const key =
        signal === 'UP' ?
        'activeBearish' :
        'activeBullish';

    const price =
        Number(currentPrice);

    const safeAtr =
        Number.isFinite(
            Number(atrValue)
        ) &&
        Number(atrValue) > 0 ?
        Number(atrValue) :
        0;

    let nearest =
        null;

    for (
        const [timeframe, smc] of frames
    ) {
        if (!smc ||
            !smc.imbalances ||
            !Array.isArray(
                smc.imbalances[key]
            )
        ) {
            continue;
        }

        for (
            const zone
            of smc.imbalances[key]
        ) {
            const low =
                Number(
                    zone.zoneLow
                );

            const high =
                Number(
                    zone.zoneHigh
                );

            if (!Number.isFinite(low) ||
                !Number.isFinite(high)
            ) {
                continue;
            }

            const zoneLow =
                Math.min(
                    low,
                    high
                );

            const zoneHigh =
                Math.max(
                    low,
                    high
                );

            let distance =
                null;

            if (
                signal === 'UP'
            ) {
                if (
                    zoneHigh <
                    price
                ) {
                    continue;
                }

                distance =
                    Math.max(
                        0,
                        zoneLow -
                        price
                    );
            } else {
                if (
                    zoneLow >
                    price
                ) {
                    continue;
                }

                distance =
                    Math.max(
                        0,
                        price -
                        zoneHigh
                    );
            }

            if (
                nearest === null ||
                distance <
                nearest.distance
            ) {
                nearest = {
                    timeframe,
                    zone,
                    zoneLow,
                    zoneHigh,
                    distance,

                    distanceAtr: safeAtr > 0 ?
                        distance /
                        safeAtr : null
                };
            }
        }
    }

    if (!nearest) {
        return null;
    }

    return {
        timeframe: String(
            nearest.timeframe || ''
        ).toUpperCase(),

        zoneLow: round(
            nearest.zoneLow,
            6
        ),

        zoneHigh: round(
            nearest.zoneHigh,
            6
        ),

        distanceAtr: nearest.distanceAtr !== null ?
            round(
                nearest.distanceAtr,
                3
            ) : null,

        status: nearest.zone.status ||
            null,

        filled: Boolean(
            nearest.zone.filled
        ),

        /*
            If your SMC module later supplies
            touchCount or testCount,
            this engine will use it automatically.
        */

        touchCount: Number.isFinite(
                Number(
                    nearest.zone.touchCount
                )
            ) ?
            Number(
                nearest.zone.touchCount
            ) : Number.isFinite(
                Number(
                    nearest.zone.testCount
                )
            ) ?
            Number(
                nearest.zone.testCount
            ) : null
    };
}


// ======================================================
// SIGNAL STRENGTH ENGINE
//
// NEW MODULE #2
//
// This DOES NOT replace Signal Score.
//
// Signal Score:
// "Is there a market setup?"
//
// Signal Strength:
// "How good is this signal for entry NOW?"
// ======================================================

function calculateSignalStrength({
    signal,
    marketScore,
    setupScore,
    entryScore,
    strategyScore,
    sessionQuality,
    imbalanceQuality,
    htfImbalanceConfluence,
    signalAgeSeconds,
    entryEngine,
    entryZone,
    multiTimeframe,
    currentPrice,
    atrValue,
    contextSetupConflict,
    marketRegime
}) {
    if (
        signal !== 'UP' &&
        signal !== 'DOWN'
    ) {
        return {
            score: 0,

            level: 'NO SIGNAL',

            recommendation: 'NOT RECOMMENDED',

            color: 'GRAY',

            reasons: [],

            warnings: [
                'No confirmed market signal'
            ],

            obstacle: null
        };
    }

    const reasons = [];
    const warnings = [];

    const freshnessScore =
        signalAgeSeconds === null ||
        signalAgeSeconds === undefined ?
        40 :
        signalAgeSeconds <= 30 ?
        100 :
        signalAgeSeconds <= 60 ?
        80 :
        signalAgeSeconds <= 120 ?
        45 :
        0;

    let zoneScore = 45;

    if (
        entryZone &&
        entryZone.status ===
        'BEST ENTRY ZONE'
    ) {
        zoneScore = 100;

        reasons.push(
            'Price is inside the preferred entry zone'
        );
    } else if (
        entryZone &&
        entryZone.status ===
        'WAIT FOR RETEST'
    ) {
        zoneScore = 70;

        reasons.push(
            'A structural retest can improve the entry'
        );
    } else if (
        entryZone &&
        entryZone.status ===
        'TOO LATE'
    ) {
        zoneScore = 0;

        warnings.push(
            'Price is beyond the last acceptable entry'
        );
    }

    /*
        Weighting for the moment-of-entry recommendation.

        This is intentionally different
        from the global signal score.
    */

    let strength =
        clamp(
            marketScore || 0,
            0,
            100
        ) * 0.25 +

        clamp(
            setupScore || 0,
            0,
            100
        ) * 0.15 +

        clamp(
            entryScore || 0,
            0,
            100
        ) * 0.15 +

        clamp(
            strategyScore || 0,
            0,
            100
        ) * 0.10 +

        clamp(
            imbalanceQuality || 0,
            0,
            100
        ) * 0.10 +

        clamp(
            htfImbalanceConfluence || 0,
            0,
            100
        ) * 0.08 +

        clamp(
            sessionQuality || 0,
            0,
            100
        ) * 0.05 +

        freshnessScore *
        0.05 +

        zoneScore *
        0.07;

    if (
        setupScore >= 65
    ) {
        reasons.push(
            '15M / 5M setup is strong'
        );
    }

    if (
        entryScore >= 65
    ) {
        reasons.push(
            '3M / 1M entry layer supports the signal'
        );
    }

    if (
        htfImbalanceConfluence >=
        50
    ) {
        reasons.push(
            'Higher-timeframe imbalance confluence is present'
        );
    }

    if (
        imbalanceQuality >=
        65
    ) {
        reasons.push(
            'Directional imbalance / FVG quality is strong'
        );
    }

    if (
        signalAgeSeconds !== null &&
        signalAgeSeconds <= 30
    ) {
        reasons.push(
            'Signal timing data is fresh'
        );
    }

    if (
        contextSetupConflict
    ) {
        strength -= 30;

        warnings.push(
            'Higher-timeframe context conflicts with setup'
        );
    }

    if (
        entryEngine &&
        entryEngine.color === 'RED'
    ) {
        strength -= 22;

        warnings.push(
            entryEngine.reason ||
            'Entry engine reports a blocking condition'
        );
    } else if (
        entryEngine &&
        entryEngine.color ===
        'YELLOW'
    ) {
        strength -= 7;

        warnings.push(
            entryEngine.reason ||
            'Entry timing still needs confirmation'
        );
    }

    if (
        signalAgeSeconds !== null &&
        signalAgeSeconds > 120
    ) {
        strength -= 25;

        warnings.push(
            'Signal timing data is stale'
        );
    }

    if (
        marketRegime ===
        'LOW VOLATILITY'
    ) {
        strength -= 4;

        warnings.push(
            'Low-volatility regime can reduce follow-through'
        );
    }

    /*
        Very important part from our discussion:

        Price approaching an opposing
        OB/FVG/imbalance is NOT automatically
        a strong continuation signal.

        Fresh/first interaction can reject.

        Repeated tests make the zone weaker.
    */

    const obstacle =
        getNearestOpposingImbalance(
            multiTimeframe,
            signal,
            currentPrice,
            atrValue
        );

    if (
        obstacle &&
        obstacle.distanceAtr !== null &&
        obstacle.distanceAtr <= 0.35
    ) {
        const isFresh =
            obstacle.status ===
            'UNTOUCHED' ||
            obstacle.touchCount === 0 ||
            obstacle.touchCount === null;

        if (
            isFresh &&
            !obstacle.filled
        ) {
            strength -= 15;

            warnings.push(
                `Fresh opposing ${obstacle.timeframe} imbalance is close; first touch may reject price`
            );
        } else if (
            obstacle.touchCount !== null &&
            obstacle.touchCount >= 2
        ) {
            strength -= 4;

            warnings.push(
                `Opposing ${obstacle.timeframe} zone is close, but it has already been tested multiple times`
            );
        } else {
            strength -= 8;

            warnings.push(
                `Opposing ${obstacle.timeframe} imbalance is close to current price`
            );
        }
    }

    strength =
        clamp(
            Math.round(
                strength
            ),
            0,
            100
        );

    let level =
        'WEAK';

    let recommendation =
        'NOT RECOMMENDED';

    let color =
        'RED';

    if (
        strength >= 80 &&
        (!entryZone ||
            entryZone.status !==
            'TOO LATE'
        ) &&
        (!entryEngine ||
            entryEngine.color !==
            'RED'
        )
    ) {
        level =
            'STRONG';

        recommendation =
            'RECOMMENDED';

        color =
            'GREEN';
    } else if (
        strength >= 65
    ) {
        level =
            'GOOD';

        recommendation =
            'RECOMMENDED WITH CAUTION';

        color =
            'GREEN';
    } else if (
        strength >= 50
    ) {
        level =
            'MODERATE';

        recommendation =
            'WAIT / CAUTION';

        color =
            'YELLOW';
    }

    if (
        entryZone &&
        entryZone.status ===
        'TOO LATE'
    ) {
        recommendation =
            'NOT RECOMMENDED';

        color =
            'RED';

        if (
            strength > 49
        ) {
            strength = 49;
        }

        level =
            'LATE';
    }

    return {
        score: strength,

        level,

        recommendation,

        color,

        reasons,

        warnings,

        obstacle
    };
}


// ======================================================
// MAIN ANALYSIS ENGINE
// ======================================================

function combinedAnalysis(
    symbol,
    closedCandles,
    livePrice = null,
    options = {}
) {
    const pairSession =
        getPairSession(
            symbol
        );

    const settings =
        getPairSettings(
            symbol
        );


    const scoreWeights =
        normalizeScoreWeights(
            options.scoreWeights
        );


    // ==================================================
    // v4.7.3 EFFECTIVE MIN SCORE
    // ==================================================
    //
    // The GUI can make the scanner stricter, but it can
    // never lower the pair-specific safety threshold.
    //
    // Effective Min Score =
    // max(User Min Score, Pair Safety Minimum)
    // ==================================================

    const pairSafetyMinScore =
        Number(
            settings.minSignalScore
        ) || 0;


    const requestedUserMinScore =
        Number(
            options.userMinScore
        );


    const userMinScore =
        Number.isFinite(
            requestedUserMinScore
        )
            ?
            requestedUserMinScore
            :
            null;


    const effectiveMinScore =
        Math.max(
            pairSafetyMinScore,
            userMinScore !==
                null
                ?
                userMinScore
                :
                pairSafetyMinScore
        );


    settings.minSignalScore =
        effectiveMinScore;


    const ordered =
        toChronological(
            closedCandles
        );

    // ==================================================
    // BASIC ANALYSIS
    // ==================================================

    const technical =
        analyzeTechnical(
            ordered,
            5
        );

    const candleAnalysis =
        analyzeCandles(
            ordered
        );

    const multiTimeframe =
        analyzeMultiTimeframe(
            symbol,
            closedCandles
        );

    const marketRegime =
        analyzeMarketRegime(
            ordered
        );

    const newsRisk =
        newsRiskPlaceholder(
            symbol
        );

    // ==================================================
    // STRATEGIES
    // ==================================================

    const strategyEngine =
        analyzeStrategies(
            symbol,
            ordered,
            technical,
            candleAnalysis,
            multiTimeframe.m1
        );

    // ==================================================
    // NORMALIZED COMPONENTS
    // ==================================================

    const contextUp =
        normalizeLayerScore(
            multiTimeframe.layers.context,
            'UP',
            25
        );

    const contextDown =
        normalizeLayerScore(
            multiTimeframe.layers.context,
            'DOWN',
            25
        );

    const setupUp =
        normalizeLayerScore(
            multiTimeframe.layers.setup,
            'UP',
            25
        );

    const setupDown =
        normalizeLayerScore(
            multiTimeframe.layers.setup,
            'DOWN',
            25
        );

    const entryUp =
        normalizeLayerScore(
            multiTimeframe.layers.entry,
            'UP',
            15
        );

    const entryDown =
        normalizeLayerScore(
            multiTimeframe.layers.entry,
            'DOWN',
            15
        );

    const strategyUp =
        clamp(
            strategyEngine.scoreUp || 0,
            0,
            100
        );

    const strategyDown =
        clamp(
            strategyEngine.scoreDown || 0,
            0,
            100
        );

    const sessionScore =
        clamp(
            pairSession.quality || 0,
            0,
            100
        );

    // ==================================================
    // MARKET SIGNAL SCORE — v4.7 CALIBRATED
    // ==================================================
    //
    // The score now reflects the hierarchy of the setup:
    //
    // Context   20%
    // Setup     30%
    // Entry     25%
    // Strategy  15%
    // Session   10%
    //
    // Entry is no longer excluded from the market score.
    // Closed-candle entry quality is important enough to
    // materially change the final confidence.
    //
    // Directional penalties / bonuses are applied AFTER
    // the normalized weighted score.
    // ==================================================

    const contextDirection =
        multiTimeframe &&
        multiTimeframe.layers &&
        multiTimeframe.layers.context
            ?
            multiTimeframe
                .layers
                .context
                .direction
            :
            'NEUTRAL';


    const setupDirection =
        multiTimeframe &&
        multiTimeframe.layers &&
        multiTimeframe.layers.setup
            ?
            multiTimeframe
                .layers
                .setup
                .direction
            :
            'NEUTRAL';


    const entryDirection =
        multiTimeframe &&
        multiTimeframe.layers &&
        multiTimeframe.layers.entry
            ?
            multiTimeframe
                .layers
                .entry
                .direction
            :
            'NEUTRAL';


    const contextSetupConflict =
        contextDirection !==
        'NEUTRAL' &&
        setupDirection !==
        'NEUTRAL' &&
        contextDirection !==
        setupDirection;


    const contextSetupAligned =
        contextDirection !==
        'NEUTRAL' &&
        setupDirection !==
        'NEUTRAL' &&
        contextDirection ===
        setupDirection;


    const regimePenalty =
        marketRegime.regime ===
            'LOW VOLATILITY'
            ?
            -6
            :
            marketRegime.regime ===
                'RANGE'
                ?
                -5
                :
                marketRegime.regime ===
                    'HIGH VOLATILITY'
                    ?
                    -2
                    :
                    0;


    function calculateDirectionalQualityAdjustment(
        direction,
        entryComponent
    ) {

        const expectedMtfDirection =
            direction ===
                'UP'
                ?
                'BULLISH'
                :
                'BEARISH';


        let adjustment =
            regimePenalty;


        // Strong context/setup alignment is valuable,
        // but it should not dominate the score by itself.
        if (
            contextSetupAligned &&
            contextDirection ===
                expectedMtfDirection
        ) {

            adjustment +=
                5;
        }


        // Neutral higher-timeframe context reduces
        // confidence even if lower layers look attractive.
        if (
            contextDirection ===
            'NEUTRAL'
        ) {

            adjustment -=
                5;
        }


        // A neutral setup layer is more important than a
        // neutral context layer because it is closer to
        // the actual signal formation.
        if (
            setupDirection ===
            'NEUTRAL'
        ) {

            adjustment -=
                9;
        }


        // Closed-candle entry confirmation matters.
        if (
            entryDirection ===
                expectedMtfDirection &&
            entryComponent >=
                65
        ) {

            adjustment +=
                5;


        } else if (
            entryDirection !==
                'NEUTRAL' &&
            entryDirection !==
                expectedMtfDirection
        ) {

            adjustment -=
                10;


        } else if (
            entryComponent <
                40
        ) {

            adjustment -=
                5;
        }


        // A direct context/setup conflict remains a hard
        // signal blocker later, but the score should also
        // communicate that poor quality.
        if (
            contextSetupConflict
        ) {

            adjustment -=
                20;
        }


        return adjustment;
    }


    const rawUpScore =
        contextUp * (scoreWeights.context / 100) +
        setupUp * (scoreWeights.setup / 100) +
        entryUp * (scoreWeights.entry / 100) +
        strategyUp * (scoreWeights.strategy / 100) +
        sessionScore * (scoreWeights.session / 100);


    const rawDownScore =
        contextDown * (scoreWeights.context / 100) +
        setupDown * (scoreWeights.setup / 100) +
        entryDown * (scoreWeights.entry / 100) +
        strategyDown * (scoreWeights.strategy / 100) +
        sessionScore * (scoreWeights.session / 100);


    const upScoreAdjustment =
        calculateDirectionalQualityAdjustment(
            'UP',
            entryUp
        );


    const downScoreAdjustment =
        calculateDirectionalQualityAdjustment(
            'DOWN',
            entryDown
        );


    let upScore =
        clamp(
            Math.round(
                rawUpScore +
                upScoreAdjustment
            ),
            0,
            100
        );


    let downScore =
        clamp(
            Math.round(
                rawDownScore +
                downScoreAdjustment
            ),
            0,
            100
        );


    // ==================================================
    // MARKET BIAS
    // ==================================================

    let marketBias =
        'NEUTRAL';


    if (
        contextDirection ===
        'BULLISH'
    ) {

        marketBias =
            'UP';
    }


    if (
        contextDirection ===
        'BEARISH'
    ) {

        marketBias =
            'DOWN';
    }


    // ==================================================
    // FINAL SIGNAL
    // ==================================================

    let signal =
        'NO SIGNAL';

    let signalStage =
        'NO SETUP';

    const scoreEdge =
        Math.abs(
            upScore -
            downScore
        );

    const bullishCandidate =
        upScore >=
        settings.minSignalScore &&

        upScore >
        downScore &&

        scoreEdge >=
        settings.minEdge;

    const bearishCandidate =
        downScore >=
        settings.minSignalScore &&

        downScore >
        upScore &&

        scoreEdge >=
        settings.minEdge;

    if (
        contextSetupConflict
    ) {
        signal =
            'NO SIGNAL';

        signalStage =
            'WAIT FOR SETUP';
    } else if (
        bullishCandidate
    ) {
        signal =
            'UP';

        signalStage =
            contextSetupAligned ?
            'CONFIRMED SETUP' :
            'EARLY SETUP';
    } else if (
        bearishCandidate
    ) {
        signal =
            'DOWN';

        signalStage =
            contextSetupAligned ?
            'CONFIRMED SETUP' :
            'EARLY SETUP';
    }

    // ==================================================
    // PRIMARY STRATEGY
    // ==================================================

    const matchingStrategies =
        Array.isArray(
            strategyEngine.strategies
        ) ?
        strategyEngine
        .strategies
        .filter(
            strategy =>
            strategy.active &&
            signal !==
            'NO SIGNAL' &&
            strategy.direction ===
            signal
        )
        .sort(
            (
                a,
                b
            ) =>
            (
                b.confidence ||
                0
            ) -
            (
                a.confidence ||
                0
            )
        ) : [];

    const primaryStrategy =
        matchingStrategies.length ?
        matchingStrategies[0] :
        null;

    const score =
        signal === 'UP' ?
        upScore :
        signal === 'DOWN' ?
        downScore :
        Math.max(
            upScore,
            downScore
        );

    // ==================================================
    // PRICES
    // ==================================================

    const latestClosed =
        ordered[
            ordered.length - 1
        ];

    const watchPrice =
        latestClosed ?
        num(
            latestClosed.close
        ) :
        null;

    const currentPrice =
        Number.isFinite(
            Number(livePrice)
        ) ?
        Number(livePrice) :
        watchPrice;

    const atrValue =
        atr(
            ordered,
            14
        ) || 0;

    // ==================================================
    // SIGNAL AGE
    // ==================================================

    const rawAge =
        calculateSignalAgeSeconds(
            ordered
        );

    const signalAgeSeconds =
        rawAge === null ?
        null :
        Math.max(
            0,
            rawAge - 60
        );

    const dataAgeStatus =
        getDataAgeStatus(
            signalAgeSeconds
        );

    // ==================================================
    // SELECTED DIRECTION
    // ==================================================

    const diagnosticDirection =
        signal !== 'NO SIGNAL' ?
        signal :
        (
            upScore >= downScore ?
            'UP' :
            'DOWN'
        );

    const selectedContextScore =
        diagnosticDirection ===
        'DOWN' ?
        contextDown :
        contextUp;

    const selectedSetupScore =
        diagnosticDirection ===
        'DOWN' ?
        setupDown :
        setupUp;

    const selectedEntryScore =
        diagnosticDirection ===
        'DOWN' ?
        entryDown :
        entryUp;

    const selectedStrategyScore =
        diagnosticDirection ===
        'DOWN' ?
        strategyDown :
        strategyUp;

    // ==================================================
    // IMBALANCE
    // ==================================================

    const imbalanceQuality =
        signal !== 'NO SIGNAL' ?
        getBestImbalanceQuality(
            multiTimeframe,
            signal
        ) : {
            score: 0,
            timeframe: null,
            zone: null
        };

    const htfImbalanceConfluence =
        signal !== 'NO SIGNAL' ?
        calculateHtfImbalanceConfluence(
            multiTimeframe,
            signal
        ) :
        0;

    // ==================================================
    // NEW MODULE #1: ENTRY ZONE
    // ==================================================

    const entryZone =
        calculateEntryZoneEngine({
            signal,

            multiTimeframe,

            currentPrice,

            watchPrice,

            atrValue
        });

    // ==================================================
    // CLOSED CANDLE CONFIRMATION GATE — v4.9
    // ==================================================

    const candleConfirmation =
        analyzeCandleConfirmation({
            signal,
            m1: multiTimeframe.m1,
            m3: multiTimeframe.m3
        });

    // ==================================================
    // ENTRY ENGINE
    // ==================================================

    const entryEngine =
        calculateEntryEngine({
            signal,

            setupScore: selectedSetupScore,

            entryScore: selectedEntryScore,

            multiTimeframe,

            currentPrice,

            watchPrice,

            atrValue,

            signalAgeSeconds,

            candleAnalysis,

            imbalanceConfluence: htfImbalanceConfluence,

            sessionQuality: pairSession.quality,

            marketRegime: marketRegime.regime
        });

    // Closed 1M/3M candle confirmation is mandatory
    // before the Entry Engine may become TRADE.
    if (
        signal !== 'NO SIGNAL' &&
        !candleConfirmation.confirmed
    ) {
        entryEngine.status =
            candleConfirmation.hardOpposite ?
            'WAIT FOR CONFIRMATION' :
            'WAIT FOR CANDLE';

        entryEngine.color = 'YELLOW';
        entryEngine.reason = candleConfirmation.reason;
        entryEngine.details = {
            ...(entryEngine.details || {}),
            type: 'CLOSED CANDLE CONFIRMATION',
            timeframe: '1M / 3M',
            expectedDirection:
                signal === 'UP' ? 'BULLISH' : 'BEARISH',
            candleConfirmationScore:
                candleConfirmation.score,
            oppositeCandleScore:
                candleConfirmation.oppositeScore
        };
    }

    // ======================================================
    // HARD ENTRY ZONE BLOCK
    // ======================================================
    //
    // Entry Timing is NOT allowed to say ENTER NOW
    // when price is already outside the permitted
    // structural entry area.
    // ======================================================

    if (
        entryZone &&
        (
            entryZone.status ===
            'TOO LATE' ||
            entryZone.currentEntryQuality ===
            'WORST ENTRY / DO NOT ENTER'
        )
    ) {

        entryEngine.status =
            'TOO LATE';


        entryEngine.color =
            'RED';


        entryEngine.reason =
            entryZone.reason ||
            'Price is already beyond the allowed entry boundary';


        entryEngine.distanceAtr =
            entryZone.distanceToBestAtr !==
            undefined ?
            entryZone.distanceToBestAtr :
            entryEngine.distanceAtr;


        entryEngine.details = {

            ...(
                entryEngine.details || {}
            ),

            type: 'ENTRY ZONE BLOCK',

            timeframe: entryZone.timeframe ||
                null,

            targetPrice: entryZone.bestEntryPrice,

            zoneLow: entryZone.bestZoneLow,

            zoneHigh: entryZone.bestZoneHigh,

            lastAcceptablePrice: entryZone.lastAcceptablePrice,

            doNotChasePrice: entryZone.worstEntryPrice,

            currentPrice: currentPrice
        };
    }
    /*
        IMPORTANT:

        Old Entry Engine used only
        distance from watchPrice.

        Now Entry Zone Engine has priority
        when structural zone says
        trade is still acceptable.
    */

    if (
        entryEngine.status ===
        'MISSED' &&
        candleConfirmation.confirmed === true &&
        entryZone.available &&
        entryZone.status !==
        'TOO LATE'
    ) {
        entryEngine.status =
            entryZone.status ===
            'BEST ENTRY ZONE' ?
            'ENTER NOW' :
            'WAIT FOR RETEST';

        entryEngine.color =
            entryZone.status ===
            'BEST ENTRY ZONE' ?
            'GREEN' :
            'YELLOW';

        entryEngine.reason =
            entryZone.reason;

        entryEngine.details = {
            ...(
                entryEngine.details || {}
            ),

            type: 'STRUCTURAL ENTRY ZONE',

            targetPrice: entryZone.bestEntryPrice,

            zoneLow: entryZone.bestZoneLow,

            zoneHigh: entryZone.bestZoneHigh,

            lastAcceptablePrice: entryZone
                .lastAcceptablePrice
        };
    }

    // ==================================================
    // NEW MODULE #2: SIGNAL STRENGTH
    // ==================================================

    const signalStrength =
        calculateSignalStrength({
            signal,

            marketScore: score,

            setupScore: selectedSetupScore,

            entryScore: selectedEntryScore,

            strategyScore: selectedStrategyScore,

            sessionQuality: pairSession.quality,

            imbalanceQuality: imbalanceQuality.score,

            htfImbalanceConfluence,

            signalAgeSeconds,

            entryEngine,

            entryZone,

            multiTimeframe,

            currentPrice,

            atrValue,

            contextSetupConflict,

            marketRegime: marketRegime.regime
        });

    // ==================================================
    // EXPIRATION
    // ==================================================

    const expiration =
        signal !== 'NO SIGNAL' ?
        calculateExpirationEngine(
            symbol,
            ordered,
            signal,
            score,
            primaryStrategy,
            technical,
            marketRegime,
            multiTimeframe,
            pairSession,
            signalAgeSeconds
        ) : {
            available: false,

            recommendedMinutes: null,

            recommendedScore: 0,

            candidates: [],

            reason: 'No confirmed signal'
        };

    // ==================================================
    // TRADING STATUS
    // ==================================================

    let tradingStatus =
        'WAIT';

    let tradingColor =
        'RED';

    if (
        entryEngine.status ===
        'ENTER NOW'
    ) {
        tradingStatus =
            'TRADE';

        tradingColor =
            'GREEN';
    } else if (
        entryEngine.color ===
        'YELLOW'
    ) {
        tradingStatus =
            'CAUTION';

        tradingColor =
            'YELLOW';
    }

    // ==================================================
    // DIAGNOSTICS
    // ==================================================

    const bestDirection =
        upScore >= downScore ?
        'UP' :
        'DOWN';

    const bestDirectionScore =
        Math.max(
            upScore,
            downScore
        );

    const oppositeScore =
        Math.min(
            upScore,
            downScore
        );

    const actualEdge =
        Math.abs(
            upScore -
            downScore
        );

    const signalDiagnostics = {
        marketBias,

        signalStage,

        contextDirection,

        setupDirection,

        contextSetupConflict,

        contextSetupAligned,

        bestDirection,

        bestDirectionScore,

        oppositeScore,

        requiredScore:
            settings.minSignalScore,

        pairSafetyMinScore:
            pairSafetyMinScore,

        userMinScore:
            userMinScore,

        effectiveMinScore:
            effectiveMinScore,

        requiredEdge:
            settings.minEdge,

        actualEdge,

        blockers: []
    };

    if (
        contextSetupConflict
    ) {
        signalDiagnostics
            .blockers
            .push(
                `Context ${contextDirection} conflicts with Setup ${setupDirection}`
            );
    }

    if (
        bestDirectionScore <
        settings.minSignalScore
    ) {
        signalDiagnostics
            .blockers
            .push(
                `Signal score ${bestDirectionScore}/100 below required ${settings.minSignalScore}/100`
            );
    }

    if (
        actualEdge <
        settings.minEdge
    ) {
        signalDiagnostics
            .blockers
            .push(
                `Direction edge ${actualEdge} below required ${settings.minEdge}`
            );
    }

    if (
        multiTimeframe
        .layers
        .context
        .direction ===
        'NEUTRAL'
    ) {
        signalDiagnostics
            .blockers
            .push(
                '1H / 30M context is neutral'
            );
    }

    if (
        multiTimeframe
        .layers
        .setup
        .direction ===
        'NEUTRAL'
    ) {
        signalDiagnostics
            .blockers
            .push(
                '15M / 5M setup is neutral'
            );
    }

    if (
        signalAgeSeconds !== null &&
        signalAgeSeconds > 120
    ) {
        signalDiagnostics
            .blockers
            .push(
                'Market candle data is stale'
            );
    }

    // ==================================================
    // DEBUG
    // ==================================================

    console.log(
        'Signal Diagnostics:',
        signalDiagnostics
    );

    console.log(
        'UP Score:',
        upScore
    );

    console.log(
        'DOWN Score:',
        downScore
    );

    console.log(
        'Entry Zone:',
        entryZone
    );

    console.log(
        'Signal Strength:',
        signalStrength
    );

    // ==================================================
    // RESPONSE
    // ==================================================
    const tradePriority =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(
                    (Number(signalStrength.score) || 0) * 0.35 +
                    (Number(score) || 0) * 0.30 +
                    (Number(pairSession.quality) || 0) * 0.15 +
                    (
                        entryEngine &&
                        Number(entryEngine.qualityScore) ?
                        Number(entryEngine.qualityScore) :
                        0
                    ) * 0.20
                )
            )
        );

    return {
        signalDiagnostics,

        marketBias,

        signalStage,

        contextSetupConflict,

        symbol,

        signal,

        score,

        tradePriority,

        upScore,

        downScore,

        watchPrice,

        currentPrice,

        entry: watchPrice,

        scoreThreshold: {

            pairSafetyMinimum:
                pairSafetyMinScore,

            userMinimum:
                userMinScore,

            effectiveMinimum:
                effectiveMinScore,

            formula:
                'max(User Min Score, Pair Safety Minimum)'
        },


        scoreBreakdown: {
            calibrationVersion:
                'v4.7',

            weights: {
                context: Number(scoreWeights.context.toFixed(2)),
                setup: Number(scoreWeights.setup.toFixed(2)),
                entry: Number(scoreWeights.entry.toFixed(2)),
                strategy: Number(scoreWeights.strategy.toFixed(2)),
                session: Number(scoreWeights.session.toFixed(2))
            },

            context: selectedContextScore,

            setup: selectedSetupScore,

            entry: selectedEntryScore,

            strategy: selectedStrategyScore,

            session: sessionScore,

            bullish: {
                context: contextUp,

                setup: setupUp,

                entry: entryUp,

                strategy: strategyUp
            },

            bearish: {
                context: contextDown,

                setup: setupDown,

                entry: entryDown,

                strategy: strategyDown
            },

            qualityAdjustment:
                signal ===
                    'UP'
                    ?
                    upScoreAdjustment
                    :
                    signal ===
                        'DOWN'
                        ?
                        downScoreAdjustment
                        :
                        (
                            upScore >=
                            downScore
                                ?
                                upScoreAdjustment
                                :
                                downScoreAdjustment
                        ),

            regimePenalty:
                regimePenalty,

            rawDirectionalScores: {
                up:
                    round(
                        rawUpScore,
                        2
                    ),

                down:
                    round(
                        rawDownScore,
                        2
                    )
            },

            entryTiming: {
                upScore:
                    entryUp,

                downScore:
                    entryDown,

                selectedScore:
                    selectedEntryScore,

                note:
                    'Closed-candle entry quality is integrated into v4.7 market score'
            }
        },

        signalAge: {
            seconds: signalAgeSeconds,

            status: dataAgeStatus
        },

        // OLD ENTRY ENGINE
        entryEngine,

        // NEW MODULE #1
        entryZone,

        // NEW MODULE #2
        signalStrength,

        imbalanceQuality,

        htfImbalanceConfluence,

        recommendedExpiration: expiration.available ?
            expiration
            .recommendedMinutes : null,

        expiration,

        tradingSuitability: {
            status: tradingStatus,

            color: tradingColor,

            message: entryEngine.reason,

            sessionQuality: pairSession.quality,

            montrealTime: pairSession.montrealTime
        },

        strategies: strategyEngine,

        primaryStrategy: primaryStrategy ? {
            name: primaryStrategy.name,

            direction: primaryStrategy.direction,

            confidence: primaryStrategy.confidence,

            reasons: primaryStrategy.reasons
        } : null,

        strategyMatches: matchingStrategies.map(
            strategy => ({
                name: strategy.name,

                direction: strategy.direction,

                confidence: strategy.confidence
            })
        ),

        multiTimeframe,

        candlestick: candleAnalysis,

        candleConfirmation,

        marketRegime,

        pairSession,

        newsRisk,

        confirmation: {
            usesClosedCandles: true,

            candleCloseRequired: true
        },

        horizon: '-',

        horizons: [],

        note: 'Paper-analysis only. Score is setup-quality, not win probability.'
    };
}


// ======================================================
// EXPORT
// ======================================================



module.exports = {
    combinedAnalysis
};