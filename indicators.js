const {
    num,
    clamp,
    round
} = require('./utils');


function sma(
    values,
    period
) {
    if (!values ||
        values.length < period
    ) {
        return null;
    }

    const slice =
        values.slice(-period);

    return (
        slice.reduce(
            (
                sum,
                value
            ) =>
            sum + value,
            0
        ) /
        period
    );
}


function ema(
    values,
    period
) {
    if (!values ||
        values.length < period
    ) {
        return null;
    }

    const k =
        2 /
        (
            period + 1
        );

    let result =
        values
        .slice(
            0,
            period
        )
        .reduce(
            (
                sum,
                value
            ) =>
            sum + value,
            0
        ) /
        period;

    for (
        let i = period; i < values.length; i++
    ) {
        result =
            values[i] *
            k +
            result *
            (
                1 - k
            );
    }

    return result;
}


function emaSeries(
    values,
    period
) {
    if (!values ||
        values.length < period
    ) {
        return [];
    }

    const k =
        2 /
        (
            period + 1
        );

    let previous =
        values
        .slice(
            0,
            period
        )
        .reduce(
            (
                sum,
                value
            ) =>
            sum + value,
            0
        ) /
        period;

    const result = [
        previous
    ];

    for (
        let i = period; i < values.length; i++
    ) {
        previous =
            values[i] *
            k +
            previous *
            (
                1 - k
            );

        result.push(
            previous
        );
    }

    return result;
}


function rsi(
    values,
    period = 14
) {
    if (!values ||
        values.length <= period
    ) {
        return null;
    }

    let gains = 0;
    let losses = 0;

    for (
        let i = 1; i <= period; i++
    ) {
        const diff =
            values[i] -
            values[i - 1];

        if (
            diff >= 0
        ) {
            gains += diff;
        } else {
            losses +=
                Math.abs(
                    diff
                );
        }
    }

    let avgGain =
        gains /
        period;

    let avgLoss =
        losses /
        period;

    for (
        let i =
            period + 1; i < values.length; i++
    ) {
        const diff =
            values[i] -
            values[i - 1];

        avgGain =
            (
                avgGain *
                (
                    period - 1
                ) +
                (
                    diff > 0 ?
                    diff :
                    0
                )
            ) /
            period;

        avgLoss =
            (
                avgLoss *
                (
                    period - 1
                ) +
                (
                    diff < 0 ?
                    Math.abs(
                        diff
                    ) :
                    0
                )
            ) /
            period;
    }

    if (
        avgLoss === 0
    ) {
        return 100;
    }

    const rs =
        avgGain /
        avgLoss;

    return (
        100 -
        100 /
        (
            1 + rs
        )
    );
}


function macd(
    values
) {
    if (!values ||
        values.length < 40
    ) {
        return null;
    }

    const ema12 =
        emaSeries(
            values,
            12
        );

    const ema26 =
        emaSeries(
            values,
            26
        );

    const offset =
        ema12.length -
        ema26.length;

    const line = [];

    for (
        let i = 0; i < ema26.length; i++
    ) {
        line.push(
            ema12[
                i + offset
            ] -
            ema26[i]
        );
    }

    const signal =
        ema(
            line,
            9
        );

    if (
        signal === null
    ) {
        return null;
    }

    const current =
        line[
            line.length - 1
        ];

    return {
        macd: current,

        signal: signal,

        histogram: current -
            signal
    };
}


function stddev(
    values,
    period
) {
    if (!values ||
        values.length < period
    ) {
        return null;
    }

    const slice =
        values.slice(-period);

    const mean =
        slice.reduce(
            (
                sum,
                value
            ) =>
            sum + value,
            0
        ) /
        period;

    const variance =
        slice.reduce(
            (
                sum,
                value
            ) =>
            sum +
            Math.pow(
                value - mean,
                2
            ),
            0
        ) /
        period;

    return Math.sqrt(
        variance
    );
}


function bollinger(
    values,
    period = 20,
    multiplier = 2
) {
    const middle =
        sma(
            values,
            period
        );

    const deviation =
        stddev(
            values,
            period
        );

    if (
        middle === null ||
        deviation === null
    ) {
        return null;
    }

    return {
        middle: middle,

        upper: middle +
            multiplier *
            deviation,

        lower: middle -
            multiplier *
            deviation
    };
}


function trueRange(
    candle,
    previousClose
) {
    const high =
        num(
            candle.high
        );

    const low =
        num(
            candle.low
        );

    if (
        previousClose === null
    ) {
        return (
            high - low
        );
    }

    return Math.max(
        high - low,

        Math.abs(
            high -
            previousClose
        ),

        Math.abs(
            low -
            previousClose
        )
    );
}


function atr(
    candles,
    period = 14
) {
    if (!candles ||
        candles.length <= period
    ) {
        return null;
    }

    const ranges =
        candles.map(
            (
                candle,
                index
            ) =>
            trueRange(
                candle,

                index > 0 ?
                num(
                    candles[
                        index - 1
                    ].close
                ) :
                null
            )
        );

    let result =
        ranges
        .slice(
            0,
            period
        )
        .reduce(
            (
                sum,
                value
            ) =>
            sum + value,
            0
        ) /
        period;

    for (
        let i = period; i < ranges.length; i++
    ) {
        result =
            (
                result *
                (
                    period - 1
                ) +
                ranges[i]
            ) /
            period;
    }

    return result;
}


function analyzeCandles(
    candles
) {
    const {
        candleStats
    } = require('./utils');

    if (!candles ||
        candles.length < 4
    ) {
        return {
            scoreUp: 0,
            scoreDown: 0,
            patterns: []
        };
    }

    const previous =
        candles[
            candles.length - 2
        ];

    const current =
        candles[
            candles.length - 1
        ];

    const previousStats =
        candleStats(
            previous
        );

    const currentStats =
        candleStats(
            current
        );

    let up = 0;
    let down = 0;

    const patterns = [];


    if (
        previousStats.bearish &&
        currentStats.bullish &&
        num(
            current.open
        ) <=
        num(
            previous.close
        ) &&
        num(
            current.close
        ) >=
        num(
            previous.open
        )
    ) {
        up += 30;

        patterns.push(
            'Bullish engulfing'
        );
    }


    if (
        previousStats.bullish &&
        currentStats.bearish &&
        num(
            current.open
        ) >=
        num(
            previous.close
        ) &&
        num(
            current.close
        ) <=
        num(
            previous.open
        )
    ) {
        down += 30;

        patterns.push(
            'Bearish engulfing'
        );
    }


    if (
        currentStats
        .lowerWickRatio >= 0.55 &&
        currentStats
        .bodyRatio <= 0.35
    ) {
        up += 20;

        patterns.push(
            'Bullish rejection'
        );
    }


    if (
        currentStats
        .upperWickRatio >= 0.55 &&
        currentStats
        .bodyRatio <= 0.35
    ) {
        down += 20;

        patterns.push(
            'Bearish rejection'
        );
    }


    if (
        currentStats
        .bodyRatio <= 0.1
    ) {
        patterns.push(
            'Doji'
        );
    }


    if (
        currentStats.bullish &&
        currentStats
        .bodyRatio >= 0.65
    ) {
        up += 15;

        patterns.push(
            'Strong bullish close'
        );
    }


    if (
        currentStats.bearish &&
        currentStats
        .bodyRatio >= 0.65
    ) {
        down += 15;

        patterns.push(
            'Strong bearish close'
        );
    }


    return {
        scoreUp: clamp(
            up,
            0,
            100
        ),

        scoreDown: clamp(
            down,
            0,
            100
        ),

        patterns: patterns
    };
}


function analyzeTechnical(
    candles,
    momentumBars = 5
) {
    const closes =
        candles.map(
            candle =>
            num(
                candle.close
            )
        );

    if (
        closes.length < 60
    ) {
        return null;
    }

    const ema9Value =
        ema(
            closes,
            9
        );

    const ema21Value =
        ema(
            closes,
            21
        );

    const ema50Value =
        ema(
            closes,
            50
        );

    const rsiValue =
        rsi(
            closes,
            14
        );

    const macdValue =
        macd(
            closes
        );

    const bands =
        bollinger(
            closes,
            20,
            2
        );

    const latestClose =
        closes[
            closes.length - 1
        ];

    const index =
        Math.max(
            0,
            closes.length -
            1 -
            momentumBars
        );

    const momentum =
        latestClose -
        closes[index];

    let up = 0;
    let down = 0;

    const reasons = [];


    if (
        ema9Value >
        ema21Value
    ) {
        up += 20;

        reasons.push(
            'EMA9 > EMA21'
        );
    } else {
        down += 20;

        reasons.push(
            'EMA9 < EMA21'
        );
    }


    if (
        ema21Value >
        ema50Value
    ) {
        up += 15;

        reasons.push(
            'EMA21 > EMA50'
        );
    } else {
        down += 15;

        reasons.push(
            'EMA21 < EMA50'
        );
    }


    if (
        rsiValue >= 52 &&
        rsiValue <= 68
    ) {
        up += 15;

        reasons.push(
            'RSI bullish'
        );
    } else if (
        rsiValue <= 48 &&
        rsiValue >= 32
    ) {
        down += 15;

        reasons.push(
            'RSI bearish'
        );
    }


    if (
        macdValue &&
        macdValue.histogram > 0
    ) {
        up += 20;

        reasons.push(
            'MACD bullish'
        );
    } else if (
        macdValue
    ) {
        down += 20;

        reasons.push(
            'MACD bearish'
        );
    }


    if (
        momentum > 0
    ) {
        up += 15;

        reasons.push(
            'Momentum UP'
        );
    } else if (
        momentum < 0
    ) {
        down += 15;

        reasons.push(
            'Momentum DOWN'
        );
    }


    if (
        bands &&
        latestClose <
        bands.lower
    ) {
        up += 10;
    }


    if (
        bands &&
        latestClose >
        bands.upper
    ) {
        down += 10;
    }


    return {
        score: Math.max(
            up,
            down
        ),

        upScore: clamp(
            up,
            0,
            100
        ),

        downScore: clamp(
            down,
            0,
            100
        ),

        entry: latestClose,

        rsi: round(
            rsiValue,
            2
        ),

        ema9: round(
            ema9Value,
            6
        ),

        ema21: round(
            ema21Value,
            6
        ),

        ema50: round(
            ema50Value,
            6
        ),

        macdHistogram: macdValue ?
            round(
                macdValue.histogram,
                6
            ) :
            null,

        momentum: momentum,

        bollinger: bands,

        reasons: reasons
    };
}


function analyzeVolatility(
    candles
) {
    if (!candles ||
        candles.length < 30
    ) {
        return {
            regime: 'UNKNOWN',

            atr: null
        };
    }

    const atrValue =
        atr(
            candles,
            14
        );

    const closes =
        candles.map(
            candle =>
            num(
                candle.close
            )
        );

    const bands =
        bollinger(
            closes,
            20,
            2
        );

    const price =
        closes[
            closes.length - 1
        ];

    const atrPct =
        atrValue &&
        price ?
        (
            atrValue /
            price
        ) *
        100 :
        0;

    const bandPct =
        bands ?
        (
            (
                bands.upper -
                bands.lower
            ) /
            bands.middle
        ) *
        100 :
        0;

    let regime =
        'NORMAL';

    if (
        atrPct > 0.08 ||
        bandPct > 0.35
    ) {
        regime =
            'HIGH VOLATILITY';
    } else if (
        atrPct < 0.025 &&
        bandPct < 0.12
    ) {
        regime =
            'LOW VOLATILITY';
    }

    return {
        regime: regime,

        atr: atrValue,

        atrPct: round(
            atrPct,
            4
        ),

        bollingerWidthPct: round(
            bandPct,
            4
        ),

        bollinger: bands
    };
}


module.exports = {
    sma,
    ema,
    rsi,
    macd,
    bollinger,
    atr,
    analyzeCandles,
    analyzeTechnical,
    analyzeVolatility
};