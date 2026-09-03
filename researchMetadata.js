const {
    rsi,
    macd,
    atr
} = require('./indicators');

const {
    num,
    round,
    toChronological,
    aggregateCandles
} = require('./utils');


// ======================================================
// RESEARCH METADATA
//
// Diagnostic/statistical metadata only.
// IMPORTANT: this module MUST NOT affect Signal Score,
// Entry Engine, direction, expiration or Telegram logic.
// ======================================================

function safeRound(
    value,
    decimals = 6
) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return null;
    }

    return round(
        n,
        decimals
    );
}


function getClosedAggregate(
    closedCandles,
    minutes
) {
    const ordered =
        toChronological(
            closedCandles || []
        );

    if (
        minutes === 1
    ) {
        return ordered;
    }

    if (
        !ordered.length
    ) {
        return [];
    }

    const aggregated =
        aggregateCandles(
            ordered,
            minutes
        );

    if (
        !Array.isArray(
            aggregated
        )
    ) {
        return [];
    }

    return aggregated;
}


function buildTimeframeSnapshot(
    candles
) {
    const ordered =
        toChronological(
            candles || []
        );

    if (
        !ordered.length
    ) {
        return {
            rsi14: null,
            atr14: null,
            atrPct: null,
            macdLine: null,
            macdSignal: null,
            macdHistogram: null
        };
    }

    const closes =
        ordered
        .map(
            candle =>
                num(
                    candle.close
                )
        )
        .filter(
            Number.isFinite
        );

    const latestClose =
        closes.length
            ?
            closes[
                closes.length - 1
            ]
            :
            null;

    const rsiValue =
        closes.length > 14
            ?
            rsi(
                closes,
                14
            )
            :
            null;

    const atrValue =
        ordered.length > 14
            ?
            atr(
                ordered,
                14
            )
            :
            null;

    const macdValue =
        closes.length >= 40
            ?
            macd(
                closes
            )
            :
            null;

    const atrPct =
        Number.isFinite(
            Number(atrValue)
        ) &&
        Number.isFinite(
            Number(latestClose)
        ) &&
        Number(latestClose) !== 0
            ?
            (
                Number(atrValue) /
                Number(latestClose)
            ) *
            100
            :
            null;

    return {
        rsi14:
            safeRound(
                rsiValue,
                2
            ),

        atr14:
            safeRound(
                atrValue,
                8
            ),

        atrPct:
            safeRound(
                atrPct,
                5
            ),

        macdLine:
            macdValue
                ?
                safeRound(
                    macdValue.macd,
                    8
                )
                :
                null,

        macdSignal:
            macdValue
                ?
                safeRound(
                    macdValue.signal,
                    8
                )
                :
                null,

        macdHistogram:
            macdValue
                ?
                safeRound(
                    macdValue.histogram,
                    8
                )
                :
                null
    };
}


function buildResearchMetadata({
    closedCandles,
    entryZone,
    currentPrice,
    signalAge,
    candleConfirmation,
    marketRegime
}) {
    const m1 =
        getClosedAggregate(
            closedCandles,
            1
        );

    const m5 =
        getClosedAggregate(
            closedCandles,
            5
        );

    const m15 =
        getClosedAggregate(
            closedCandles,
            15
        );

    const oneMinute =
        buildTimeframeSnapshot(
            m1
        );

    const fiveMinute =
        buildTimeframeSnapshot(
            m5
        );

    const fifteenMinute =
        buildTimeframeSnapshot(
            m15
        );

    const bestEntryPrice =
        Number(
            entryZone &&
            entryZone.bestEntryPrice
        );

    const price =
        Number(
            currentPrice
        );

    const atr1m =
        Number(
            oneMinute.atr14
        );

    const distanceToBestEntryAtr =
        Number.isFinite(
            price
        ) &&
        Number.isFinite(
            bestEntryPrice
        ) &&
        Number.isFinite(
            atr1m
        ) &&
        atr1m > 0
            ?
            Math.abs(
                price -
                bestEntryPrice
            ) /
            atr1m
            :
            (
                entryZone &&
                Number.isFinite(
                    Number(
                        entryZone
                            .distanceToBestAtr
                    )
                )
                    ?
                    Number(
                        entryZone
                            .distanceToBestAtr
                    )
                    :
                    null
            );

    return {
        version:
            'research-metadata-v1',

        capturedAt:
            new Date()
            .toISOString(),

        rsi1m:
            oneMinute.rsi14,

        rsi5m:
            fiveMinute.rsi14,

        rsi15m:
            fifteenMinute.rsi14,

        atr1m:
            oneMinute.atr14,

        atr1mPct:
            oneMinute.atrPct,

        atr5m:
            fiveMinute.atr14,

        atr5mPct:
            fiveMinute.atrPct,

        atr15m:
            fifteenMinute.atr14,

        atr15mPct:
            fifteenMinute.atrPct,

        macd5mLine:
            fiveMinute.macdLine,

        macd5mSignal:
            fiveMinute.macdSignal,

        macd5mHistogram:
            fiveMinute.macdHistogram,

        distanceToBestEntryAtr:
            safeRound(
                distanceToBestEntryAtr,
                4
            ),

        entryStatus:
            entryZone
                ?
                entryZone.status ||
                null
                :
                null,

        entryQuality:
            entryZone
                ?
                entryZone.currentEntryQuality ||
                null
                :
                null,

        candleConfirmed:
            candleConfirmation
                ?
                candleConfirmation.confirmed ===
                true
                :
                null,

        signalAgeSeconds:
            signalAge &&
            Number.isFinite(
                Number(
                    signalAge.seconds
                )
            )
                ?
                Number(
                    signalAge.seconds
                )
                :
                null,

        signalAgeStatus:
            signalAge
                ?
                signalAge.status ||
                null
                :
                null,

        marketRegime:
            marketRegime
                ?
                marketRegime.regime ||
                marketRegime ||
                null
                :
                null
    };
}


module.exports = {
    buildResearchMetadata
};
