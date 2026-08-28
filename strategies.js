const {
    clamp,
    num,
    candleStats
} = require('./utils');

const {
    atr
} = require('./indicators');

const {
    detectStructure,
    detectImbalances
} = require('./smc');

const {
    getPairSettings
} = require('./config');


// ======================================================
// STRATEGY HELPERS
// ======================================================

function emptyStrategy(
    name
) {
    return {
        name,

        active: false,

        direction: 'NONE',

        scoreUp: 0,

        scoreDown: 0,

        confidence: 0,

        reasons: []
    };
}


function finalizeStrategy(
    strategy
) {
    strategy.scoreUp =
        clamp(
            Math.round(
                strategy.scoreUp ||
                0
            ),
            0,
            100
        );

    strategy.scoreDown =
        clamp(
            Math.round(
                strategy.scoreDown ||
                0
            ),
            0,
            100
        );

    if (
        strategy.scoreUp >
        strategy.scoreDown &&
        strategy.scoreUp >= 35
    ) {
        strategy.direction =
            'UP';

        strategy.active =
            true;
    } else if (
        strategy.scoreDown >
        strategy.scoreUp &&
        strategy.scoreDown >= 35
    ) {
        strategy.direction =
            'DOWN';

        strategy.active =
            true;
    } else {
        strategy.direction =
            'NONE';

        strategy.active =
            false;
    }

    strategy.confidence =
        Math.max(
            strategy.scoreUp,
            strategy.scoreDown
        );

    return strategy;
}


function latestClosedPrice(
    candles
) {
    if (!candles ||
        !candles.length
    ) {
        return null;
    }

    return num(
        candles[
            candles.length - 1
        ].close
    );
}


// ======================================================
// 1 — TREND CONTINUATION
// ======================================================

function strategyTrendContinuation(
    candles,
    technical,
    structure
) {
    const result =
        emptyStrategy(
            'Trend continuation'
        );

    if (!technical ||
        !structure ||
        !candles ||
        candles.length < 60
    ) {
        return result;
    }

    const price =
        latestClosedPrice(
            candles
        );


    if (
        technical.ema9 >
        technical.ema21 &&
        technical.ema21 >
        technical.ema50
    ) {
        result.scoreUp +=
            35;

        result.reasons.push(
            'EMA 9/21/50 bullish alignment'
        );
    }


    if (
        technical.ema9 <
        technical.ema21 &&
        technical.ema21 <
        technical.ema50
    ) {
        result.scoreDown +=
            35;

        result.reasons.push(
            'EMA 9/21/50 bearish alignment'
        );
    }


    if (
        structure.trend ===
        'BULLISH'
    ) {
        result.scoreUp +=
            25;

        result.reasons.push(
            'Bullish market structure'
        );
    }


    if (
        structure.trend ===
        'BEARISH'
    ) {
        result.scoreDown +=
            25;

        result.reasons.push(
            'Bearish market structure'
        );
    }


    if (
        technical.macdHistogram !==
        null &&
        technical.macdHistogram >
        0
    ) {
        result.scoreUp +=
            15;
    }


    if (
        technical.macdHistogram !==
        null &&
        technical.macdHistogram <
        0
    ) {
        result.scoreDown +=
            15;
    }


    if (
        price !== null &&
        technical.ema21 !== null
    ) {
        if (
            price >
            technical.ema21
        ) {
            result.scoreUp +=
                10;
        }

        if (
            price <
            technical.ema21
        ) {
            result.scoreDown +=
                10;
        }
    }

    return finalizeStrategy(
        result
    );
}


// ======================================================
// 2 — SUPPORT / RESISTANCE RETEST
// ======================================================

function strategyLevelRetest(
    candles,
    structure,
    settings
) {
    const result =
        emptyStrategy(
            'Support / resistance retest'
        );

    if (!candles ||
        candles.length < 30 ||
        !structure
    ) {
        return result;
    }

    const latest =
        candles[
            candles.length - 1
        ];

    const stats =
        candleStats(
            latest
        );

    const atrValue =
        atr(
            candles,
            14
        );

    if (!atrValue) {
        return result;
    }

    const close =
        num(
            latest.close
        );

    const low =
        num(
            latest.low
        );

    const high =
        num(
            latest.high
        );

    const tolerance =
        atrValue *
        settings
        .retestAtrTolerance;


    if (
        structure.swingHigh !==
        null
    ) {
        const nearHigh =
            Math.abs(
                close -
                structure.swingHigh
            ) <=
            tolerance ||
            (
                high >=
                structure.swingHigh -
                tolerance &&
                high <=
                structure.swingHigh +
                tolerance
            );

        if (
            nearHigh &&
            stats.bearish
        ) {
            result.scoreDown +=
                45;

            result.reasons.push(
                'Bearish retest/rejection near resistance'
            );

            if (
                stats.upperWickRatio >=
                0.35
            ) {
                result.scoreDown +=
                    20;

                result.reasons.push(
                    'Upper-wick rejection'
                );
            }
        }


        if (
            close >
            structure.swingHigh &&
            low <=
            structure.swingHigh +
            tolerance
        ) {
            result.scoreUp +=
                55;

            result.reasons.push(
                'Broken resistance retested as support'
            );
        }
    }


    if (
        structure.swingLow !==
        null
    ) {
        const nearLow =
            Math.abs(
                close -
                structure.swingLow
            ) <=
            tolerance ||
            (
                low <=
                structure.swingLow +
                tolerance &&
                low >=
                structure.swingLow -
                tolerance
            );

        if (
            nearLow &&
            stats.bullish
        ) {
            result.scoreUp +=
                45;

            result.reasons.push(
                'Bullish retest/rejection near support'
            );

            if (
                stats.lowerWickRatio >=
                0.35
            ) {
                result.scoreUp +=
                    20;

                result.reasons.push(
                    'Lower-wick rejection'
                );
            }
        }


        if (
            close <
            structure.swingLow &&
            high >=
            structure.swingLow -
            tolerance
        ) {
            result.scoreDown +=
                55;

            result.reasons.push(
                'Broken support retested as resistance'
            );
        }
    }

    return finalizeStrategy(
        result
    );
}


// ======================================================
// 3 — CONFIRMED BREAKOUT
// ======================================================

function strategyBreakout(
    candles,
    structure,
    settings
) {
    const result =
        emptyStrategy(
            'Confirmed breakout'
        );

    if (!candles ||
        candles.length < 30 ||
        !structure
    ) {
        return result;
    }

    const latest =
        candles[
            candles.length - 1
        ];

    const previous =
        candles[
            candles.length - 2
        ];

    const stats =
        candleStats(
            latest
        );

    const atrValue =
        atr(
            candles,
            14
        );

    if (!atrValue) {
        return result;
    }

    const close =
        num(
            latest.close
        );

    const previousClose =
        num(
            previous.close
        );

    const buffer =
        atrValue *
        settings
        .breakoutAtrBuffer;


    if (
        structure.swingHigh !==
        null &&
        close >
        structure.swingHigh +
        buffer &&
        previousClose <=
        structure.swingHigh +
        buffer
    ) {
        result.scoreUp +=
            55;

        result.reasons.push(
            'Closed candle confirmed breakout above resistance'
        );

        if (
            stats.bullish &&
            stats.bodyRatio >=
            0.55
        ) {
            result.scoreUp +=
                20;

            result.reasons.push(
                'Strong bullish breakout candle'
            );
        }
    }


    if (
        structure.swingLow !==
        null &&
        close <
        structure.swingLow -
        buffer &&
        previousClose >=
        structure.swingLow -
        buffer
    ) {
        result.scoreDown +=
            55;

        result.reasons.push(
            'Closed candle confirmed breakout below support'
        );

        if (
            stats.bearish &&
            stats.bodyRatio >=
            0.55
        ) {
            result.scoreDown +=
                20;

            result.reasons.push(
                'Strong bearish breakout candle'
            );
        }
    }

    return finalizeStrategy(
        result
    );
}


// ======================================================
// 4 — PRICE ACTION
// ======================================================

function strategyPriceAction(
    candleAnalysis,
    smc
) {
    const result =
        emptyStrategy(
            'Price action'
        );

    if (!candleAnalysis) {
        return result;
    }

    result.scoreUp +=
        candleAnalysis
        .scoreUp *
        0.65;

    result.scoreDown +=
        candleAnalysis
        .scoreDown *
        0.65;


    if (
        smc &&
        smc.liquiditySweep
    ) {
        if (
            smc
            .liquiditySweep
            .bullishSweep
        ) {
            result.scoreUp +=
                25;

            result.reasons.push(
                'Sell-side liquidity sweep'
            );
        }


        if (
            smc
            .liquiditySweep
            .bearishSweep
        ) {
            result.scoreDown +=
                25;

            result.reasons.push(
                'Buy-side liquidity sweep'
            );
        }
    }

    result.reasons =
        result.reasons.concat(
            candleAnalysis.patterns || []
        );

    return finalizeStrategy(
        result
    );
}


// ======================================================
// 5 — IMBALANCE RETEST
// ======================================================

function strategyImbalanceRetest(
    candles
) {
    const result =
        emptyStrategy(
            'Imbalance retest'
        );

    if (!candles ||
        candles.length < 30
    ) {
        return result;
    }

    const imbalance =
        detectImbalances(
            candles
        );

    const latest =
        candles[
            candles.length - 1
        ];

    const previous =
        candles[
            candles.length - 2
        ];

    const latestStats =
        candleStats(
            latest
        );

    const close =
        num(
            latest.close
        );

    const high =
        num(
            latest.high
        );

    const low =
        num(
            latest.low
        );

    const previousClose =
        num(
            previous.close
        );

    const atrValue =
        atr(
            candles,
            14
        );

    if (!atrValue) {
        return result;
    }


    // ==================================================
    // BULLISH FVG RETEST
    // ==================================================

    const bullishZone =
        imbalance
        .nearestBullish;

    if (
        bullishZone &&
        !bullishZone.filled
    ) {
        const enteredZone =
            low <=
            bullishZone.zoneHigh &&
            high >=
            bullishZone.zoneLow;

        if (
            enteredZone
        ) {
            result.scoreUp +=
                35;

            result.reasons.push(
                'Price entered bullish imbalance'
            );


            if (
                bullishZone.status ===
                'UNTOUCHED'
            ) {
                result.scoreUp +=
                    10;

                result.reasons.push(
                    'First mitigation of bullish imbalance'
                );
            }


            if (
                latestStats.bullish
            ) {
                result.scoreUp +=
                    15;

                result.reasons.push(
                    'Bullish candle confirmation inside imbalance'
                );
            }


            if (
                latestStats
                .lowerWickRatio >=
                0.30
            ) {
                result.scoreUp +=
                    15;

                result.reasons.push(
                    'Bullish rejection from imbalance'
                );
            }


            if (
                close >
                bullishZone.zoneHigh
            ) {
                result.scoreUp +=
                    15;

                result.reasons.push(
                    'Closed candle reclaimed bullish imbalance'
                );
            }


            if (
                bullishZone
                .atrRatio >=
                0.20
            ) {
                result.scoreUp +=
                    5;
            }
        }


        const distance =
            Math.abs(
                close -
                bullishZone.zoneHigh
            );

        if (
            distance <=
            atrValue *
            0.15 &&
            close >
            bullishZone.zoneHigh &&
            latestStats.bullish
        ) {
            result.scoreUp +=
                25;

            result.reasons.push(
                'Bullish reaction above nearby imbalance'
            );
        }
    }


    // ==================================================
    // BEARISH FVG RETEST
    // ==================================================

    const bearishZone =
        imbalance
        .nearestBearish;

    if (
        bearishZone &&
        !bearishZone.filled
    ) {
        const enteredZone =
            high >=
            bearishZone.zoneLow &&
            low <=
            bearishZone.zoneHigh;

        if (
            enteredZone
        ) {
            result.scoreDown +=
                35;

            result.reasons.push(
                'Price entered bearish imbalance'
            );


            if (
                bearishZone.status ===
                'UNTOUCHED'
            ) {
                result.scoreDown +=
                    10;

                result.reasons.push(
                    'First mitigation of bearish imbalance'
                );
            }


            if (
                latestStats.bearish
            ) {
                result.scoreDown +=
                    15;

                result.reasons.push(
                    'Bearish candle confirmation inside imbalance'
                );
            }


            if (
                latestStats
                .upperWickRatio >=
                0.30
            ) {
                result.scoreDown +=
                    15;

                result.reasons.push(
                    'Bearish rejection from imbalance'
                );
            }


            if (
                close <
                bearishZone.zoneLow
            ) {
                result.scoreDown +=
                    15;

                result.reasons.push(
                    'Closed candle rejected bearish imbalance'
                );
            }


            if (
                bearishZone
                .atrRatio >=
                0.20
            ) {
                result.scoreDown +=
                    5;
            }
        }


        const distance =
            Math.abs(
                close -
                bearishZone.zoneLow
            );

        if (
            distance <=
            atrValue *
            0.15 &&
            close <
            bearishZone.zoneLow &&
            latestStats.bearish
        ) {
            result.scoreDown +=
                25;

            result.reasons.push(
                'Bearish reaction below nearby imbalance'
            );
        }
    }


    // ==================================================
    // OLD ZONE PENALTY
    // ==================================================

    if (
        bullishZone &&
        bullishZone.status ===
        'MITIGATED' &&
        previousClose <
        bullishZone.zoneLow
    ) {
        result.scoreUp -=
            15;
    }


    if (
        bearishZone &&
        bearishZone.status ===
        'MITIGATED' &&
        previousClose >
        bearishZone.zoneHigh
    ) {
        result.scoreDown -=
            15;
    }

    return finalizeStrategy(
        result
    );
}


// ======================================================
// STRATEGY ENGINE
// ======================================================

function analyzeStrategies(
    symbol,
    candles,
    technical,
    candleAnalysis,
    smc
) {
    const settings =
        getPairSettings(
            symbol
        );

    const structure =
        smc ?
        smc.structure :
        detectStructure(
            candles
        );

    const strategies = [
        strategyTrendContinuation(
            candles,
            technical,
            structure
        ),

        strategyLevelRetest(
            candles,
            structure,
            settings
        ),

        strategyBreakout(
            candles,
            structure,
            settings
        ),

        strategyPriceAction(
            candleAnalysis,
            smc
        ),

        strategyImbalanceRetest(
            candles
        )
    ];


    let up = 0;
    let down = 0;

    let activeCount = 0;
    let bullishCount = 0;
    let bearishCount = 0;


    for (
        const strategy
        of strategies
    ) {
        if (!strategy.active) {
            continue;
        }

        activeCount++;


        if (
            strategy.direction ===
            'UP'
        ) {
            bullishCount++;

            up +=
                strategy.confidence;
        }


        if (
            strategy.direction ===
            'DOWN'
        ) {
            bearishCount++;

            down +=
                strategy.confidence;
        }
    }


    const divisor =
        Math.max(
            activeCount,
            1
        );


    return {
        strategies,

        activeCount,

        bullishCount,

        bearishCount,

        scoreUp: clamp(
            Math.round(
                up /
                divisor
            ),
            0,
            100
        ),

        scoreDown: clamp(
            Math.round(
                down /
                divisor
            ),
            0,
            100
        )
    };
}


module.exports = {
    strategyTrendContinuation,
    strategyLevelRetest,
    strategyBreakout,
    strategyPriceAction,
    strategyImbalanceRetest,
    analyzeStrategies
};