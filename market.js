const {
    ema,
    analyzeVolatility
} = require('./indicators');

const {
    num,
    round
} = require('./utils');


// ======================================================
// TIME
// ======================================================

function getTimeInZone(
    timeZone,
    now = new Date()
) {
    const parts =
        new Intl.DateTimeFormat(
            'en-US', {
                timeZone,

                hour: '2-digit',

                minute: '2-digit',

                hour12: false
            }
        )
        .formatToParts(
            now
        );

    let hour = 0;
    let minute = 0;

    for (
        const part
        of parts
    ) {
        if (
            part.type ===
            'hour'
        ) {
            hour =
                Number(
                    part.value
                );
        }

        if (
            part.type ===
            'minute'
        ) {
            minute =
                Number(
                    part.value
                );
        }
    }

    if (
        hour === 24
    ) {
        hour = 0;
    }

    return {
        hour,
        minute,

        decimal: hour +
            minute /
            60,

        formatted: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    };
}


// ======================================================
// MARKET ACTIVE
// ======================================================

function isMarketActive(
    timeZone,
    startHour,
    endHour,
    now = new Date()
) {
    const current =
        getTimeInZone(
            timeZone,
            now
        )
        .decimal;

    return (
        current >=
        startHour &&
        current <
        endHour
    );
}


// ======================================================
// FOREX MARKET HOURS
// ======================================================

function getActiveForexMarkets(
    now = new Date()
) {
    return {
        AUCKLAND: {
            active: isMarketActive(
                'Pacific/Auckland',
                8,
                17,
                now
            )
        },

        SYDNEY: {
            active: isMarketActive(
                'Australia/Sydney',
                8,
                17,
                now
            )
        },

        TOKYO: {
            active: isMarketActive(
                'Asia/Tokyo',
                8,
                17,
                now
            )
        },

        FRANKFURT: {
            active: isMarketActive(
                'Europe/Berlin',
                8,
                17,
                now
            )
        },

        LONDON: {
            active: isMarketActive(
                'Europe/London',
                8,
                17,
                now
            )
        },

        NEW_YORK: {
            active: isMarketActive(
                'America/New_York',
                8,
                17,
                now
            )
        }
    };
}


// ======================================================
// CURRENCY → MAIN MARKETS
// ======================================================

const CURRENCY_MARKETS = {
    EUR: [
        'FRANKFURT',
        'LONDON'
    ],

    GBP: [
        'LONDON'
    ],

    USD: [
        'NEW_YORK'
    ],

    CAD: [
        'NEW_YORK'
    ],

    CHF: [
        'FRANKFURT',
        'LONDON'
    ],

    JPY: [
        'TOKYO'
    ],

    AUD: [
        'SYDNEY'
    ],

    NZD: [
        'AUCKLAND',
        'SYDNEY'
    ]
};


// ======================================================
// PAIR SESSION
// ======================================================

function getPairSession(
    symbol,
    now = new Date()
) {
    const montreal =
        getTimeInZone(
            'America/Toronto',
            now
        );

    const markets =
        getActiveForexMarkets(
            now
        );

    const [
        base,
        quote
    ] =
    String(symbol)
        .toUpperCase()
        .split('/');

    const baseMarkets =
        CURRENCY_MARKETS[
            base
        ] || [];

    const quoteMarkets =
        CURRENCY_MARKETS[
            quote
        ] || [];

    const activeMarkets =
        Object.keys(
            markets
        )
        .filter(
            name =>
            markets[name].active
        );

    const activeBaseMarkets =
        baseMarkets.filter(
            name =>
            markets[name] &&
            markets[name].active
        );

    const activeQuoteMarkets =
        quoteMarkets.filter(
            name =>
            markets[name] &&
            markets[name].active
        );

    const baseActive =
        activeBaseMarkets.length >
        0;

    const quoteActive =
        activeQuoteMarkets.length >
        0;

    let quality = 25;

    let status =
        'QUIET';

    let label =
        'QUIET TIME';

    let allowShortTerm =
        false;


    if (
        baseActive &&
        quoteActive
    ) {
        quality = 100;

        status =
            'BEST';

        label =
            'BEST TIME';

        allowShortTerm =
            true;
    } else if (
        baseActive ||
        quoteActive
    ) {
        quality = 75;

        status =
            'GOOD';

        label =
            'GOOD TIME';

        allowShortTerm =
            true;
    }


    return {
        symbol,

        status,

        label,

        quality,

        allowShortTerm,

        montrealTime: montreal.formatted,

        activeMarkets,

        activeBaseMarkets,

        activeQuoteMarkets
    };
}


// ======================================================
// MARKET REGIME
// ======================================================

function analyzeMarketRegime(
    candles
) {
    const closes =
        candles.map(
            candle =>
            num(
                candle.close
            )
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

    const volatility =
        analyzeVolatility(
            candles
        );

    const distance =
        ema21Value &&
        ema50Value ?
        (
            Math.abs(
                ema21Value -
                ema50Value
            ) /
            closes[
                closes.length - 1
            ]
        ) *
        100 :
        0;

    let regime =
        'RANGE';

    if (
        volatility.regime ===
        'HIGH VOLATILITY'
    ) {
        regime =
            'HIGH VOLATILITY';
    } else if (
        distance >
        0.03
    ) {
        regime =
            'TRENDING';
    } else if (
        volatility.regime ===
        'LOW VOLATILITY'
    ) {
        regime =
            'LOW VOLATILITY';
    }

    return {
        regime,

        emaDistancePct: round(
            distance,
            4
        ),

        volatility
    };
}


// ======================================================
// ECONOMIC NEWS PLACEHOLDER
// ======================================================

function newsRiskPlaceholder(
    symbol
) {
    return {
        status: 'UNAVAILABLE',

        blocked: false,

        symbol,

        message: 'Economic calendar is not connected yet.'
    };
}


module.exports = {
    getTimeInZone,
    getActiveForexMarkets,
    getPairSession,
    analyzeMarketRegime,
    newsRiskPlaceholder
};