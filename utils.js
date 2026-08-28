function num(value) {
    return Number(value);
}

function clamp(
    value,
    min,
    max
) {
    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );
}

function round(
    value,
    digits = 2
) {
    if (!Number.isFinite(
            Number(value)
        )) {
        return null;
    }

    return Number(
        Number(value)
        .toFixed(digits)
    );
}

function parseUtcDateTime(
    value
) {
    if (!value) {
        return null;
    }

    const normalized =
        String(value)
        .replace(
            ' ',
            'T'
        );

    const date =
        new Date(
            normalized.endsWith('Z') ?
            normalized :
            `${normalized}Z`
        );

    return Number.isNaN(
            date.getTime()
        ) ?
        null :
        date;
}

function calculateSignalAgeSeconds(
    candles
) {
    if (!candles ||
        !candles.length
    ) {
        return null;
    }

    const latest =
        candles[
            candles.length - 1
        ];

    const date =
        parseUtcDateTime(
            latest.datetime
        );

    if (!date) {
        return null;
    }

    return Math.max(
        0,
        Math.round(
            (
                Date.now() -
                date.getTime()
            ) /
            1000
        )
    );
}

function candleStats(
    candle
) {
    const open =
        num(
            candle.open
        );

    const high =
        num(
            candle.high
        );

    const low =
        num(
            candle.low
        );

    const close =
        num(
            candle.close
        );

    const range =
        Math.max(
            high - low,
            1e-12
        );

    const body =
        Math.abs(
            close - open
        );

    return {
        bullish: close > open,

        bearish: close < open,

        bodyRatio: body / range,

        upperWickRatio:
            (
                high -
                Math.max(
                    open,
                    close
                )
            ) /
            range,

        lowerWickRatio:
            (
                Math.min(
                    open,
                    close
                ) -
                low
            ) /
            range
    };
}

function toChronological(
    candles
) {
    return candles
        .slice()
        .reverse()
        .map(
            candle => ({
                datetime: candle.datetime,

                open: num(
                    candle.open
                ),

                high: num(
                    candle.high
                ),

                low: num(
                    candle.low
                ),

                close: num(
                    candle.close
                )
            })
        );
}

function aggregateCandles(
    newestFirstCandles,
    minutes
) {
    if (!Array.isArray(
            newestFirstCandles
        ) ||
        !newestFirstCandles.length
    ) {
        return [];
    }

    const ordered =
        toChronological(
            newestFirstCandles
        );

    const bucketSize =
        minutes * 60;

    const buckets =
        new Map();

    for (
        const candle
        of ordered
    ) {
        const date =
            parseUtcDateTime(
                candle.datetime
            );

        if (!date) {
            continue;
        }

        const timestamp =
            Math.floor(
                date.getTime() /
                1000
            );

        const bucketStart =
            Math.floor(
                timestamp /
                bucketSize
            ) *
            bucketSize;

        if (!buckets.has(
                bucketStart
            )) {
            buckets.set(
                bucketStart, {
                    timestamp: bucketStart,

                    open: candle.open,

                    high: candle.high,

                    low: candle.low,

                    close: candle.close
                }
            );
        } else {
            const bucket =
                buckets.get(
                    bucketStart
                );

            bucket.high =
                Math.max(
                    bucket.high,
                    candle.high
                );

            bucket.low =
                Math.min(
                    bucket.low,
                    candle.low
                );

            bucket.close =
                candle.close;
        }
    }

    return Array
        .from(
            buckets.values()
        )
        .sort(
            (
                a,
                b
            ) =>
            a.timestamp -
            b.timestamp
        )
        .map(
            candle => ({
                datetime: new Date(
                        candle.timestamp *
                        1000
                    )
                    .toISOString()
                    .replace(
                        'T',
                        ' '
                    )
                    .substring(
                        0,
                        19
                    ),

                open: candle.open,

                high: candle.high,

                low: candle.low,

                close: candle.close
            })
        );
}

module.exports = {
    num,
    clamp,
    round,
    parseUtcDateTime,
    calculateSignalAgeSeconds,
    candleStats,
    toChronological,
    aggregateCandles
};