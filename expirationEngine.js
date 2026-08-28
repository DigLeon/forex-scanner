const {
    num,
    clamp,
    round
} = require('./utils');

const {
    atr
} = require('./indicators');


// ======================================================
// AVERAGE CANDLE RANGE
// ======================================================

function averageCandleRange(
    candles,
    period = 20
) {
    if (!candles ||
        !candles.length
    ) {
        return 0;
    }

    const recent =
        candles.slice(-period);

    if (!recent.length) {
        return 0;
    }

    return (
        recent.reduce(
            (
                sum,
                candle
            ) =>
            sum +
            Math.abs(
                num(candle.high) -
                num(candle.low)
            ),
            0
        ) /
        recent.length
    );
}


// ======================================================
// STRATEGY -> DEFAULT TIME WINDOW
// ======================================================

function getStrategyPreferredExpiration(
    strategyName
) {
    switch (
        strategyName
    ) {

        case 'Confirmed breakout':
            return {
                min: 15,
                ideal: 18,
                max: 24
            };

        case 'Price action':
            return {
                min: 15,
                ideal: 18,
                max: 22
            };

        case 'Trend continuation':
            return {
                min: 18,
                ideal: 22,
                max: 30
            };

        case 'Support / resistance retest':
            return {
                min: 18,
                ideal: 22,
                max: 30
            };

        case 'Imbalance retest':
            return {
                min: 18,
                ideal: 22,
                max: 30
            };

        default:
            return {
                min: 15,
                ideal: 20,
                max: 28
            };
    }
}


// ======================================================
// MTF SUPPORT
// ======================================================

function getMTFDirectionScore(
    signal,
    multiTimeframe
) {
    if (!multiTimeframe ||
        !signal
    ) {
        return 0;
    }

    const expected =
        signal === 'UP' ?
        'BULLISH' :
        'BEARISH';

    let score = 0;

    const layers =
        multiTimeframe.layers;

    if (!layers) {
        return 0;
    }


    if (
        layers.context &&
        layers.context.direction ===
        expected
    ) {
        score += 10;
    }


    if (
        layers.setup &&
        layers.setup.direction ===
        expected
    ) {
        score += 10;
    }


    if (
        layers.entry &&
        layers.entry.direction ===
        expected
    ) {
        score += 10;
    }


    return score;
}


// ======================================================
// EXPIRATION ENGINE
//
// Dynamic paper-analysis horizon based on:
// - strategy
// - data freshness
// - setup quality
// - momentum / ATR
// - volatility
// - MTF agreement
// - session quality
//
// This score is NOT win probability.
// ======================================================

function calculateExpirationEngine(
    symbol,
    candles,
    signal,
    setupScore,
    primaryStrategy,
    technical,
    marketRegime,
    multiTimeframe,
    pairSession,
    dataAgeSeconds
) {

    // ==================================================
    // BASIC VALIDATION
    // ==================================================

    if (!candles ||
        candles.length < 30 ||
        !signal ||
        signal === 'NO SIGNAL'
    ) {
        return {
            available: false,

            recommendedMinutes: null,

            recommendedScore: 0,

            candidates: [],

            dataAgeStatus: 'UNKNOWN',

            dataAgeSeconds: Number.isFinite(
                    Number(
                        dataAgeSeconds
                    )
                ) ?
                Number(
                    dataAgeSeconds
                ) :
                null,

            reason: 'No confirmed signal'
        };
    }


    // ==================================================
    // DATA AGE STATUS
    //
    // FRESH   0-30 sec
    // ACTIVE 31-60 sec
    // LATE   61-120 sec
    // STALE   >120 sec
    // ==================================================

    let dataAgeStatus =
        'UNKNOWN';


    const normalizedDataAge =
        Number.isFinite(
            Number(
                dataAgeSeconds
            )
        ) ?
        Number(
            dataAgeSeconds
        ) :
        null;


    if (
        normalizedDataAge !==
        null
    ) {

        if (
            normalizedDataAge <= 30
        ) {
            dataAgeStatus =
                'FRESH';
        } else if (
            normalizedDataAge <= 60
        ) {
            dataAgeStatus =
                'ACTIVE';
        } else if (
            normalizedDataAge <= 120
        ) {
            dataAgeStatus =
                'LATE';
        } else {
            dataAgeStatus =
                'STALE';
        }
    }


    // ==================================================
    // STALE DATA
    // ==================================================

    if (
        dataAgeStatus ===
        'STALE'
    ) {
        return {
            available: false,

            recommendedMinutes: null,

            recommendedScore: 0,

            candidates: [],

            dataAgeStatus,

            dataAgeSeconds: normalizedDataAge,

            reason: 'Market data is stale'
        };
    }


    // ==================================================
    // STRATEGY
    // ==================================================

    const strategyName =
        primaryStrategy &&
        primaryStrategy.name ?
        primaryStrategy.name :
        'Unknown';


    const preferred =
        getStrategyPreferredExpiration(
            strategyName
        );


    // ==================================================
    // ATR
    // ==================================================

    const atrValue =
        atr(
            candles,
            14
        ) || 0;


    // ==================================================
    // AVERAGE RANGE
    // ==================================================

    const averageRange =
        averageCandleRange(
            candles,
            20
        );


    // ==================================================
    // LATEST PRICE
    // ==================================================

    const latestPrice =
        num(
            candles[
                candles.length - 1
            ].close
        );


    // ==================================================
    // ATR %
    // ==================================================

    const atrPct =
        latestPrice &&
        atrValue ?
        (
            atrValue /
            latestPrice
        ) *
        100 :
        0;


    // ==================================================
    // RANGE / ATR
    // ==================================================

    const rangeAtrRatio =
        atrValue ?
        averageRange /
        atrValue :
        0;


    // ==================================================
    // MOMENTUM / ATR
    // ==================================================

    const momentumAtrRatio =
        technical &&
        atrValue ?
        Math.abs(
            technical.momentum ||
            0
        ) /
        atrValue :
        0;


    // ==================================================
    // MULTI TIMEFRAME SCORE
    // ==================================================

    const mtfScore =
        getMTFDirectionScore(
            signal,
            multiTimeframe
        );


    // ==================================================
    // EXPIRATION RANGE BASED ON DATA FRESHNESS
    //
    // FRESH   ->  8-22 min
    // ACTIVE  -> 10-25 min
    // LATE    -> 15-30 min
    // UNKNOWN -> 15-30 min
    // ==================================================

    let minExpiration =
        15;

    let maxExpiration =
        30;


    if (
        dataAgeStatus ===
        'FRESH'
    ) {
        minExpiration =
            8;

        maxExpiration =
            22;
    } else if (
        dataAgeStatus ===
        'ACTIVE'
    ) {
        minExpiration =
            10;

        maxExpiration =
            25;
    } else if (
        dataAgeStatus ===
        'LATE'
    ) {
        minExpiration =
            15;

        maxExpiration =
            30;
    }


    // ==================================================
    // CANDIDATES
    // ==================================================

    const candidates = [];


    // ==================================================
    // TEST EVERY EXPIRATION
    // ==================================================

    for (
        let minutes =
            minExpiration;

        minutes <=
        maxExpiration;

        minutes++
    ) {

        let score =
            50;


        const reasons = [];


        // ==============================================
        // DATA FRESHNESS
        // ==============================================

        if (
            dataAgeStatus ===
            'FRESH'
        ) {

            if (
                minutes >= 8 &&
                minutes <= 15
            ) {
                score +=
                    5;

                reasons.push(
                    'Fresh data supports shorter horizon'
                );
            }
        }


        if (
            dataAgeStatus ===
            'ACTIVE'
        ) {

            if (
                minutes >= 12 &&
                minutes <= 20
            ) {
                score +=
                    3;

                reasons.push(
                    'Active data supports medium horizon'
                );
            }
        }


        if (
            dataAgeStatus ===
            'LATE'
        ) {

            if (
                minutes >= 18
            ) {
                score +=
                    4;

                reasons.push(
                    'Delayed data favors longer horizon'
                );
            }
        }


        // ==============================================
        // STRATEGY
        // ==============================================

        const distanceFromIdeal =
            Math.abs(
                minutes -
                preferred.ideal
            );


        score -=
            distanceFromIdeal *
            5;


        if (
            minutes >=
            preferred.min &&
            minutes <=
            preferred.max
        ) {

            score +=
                14;


            reasons.push(
                `Good horizon for ${strategyName}`
            );
        } else {

            score -=
                10;
        }


        // ==============================================
        // SETUP SCORE
        // ==============================================

        if (
            setupScore >= 90
        ) {

            score +=
                8;


            reasons.push(
                'Very strong setup'
            );
        } else if (
            setupScore >= 80
        ) {

            score +=
                5;


            reasons.push(
                'Strong setup'
            );
        } else if (
            setupScore < 70
        ) {

            score -=
                8;
        }


        // ==============================================
        // MOMENTUM
        // ==============================================

        if (
            momentumAtrRatio >=
            1.20
        ) {

            if (
                minutes >= 12 &&
                minutes <= 20
            ) {

                score +=
                    10;


                reasons.push(
                    'Strong momentum supports shorter side of range'
                );
            }


            if (
                minutes >= 27
            ) {

                score -=
                    5;
            }
        } else if (
            momentumAtrRatio >=
            0.60
        ) {

            if (
                minutes >= 16 &&
                minutes <= 24
            ) {

                score +=
                    8;


                reasons.push(
                    'Normal momentum supports medium expiration'
                );
            }
        } else {

            if (
                minutes >= 22
            ) {

                score +=
                    8;


                reasons.push(
                    'Slow movement needs more time'
                );
            }


            if (
                minutes <= 12
            ) {

                score -=
                    7;
            }
        }


        // ==============================================
        // HIGH VOLATILITY
        // ==============================================

        if (
            marketRegime &&
            marketRegime.regime ===
            'HIGH VOLATILITY'
        ) {

            if (
                minutes >= 12 &&
                minutes <= 20
            ) {

                score +=
                    7;


                reasons.push(
                    'High volatility supports shorter expiration'
                );
            }


            if (
                minutes >= 28
            ) {

                score -=
                    5;
            }
        }


        // ==============================================
        // LOW VOLATILITY
        // ==============================================

        if (
            marketRegime &&
            marketRegime.regime ===
            'LOW VOLATILITY'
        ) {

            if (
                minutes >= 23
            ) {

                score +=
                    7;


                reasons.push(
                    'Low volatility needs longer expiration'
                );
            }


            if (
                minutes <= 12
            ) {

                score -=
                    8;
            }
        }


        // ==============================================
        // MULTI TIMEFRAME
        // ==============================================

        if (
            mtfScore >= 30
        ) {

            score +=
                10;


            reasons.push(
                'Full MTF agreement'
            );
        } else if (
            mtfScore >= 20
        ) {

            score +=
                6;


            reasons.push(
                'Good MTF agreement'
            );
        }


        // ==============================================
        // SESSION QUALITY
        // ==============================================

        if (
            pairSession
        ) {

            if (
                pairSession.quality >= 85
            ) {

                score +=
                    8;


                reasons.push(
                    'Best trading session'
                );
            } else if (
                pairSession.quality >= 65
            ) {

                score +=
                    3;
            } else {

                score -=
                    15;


                reasons.push(
                    'Quiet session'
                );
            }
        }


        // ==============================================
        // RANGE VS ATR
        //
        // Strong candle range + fresh data can support
        // shorter paper horizon.
        // ==============================================

        if (
            rangeAtrRatio >= 0.85 &&
            (
                dataAgeStatus ===
                'FRESH' ||
                dataAgeStatus ===
                'ACTIVE'
            ) &&
            minutes <= 15
        ) {

            score +=
                5;


            reasons.push(
                'Healthy candle range supports shorter horizon'
            );
        }


        // ==============================================
        // EXTREMELY LOW ATR
        // ==============================================

        if (
            atrPct > 0 &&
            atrPct < 0.015
        ) {

            if (
                minutes <= 12
            ) {

                score -=
                    8;
            }


            if (
                minutes >= 18
            ) {

                score +=
                    4;


                reasons.push(
                    'Very low ATR favors longer horizon'
                );
            }
        }


        // ==============================================
        // FINAL SCORE
        // ==============================================

        score =
            clamp(
                Math.round(
                    score
                ),
                0,
                100
            );


        // ==============================================
        // SAVE CANDIDATE
        // ==============================================

        candidates.push({
            minutes,
            score,
            reasons
        });
    }


    // ==================================================
    // SORT BEST FIRST
    // ==================================================

    candidates.sort(
        (
            a,
            b
        ) =>
        b.score -
        a.score
    );


    const best =
        candidates[0];


    // ==================================================
    // SAFETY
    // ==================================================

    if (!best) {

        return {
            available: false,

            recommendedMinutes: null,

            recommendedScore: 0,

            candidates: [],

            dataAgeStatus,

            dataAgeSeconds: normalizedDataAge,

            reason: 'No valid expiration candidate'
        };
    }


    // ==================================================
    // RESPONSE
    // ==================================================

    return {

        available: true,


        recommendedMinutes: best.minutes,


        recommendedScore: best.score,


        strategy: strategyName,


        symbol,


        // ==============================================
        // DATA FRESHNESS
        // ==============================================

        dataAgeStatus,

        dataAgeSeconds: normalizedDataAge,


        // ==============================================
        // SELECTED SEARCH RANGE
        // ==============================================

        minExpiration,

        maxExpiration,


        // ==============================================
        // MARKET METRICS
        // ==============================================

        atr: round(
            atrValue,
            6
        ),


        atrPct: round(
            atrPct,
            4
        ),


        rangeAtrRatio: round(
            rangeAtrRatio,
            2
        ),


        momentumAtrRatio: round(
            momentumAtrRatio,
            2
        ),


        mtfScore,


        sessionQuality: pairSession ?
            pairSession.quality :
            0,


        // ==============================================
        // ALL TESTED EXPIRATIONS
        // ==============================================

        candidates,


        reason: 'Paper-analysis horizon selected from strategy, market conditions and data freshness'
    };
}


// ======================================================
// EXPORT
// ======================================================

module.exports = {
    calculateExpirationEngine
};