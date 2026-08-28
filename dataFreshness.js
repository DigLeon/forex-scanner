// ======================================================
// dataFreshness.js
// v4.6 — Unified Data Freshness
// ======================================================

function parseTimestamp(
    value
) {

    if (
        value ===
            null ||
        value ===
            undefined
    ) {

        return null;
    }


    if (
        typeof value ===
            'number'
    ) {

        const ms =
            value >
                10_000_000_000
                ?
                value
                :
                value *
                1000;


        const date =
            new Date(
                ms
            );


        return Number.isNaN(
            date.getTime()
        )
            ?
            null
            :
            date;
    }


    let text =
        String(
            value
        )
        .trim();


    if (
        !text
    ) {

        return null;
    }


    // Twelve Data timestamps are commonly UTC without Z.
    if (
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
        .test(
            text
        )
    ) {

        text =
            text.replace(
                ' ',
                'T'
            ) +
            'Z';
    }


    const date =
        new Date(
            text
        );


    return Number.isNaN(
        date.getTime()
    )
        ?
        null
        :
        date;
}


function ageSeconds(
    timestamp,
    nowMs = Date.now()
) {

    const date =
        parseTimestamp(
            timestamp
        );


    if (
        !date
    ) {

        return null;
    }


    return Math.max(
        0,
        Math.floor(
            (
                nowMs -
                date.getTime()
            ) /
            1000
        )
    );
}


function buildDataFreshness({
    source,
    newestClosedCandleTime,
    livePriceUpdatedAt,
    historyUpdatedAt,
    closedCandleIntervalSeconds = 60,
    maxClosedCandleAgeSeconds = 125,
    maxLivePriceAgeSeconds = 90,
    maxHistoryAgeSeconds = 180
}) {

    const nowMs =
        Date.now();


    const closedAgeRaw =
        ageSeconds(
            newestClosedCandleTime,
            nowMs
        );


    // newestClosedCandleTime normally represents candle OPEN time.
    // Add interval before measuring time since candle close.
    const closedCandleAgeSeconds =
        closedAgeRaw ===
            null
            ?
            null
            :
            Math.max(
                0,
                closedAgeRaw -
                closedCandleIntervalSeconds
            );


    const livePriceAgeSeconds =
        ageSeconds(
            livePriceUpdatedAt,
            nowMs
        );


    const historyAgeSeconds =
        ageSeconds(
            historyUpdatedAt,
            nowMs
        );


    const problems =
        [];


    if (
        closedCandleAgeSeconds ===
            null
    ) {

        problems.push(
            'NO_CLOSED_CANDLE_TIME'
        );


    } else if (
        closedCandleAgeSeconds >
            maxClosedCandleAgeSeconds
    ) {

        problems.push(
            'CLOSED_CANDLE_STALE'
        );
    }


    if (
        livePriceUpdatedAt &&
        livePriceAgeSeconds !==
            null &&
        livePriceAgeSeconds >
            maxLivePriceAgeSeconds
    ) {

        problems.push(
            'LIVE_PRICE_STALE'
        );
    }


    if (
        historyUpdatedAt &&
        historyAgeSeconds !==
            null &&
        historyAgeSeconds >
            maxHistoryAgeSeconds
    ) {

        problems.push(
            'HISTORY_STALE'
        );
    }


    return {

        source:
            source ||
            'UNKNOWN',

        newestClosedCandleTime:
            newestClosedCandleTime ||
            null,

        closedCandleAgeSeconds:
            closedCandleAgeSeconds,

        livePriceUpdatedAt:
            livePriceUpdatedAt ||
            null,

        livePriceAgeSeconds:
            livePriceAgeSeconds,

        historyUpdatedAt:
            historyUpdatedAt ||
            null,

        historyAgeSeconds:
            historyAgeSeconds,

        stale:
            problems.length >
            0,

        problems:
            problems,

        reason:
            problems.length
                ?
                problems.join(
                    ', '
                )
                :
                'Data freshness checks passed'
    };
}


module.exports = {
    parseTimestamp,
    ageSeconds,
    buildDataFreshness
};
