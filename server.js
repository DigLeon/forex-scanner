require('dotenv').config();


const {
    checkNewsRisk
} = require('./newsFilter');

const {
    logSignal,
    resolveSignal,
    getExpiredPendingSignals,
    getSignalHistory,
    getSignalStats
} = require('./signalLogger');

const express =
    require(
        'express'
    );


const {
    isTelegramConfigured,
    sendTradeAlert,
    sendTestAlert
} = require('./telegramNotifier');


const multer =
    require(
        'multer'
    );


const {
    analyzeChartScreenshots
} = require('./visionAnalyzer');


const {
    configureRealtime,
    setRealtimeSymbols,
    getLivePrice,
    getRealtimeStatus,
    getRealtimeClosedCandles,
    getRealtimeCurrentCandle,
    getRealtimeConfig
} = require('./realtimeMarketData');

const realtimeConfig =
    getRealtimeConfig();


// ======================================================
// LOCAL HISTORY STORE
// ======================================================
//
// REST is used only to bootstrap historical 1M candles.
// After that, completed WebSocket candles are merged into
// this local history and automatic analysis reads locally.
//
// A periodic REST resync is still allowed as a safety net.
// ======================================================

const localHistoricalCandles =
    new Map();

const localHistoryBootstrappedAt =
    new Map();

const LOCAL_HISTORY_LIMIT =
    1600;

// With a live WebSocket stream, REST is only a safety resync.
// In REST-only mode, refresh often enough for manual scanning;
// marketData.js cache prevents duplicate REST calls inside the configured cache window.
const LOCAL_HISTORY_RESYNC_MS =
    realtimeConfig.enabled ?
    30 * 60 * 1000 :
    Math.max(
        30 * 1000,
        Number(process.env.TWELVE_REST_REFRESH_MS) || 60 * 1000
    );

const localHistoryBootstrapPromises =
    new Map();

// Latest REST snapshot is kept separately from closed-candle history.
// This gives REST-only mode a fresh current price without contaminating
// analysis with the still-forming 1-minute candle.
const latestRestSnapshots =
    new Map();


// ======================================================
// GET UTC MINUTE START
// ======================================================



// ======================================================
// LOCAL HISTORY HELPERS
// ======================================================

function normalizeCandleKey(
    candle
) {

    return candle &&
        candle.datetime ?
        String(
            candle.datetime
        ) :
        null;
}


function mergeCandleLists(
    baseCandles,
    newerCandles
) {

    const merged =
        new Map();


    const add =
        candle => {

            const key =
                normalizeCandleKey(
                    candle
                );


            if (!key) {
                return;
            }


            merged.set(
                key,
                candle
            );
        };


    if (
        Array.isArray(
            baseCandles
        )
    ) {

        for (
            const candle
            of baseCandles
        ) {

            add(
                candle
            );
        }
    }


    if (
        Array.isArray(
            newerCandles
        )
    ) {

        for (
            const candle
            of newerCandles
        ) {

            add(
                candle
            );
        }
    }


    return [
            ...merged.values()
        ]
        .sort(
            (
                a,
                b
            ) => {

                const aTime =
                    parseCandleUtc(
                        a.datetime
                    );


                const bTime =
                    parseCandleUtc(
                        b.datetime
                    );


                return (
                        bTime ?
                        bTime.getTime() :
                        0
                    ) -
                    (
                        aTime ?
                        aTime.getTime() :
                        0
                    );
            }
        )
        .slice(
            0,
            LOCAL_HISTORY_LIMIT
        );
}


function appendLocalClosedCandle(
    symbol,
    candle
) {

    if (!symbol ||
        !candle ||
        !candle.datetime
    ) {

        return;
    }


    const current =
        localHistoricalCandles.get(
            symbol
        ) || [];


    const next =
        mergeCandleLists(
            current, [
                candle
            ]
        );


    localHistoricalCandles.set(
        symbol,
        next
    );
}


configureRealtime({
    onClosedCandle: appendLocalClosedCandle
});


function getLocalHistory(
    symbol
) {

    const history =
        localHistoricalCandles.get(
            symbol
        );


    return Array.isArray(
            history
        ) ?
        history : [];
}


function localHistoryNeedsBootstrap(
    symbol
) {

    const history =
        getLocalHistory(
            symbol
        );


    if (
        history.length <
        100
    ) {

        return true;
    }


    const bootstrappedAt =
        Number(
            localHistoryBootstrappedAt.get(
                symbol
            )
        );


    if (!Number.isFinite(
            bootstrappedAt
        )) {

        return true;
    }


    return (
            Date.now() -
            bootstrappedAt
        ) >=
        LOCAL_HISTORY_RESYNC_MS;
}


async function bootstrapLocalHistory(
    symbol,
    force = false
) {

    if (!force &&
        !localHistoryNeedsBootstrap(
            symbol
        )
    ) {

        return getLocalHistory(
            symbol
        );
    }


    if (
        localHistoryBootstrapPromises.has(
            symbol
        )
    ) {

        return localHistoryBootstrapPromises.get(
            symbol
        );
    }


    const promise =
        (
            async() => {

                try {

                    console.log(
                        '[LOCAL HISTORY]',
                        symbol,
                        force ?
                        'FORCE REST SYNC' :
                        'REST BOOTSTRAP'
                    );


                    const data =
                        await getTimeSeries(
                            symbol, {

                                interval: '1min',

                                outputsize: 1500
                            }
                        );


                    if (
                        data.status ===
                        'error' ||
                        !Array.isArray(
                            data.values
                        )
                    ) {

                        throw new Error(
                            data.message ||
                            'No REST candle values'
                        );
                    }


                    const prepared =
                        prepareCandles(
                            data.values
                        );


                    latestRestSnapshots.set(
                        symbol, {
                            ...prepared,
                            marketData: data._marketData || null,
                            refreshedAt: Date.now()
                        }
                    );


                    const wsClosed =
                        getRealtimeClosedCandles(
                            symbol
                        );


                    const local =
                        mergeCandleLists(
                            prepared.closedCandles,
                            wsClosed
                        );


                    localHistoricalCandles.set(
                        symbol,
                        local
                    );


                    localHistoryBootstrappedAt.set(
                        symbol,
                        Date.now()
                    );


                    console.log(
                        '[LOCAL HISTORY]',
                        symbol,
                        'READY',
                        local.length,
                        'candles',
                        '| REST source:',
                        data._marketData &&
                        data._marketData.source ?
                        data._marketData.source :
                        'API'
                    );


                    return local;


                } finally {

                    localHistoryBootstrapPromises.delete(
                        symbol
                    );
                }
            }
        )();


    localHistoryBootstrapPromises.set(
        symbol,
        promise
    );


    return promise;
}


// ======================================================
// MERGE REST + WEBSOCKET CLOSED CANDLES
// ======================================================
//
// Priority:
// REST      = 1
// WEBSOCKET = 2
//
// If the same minute exists in both,
// the WS candle replaces the REST candle.
// ======================================================

function mergeClosedCandles(
    restClosedCandles,
    websocketClosedCandles
) {

    const merged =
        new Map();


    const add =
        (
            candle,
            priority
        ) => {

            if (!candle ||
                !candle.datetime
            ) {

                return;
            }


            const key =
                String(
                    candle.datetime
                );


            const existing =
                merged.get(
                    key
                );


            if (!existing ||
                priority >
                existing.priority
            ) {

                merged.set(
                    key, {

                        priority: priority,

                        candle: candle
                    }
                );
            }
        };


    // ==================================================
    // REST CLOSED CANDLES
    // ==================================================

    if (
        Array.isArray(
            restClosedCandles
        )
    ) {

        for (
            const candle
            of restClosedCandles
        ) {

            add(
                candle,
                1
            );
        }
    }


    // ==================================================
    // WEBSOCKET CLOSED CANDLES
    // ==================================================

    if (
        Array.isArray(
            websocketClosedCandles
        )
    ) {

        for (
            const candle
            of websocketClosedCandles
        ) {

            add(
                candle,
                2
            );
        }
    }


    // ==================================================
    // NEWEST FIRST
    // ==================================================

    return [
            ...merged.values()
        ]
        .map(
            item =>
            item.candle
        )
        .sort(
            (
                a,
                b
            ) => {

                const aTime =
                    parseCandleUtc(
                        a.datetime
                    );


                const bTime =
                    parseCandleUtc(
                        b.datetime
                    );


                return (
                        bTime ?
                        bTime.getTime() :
                        0
                    ) -
                    (
                        aTime ?
                        aTime.getTime() :
                        0
                    );
            }
        );
}


// ======================================================
// NORMALIZE SYMBOL LIST
// ======================================================



// ======================================================
// DYNAMIC PAIRS BY MONTREAL TIME
// ======================================================
//
// Максимум 5 пар для каждого периода.
//
// Montreal использует America/Toronto.
// DST учитывается автоматически.
// ======================================================

const SESSION_CURRENCY_PRIORITY = {
    ASIA: {
        JPY: 100,
        AUD: 95,
        NZD: 90,
        USD: 55,
        EUR: 25,
        GBP: 20,
        CHF: 15,
        CAD: 15
    },
    PRE_LONDON: {
        JPY: 75,
        AUD: 65,
        NZD: 60,
        EUR: 60,
        GBP: 55,
        USD: 50,
        CHF: 40,
        CAD: 20
    },
    LONDON: {
        EUR: 100,
        GBP: 100,
        CHF: 85,
        USD: 65,
        JPY: 50,
        CAD: 35,
        AUD: 25,
        NZD: 20
    },
    LONDON_NEW_YORK: {
        EUR: 100,
        GBP: 100,
        USD: 100,
        CHF: 80,
        CAD: 75,
        JPY: 70,
        AUD: 45,
        NZD: 35
    },
    NEW_YORK: {
        USD: 100,
        CAD: 95,
        EUR: 70,
        GBP: 65,
        JPY: 60,
        CHF: 55,
        AUD: 35,
        NZD: 30
    }
};

function getSessionPairScore(symbol, periodKey) {
    const priority = SESSION_CURRENCY_PRIORITY[periodKey] || {};
    const [base, quote] = String(symbol).toUpperCase().split('/');
    const baseScore = Number(priority[base] || 0);
    const quoteScore = Number(priority[quote] || 0);

    // Both currencies matter. A pair with two session currencies
    // ranks above a pair where only one side is active.
    let score = baseScore + quoteScore;

    // Small preference for liquid majors without making it a hard rule.
    if (['EUR/USD','GBP/USD','USD/JPY','USD/CHF','USD/CAD','AUD/USD','NZD/USD'].includes(symbol)) {
        score += 8;
    }

    return score;
}

function getRankedSessionPairs(periodKey, limit = 5) {
    if (periodKey === 'ROLLOVER') {
        return [];
    }

    return PAIRS
        .map(symbol => ({
            symbol,
            sessionScore: getSessionPairScore(symbol, periodKey)
        }))
        .sort((a, b) =>
            b.sessionScore - a.sessionScore ||
            a.symbol.localeCompare(b.symbol)
        )
        .slice(0, limit);
}

function buildMarketPeriod(key, label) {
    const rankedPairs = getRankedSessionPairs(key, 5);

    return {
        key,
        label,
        activePairs: rankedPairs.map(item => item.symbol),
        rankedPairs,
        selectionMode: 'SESSION_RANKING_TOP_5'
    };
}


// ======================================================
// GET MONTREAL HOUR
// ======================================================

function getMontrealHour() {

    const parts =
        new Intl.DateTimeFormat(
            'en-CA', {

                timeZone: 'America/Toronto',

                hour: '2-digit',

                hourCycle: 'h23'
            }
        )
        .formatToParts(
            new Date()
        );


    const hourPart =
        parts.find(
            part =>
            part.type ===
            'hour'
        );


    const hour =
        hourPart ?
        Number(
            hourPart.value
        ) :
        NaN;


    return Number.isFinite(
            hour
        ) ?
        hour :
        0;
}


// ======================================================
// GET ACTIVE MARKET PERIOD
// ======================================================

function getActiveMarketPeriod() {
    const hour = getMontrealHour();

    if (hour >= 19) {
        return buildMarketPeriod('ASIA', 'ASIA');
    }

    if (hour >= 0 && hour < 3) {
        return buildMarketPeriod('PRE_LONDON', 'PRE-LONDON');
    }

    if (hour >= 3 && hour < 8) {
        return buildMarketPeriod('LONDON', 'LONDON');
    }

    if (hour >= 8 && hour < 12) {
        return buildMarketPeriod('LONDON_NEW_YORK', 'LONDON + NEW YORK');
    }

    if (hour >= 12 && hour < 16) {
        return buildMarketPeriod('NEW_YORK', 'NEW YORK');
    }

    return {
        key: 'ROLLOVER',
        label: 'ROLLOVER / SCANNER OFF',
        activePairs: [],
        rankedPairs: [],
        selectionMode: 'SCANNER_OFF'
    };
}


// ======================================================
// ALL POSSIBLE SESSION PAIRS
// ======================================================

function getAllSessionPairs() {
    return [...PAIRS];
}


// ======================================================
// MODULES
// ======================================================

const path =
    require(
        'path'
    );


const {
    PORT,
    API_KEY,
    TWELVE_DATA_API_KEY_SOURCE,
    PAIRS
} = require('./config');


if (!API_KEY) {
    console.warn('[CONFIG] Twelve Data API key is missing. Add TWELVE_DATA_API_KEY=... to .env');
} else {
    console.log(`[CONFIG] Twelve Data API key loaded from ${TWELVE_DATA_API_KEY_SOURCE}`);
}


// ======================================================
// PAIR CONFIG INTEGRITY
// ======================================================

const invalidPairs =
    PAIRS.filter(
        symbol =>
            !/^[A-Z]{3}\/[A-Z]{3}$/.test(
                String(symbol)
            )
    );

const duplicatePairs =
    PAIRS.filter(
        (symbol, index) =>
            PAIRS.indexOf(symbol) !== index
    );

if (
    invalidPairs.length ||
    duplicatePairs.length
) {
    throw new Error(
        '[CONFIG] Invalid PAIRS configuration: ' +
        JSON.stringify({
            invalidPairs,
            duplicatePairs
        })
    );
}

const {
    combinedAnalysis
} = require('./analysisEngine');


const {
    getTimeSeries,
    getPrice,
    getMarketDataCacheStatus,
    clearMarketDataCache
} = require('./marketData');


const {
    getPairSession,
    getTimeInZone
} = require('./market');


// ======================================================
// EXPRESS
// ======================================================

const app =
    express();


// ======================================================
// VISUAL REVIEW STATE
// ======================================================

const latestSignalSnapshots =
    new Map();


const visualReviewUpload =
    multer({

        storage:
            multer.memoryStorage(),

        limits: {

            fileSize:
                8 * 1024 * 1024,

            files:
                5
        },

        fileFilter:
            (
                req,
                file,
                callback
            ) => {

                const allowed =
                    [
                        'image/png',
                        'image/jpeg',
                        'image/webp'
                    ];


                if (
                    !allowed.includes(
                        file.mimetype
                    )
                ) {

                    return callback(
                        new Error(
                            'Only PNG, JPG/JPEG and WEBP screenshots are allowed'
                        )
                    );
                }


                callback(
                    null,
                    true
                );
            }
    });


// ======================================================
// STATIC GUI
// ======================================================

app.use(
    express.static(
        path.join(
            __dirname,
            'public'
        ),
        {
            // The scanner GUI changes together with the backend API.
            // Do not let an old cached index.html hide new TRADE/WAIT/SKIP UI.
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.html')) {
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                }
            }
        }
    )
);


// ======================================================
// JSON BODY
// ======================================================

app.use(
    express.json()
);


// ======================================================
// CHECK EXPIRED PAPER SIGNALS
// ======================================================

async function checkExpiredPaperSignals() {

    const pending =
        getExpiredPendingSignals();


    if (!pending.length) {

        return;
    }


    console.log(
        '[SIGNAL LOGGER]',
        'Checking',
        pending.length,
        'expired paper signals'
    );


    for (
        const signal
        of pending
    ) {

        try {

            // ==========================================
            // TRY CURRENT WEBSOCKET PRICE FIRST
            // ==========================================

            const realtime =
                getLivePrice(
                    signal.symbol
                );


            let currentPrice =
                null;


            if (
                realtime &&
                realtime.fresh &&
                Number.isFinite(
                    Number(
                        realtime.price
                    )
                )
            ) {

                currentPrice =
                    Number(
                        realtime.price
                    );


            } else {

                // ======================================
                // REST FALLBACK
                // ======================================

                const data =
                    await getPrice(
                        signal.symbol
                    );


                currentPrice =
                    Number(
                        data.price
                    );
            }


            if (!Number.isFinite(
                    currentPrice
                )) {

                console.log(
                    '[SIGNAL RESULT SKIP]',
                    signal.symbol,
                    'Invalid current price'
                );


                continue;
            }


            resolveSignal(
                signal.id,
                currentPrice
            );


        } catch (
            error
        ) {

            console.error(
                '[SIGNAL RESULT ERROR]',
                signal.symbol,
                error.message
            );
        }
    }
}


// ======================================================
// PARSE UTC CANDLE DATETIME
// ======================================================

function parseCandleUtc(
    value
) {

    if (!value) {

        return null;
    }


    let normalized =
        String(
            value
        )
        .trim()
        .replace(
            ' ',
            'T'
        );


    if (!normalized.endsWith(
            'Z'
        ) &&
        !/[+-]\d{2}:\d{2}$/.test(
            normalized
        )
    ) {

        normalized +=
            'Z';
    }


    const date =
        new Date(
            normalized
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return null;
    }


    return date;
}


// ======================================================
// PREPARE REST 1M CANDLES
// ======================================================
//
// Twelve Data may return the currently-forming candle.
//
// For analysis we separate:
//
// livePrice       = newest REST close
// closedCandles   = ONLY completed candles
//
// Later closedCandles are merged with our WebSocket
// candles.
// ======================================================

function prepareCandles(
    values
) {

    if (!Array.isArray(
            values
        ) ||
        !values.length
    ) {

        return {

            livePrice: null,

            closedCandles: [],

            newestApiCandle: null,

            newestClosedCandle: null,

            newestClosedAgeSeconds: null,

            firstCandleIsOpen: false
        };
    }


    const now =
        Date.now();


    // Normalize provider ordering defensively. Twelve Data normally
    // returns newest-first, but analysis should not depend on that
    // external ordering guarantee. Invalid timestamps are pushed last.
    const orderedValues =
        values
        .slice()
        .sort(
            (a, b) => {
                const aTime = parseCandleUtc(a && a.datetime);
                const bTime = parseCandleUtc(b && b.datetime);

                return (bTime ? bTime.getTime() : 0) -
                    (aTime ? aTime.getTime() : 0);
            }
        );


    // ==================================================
    // NEWEST API CANDLE
    // ==================================================

    const newestApiCandle =
        orderedValues[0];


    // ==================================================
    // REST LIVE PRICE
    // ==================================================

    const livePriceRaw =
        Number(
            newestApiCandle.close
        );


    const livePrice =
        Number.isFinite(
            livePriceRaw
        ) ?
        livePriceRaw :
        null;


    // ==================================================
    // CLOSED CANDLES ONLY
    // ==================================================

    const closedCandles =
        orderedValues.filter(
            candle => {

                const openTime =
                    parseCandleUtc(
                        candle.datetime
                    );


                if (!openTime) {

                    return false;
                }


                const candleCloseTime =
                    openTime.getTime() +
                    60 * 1000;


                return (
                    candleCloseTime <=
                    now
                );
            }
        );


    // ==================================================
    // IS NEWEST REST CANDLE STILL OPEN?
    // ==================================================

    let firstCandleIsOpen =
        false;


    const newestOpenTime =
        parseCandleUtc(
            newestApiCandle.datetime
        );


    if (
        newestOpenTime
    ) {

        const newestCloseTime =
            newestOpenTime.getTime() +
            60 * 1000;


        firstCandleIsOpen =
            newestCloseTime >
            now;
    }


    // ==================================================
    // AGE OF NEWEST CLOSED REST CANDLE
    // ==================================================

    let newestClosedAgeSeconds =
        null;


    if (
        closedCandles.length
    ) {

        const newestClosedOpen =
            parseCandleUtc(
                closedCandles[0]
                .datetime
            );


        if (
            newestClosedOpen
        ) {

            const newestClosedTime =
                newestClosedOpen.getTime() +
                60 * 1000;


            newestClosedAgeSeconds =
                Math.max(
                    0,

                    Math.floor(
                        (
                            now -
                            newestClosedTime
                        ) /
                        1000
                    )
                );
        }
    }


    return {

        livePrice: livePrice,

        closedCandles: closedCandles,

        newestApiCandle: newestApiCandle.datetime ||
            null,

        newestClosedCandle: closedCandles.length ?
            closedCandles[0]
            .datetime : null,

        newestClosedAgeSeconds: newestClosedAgeSeconds,

        firstCandleIsOpen: firstCandleIsOpen
    };
}


// ======================================================
// PRICE API
// ======================================================

app.get(
    '/api/price',

    async(
        req,
        res
    ) => {

        try {

            const symbol =
                req.query.symbol ||
                'EUR/USD';


            // ==========================================
            // WEBSOCKET FIRST
            // ==========================================

            const realtime =
                getLivePrice(
                    symbol
                );


            if (
                realtime &&
                realtime.fresh &&
                Number.isFinite(
                    Number(
                        realtime.price
                    )
                )
            ) {

                return res.json({

                    status: 'ok',

                    symbol: symbol,

                    price: Number(
                        realtime.price
                    ),

                    source: 'WEBSOCKET',

                    ageMs: realtime.ageMs
                });
            }


            // ==========================================
            // REST FALLBACK
            // ==========================================

            const data =
                await getPrice(
                    symbol
                );


            res.json({

                ...data,

                source: 'REST_FALLBACK'
            });


        } catch (
            error
        ) {

            console.error(
                '[PRICE ERROR]',
                error.message
            );


            res
                .status(
                    500
                )
                .json({

                    status: 'error',

                    error: error.message
                });
        }
    }
);


// ======================================================
// CANDLES API
// ======================================================

app.get(
    '/api/candles',

    async(
        req,
        res
    ) => {

        try {

            const symbol =
                req.query.symbol ||
                'EUR/USD';


            const interval =
                req.query.interval ||
                '1min';


            const outputsize =
                Math.min(

                    Math.max(

                        Number(
                            req.query.outputsize ||
                            120
                        ),

                        1
                    ),

                    5000
                );


            const data =
                await getTimeSeries(
                    symbol, {
                        interval: interval,
                        outputsize: outputsize
                    }
                );


            res.json(
                data
            );


        } catch (
            error
        ) {

            console.error(
                '[CANDLES ERROR]',
                error.message
            );


            res
                .status(
                    500
                )
                .json({

                    status: 'error',

                    error: error.message
                });
        }
    }
);


// ======================================================
// ECONOMIC CALENDAR CACHE
// ======================================================

let economicEvents = [];


let economicCalendarUpdatedAt =
    null;


// ======================================================
// UPDATE ECONOMIC EVENTS
// ======================================================

function setEconomicEvents(
    events
) {

    economicEvents =
        Array.isArray(
            events
        ) ?
        events : [];


    economicCalendarUpdatedAt =
        new Date()
        .toISOString();


    console.log(
        '[NEWS FILTER]',
        economicEvents.length,
        'economic events loaded'
    );
}


// ======================================================
// NEWS EVENTS POST
// ======================================================

app.post(
    '/api/news-events',

    (
        req,
        res
    ) => {

        setEconomicEvents(
            req.body
        );


        res.json({

            status: 'ok',

            eventsLoaded: economicEvents.length,

            updatedAt: economicCalendarUpdatedAt
        });
    }
);


// ======================================================
// NEWS EVENTS GET
// ======================================================

app.get(
    '/api/news-events',

    (
        req,
        res
    ) => {

        res.json({

            status: 'ok',

            count: economicEvents.length,

            updatedAt: economicCalendarUpdatedAt,

            events: economicEvents
        });
    }
);
// ======================================================
// SCANNER
// ======================================================

// Prevent overlapping manual scans from double-spending REST credits
// and running the same analysis twice when the Scan button is clicked
// repeatedly or two clients call /api/scan at the same time.
let scanInProgress = false;

app.get(
    '/api/scan',

    async(
        req,
        res
    ) => {

        if (!API_KEY) {
            return res.status(503).json({
                status: 'error',
                error: 'Twelve Data API key is not configured. Add TWELVE_DATA_API_KEY to .env and restart the server.'
            });
        }

        if (scanInProgress) {
            return res.status(409).json({
                status: 'busy',
                message: 'A scan is already in progress. Please wait for it to finish.'
            });
        }

        scanInProgress = true;

        try {

        // ==============================================
        // v4.7.3 USER MINIMUM SIGNAL SCORE
        // ==============================================
        //
        // Only approved GUI values are accepted.
        // The analysis engine combines this with each
        // pair-specific safety minimum.
        // ==============================================

        const allowedMinScores =
            [
                50,
                60,
                70,
                80
            ];


        const requestedMinScore =
            Number(
                req.query.minScore
            );


        const userMinScore =
            allowedMinScores.includes(
                requestedMinScore
            )
                ?
                requestedMinScore
                :
                50;


        // v4.8: candidate-score stream is always generated.
        // It is display/research data only and never promotes
        // a setup to TRADE.
        const showWeakSetups =
            true;


        const weakSetupMinScore =
            0;


        const defaultScoreWeights = {
            context: 20,
            setup: 30,
            entry: 25,
            strategy: 15,
            session: 10
        };

        let scoreWeights = { ...defaultScoreWeights };

        if (typeof req.query.weights === 'string') {
            const parts = req.query.weights.split(',').map(Number);
            const valid =
                parts.length === 5 &&
                parts.every(value => Number.isFinite(value) && value >= 0 && value <= 100);
            const total = valid ? parts.reduce((sum,value) => sum + value, 0) : 0;

            if (valid && Math.abs(total - 100) < 0.001) {
                scoreWeights = {
                    context: parts[0],
                    setup: parts[1],
                    entry: parts[2],
                    strategy: parts[3],
                    session: parts[4]
                };
            }
        }


        const results = [];
        const decisions = [];
        const scanStats = {
            pairsAttempted: 0,
            trades: 0,
            waits: 0,
            skips: 0,
            errors: 0
        };


        const newsBlocked = [];


        // ==============================================
        // CURRENT MARKET PERIOD
        // ==============================================

        const marketPeriod =
            getActiveMarketPeriod();


        const activePairs =
            Array.isArray(
                marketPeriod.activePairs
            ) ?
            marketPeriod.activePairs.slice(
                0,
                5
            ) : [];


        // ==============================================
        // KEEP WEBSOCKET SUBSCRIBED TO ACTIVE PAIRS
        // ==============================================

        setRealtimeSymbols(
            activePairs
        );


        console.log(
            ''
        );


        console.log(
            '=========================================='
        );


        console.log(
            'SCAN START'
        );


        console.log(
            'Server UTC:',
            new Date()
            .toISOString()
        );


        console.log(
            'Market period:',
            marketPeriod.label
        );


        console.log(
            'Active pairs:',
            activePairs.length ?
            activePairs.join(
                ', '
            ) :
            'NONE'
        );


        console.log(
            'WebSocket connected:',
            getRealtimeStatus()
            .connected
        );


        console.log(
            'Economic events:',
            economicEvents.length
        );


        console.log(
            'User Min Score:',
            userMinScore,
            '| Effective rule: max(user, pair safety floor)'
        );


        console.log(
            '=========================================='
        );


        // ==============================================
        // SCANNER OFF
        // ==============================================

        if (
            activePairs.length ===
            0
        ) {

            return res.json({

                status: 'ok',

                mode: 'PAPER_ANALYSIS',

                scanned: 0,

                successful: 0,

                errors: 0,

                hiddenDueToNews: 0,

                marketPeriod: {

                    key: marketPeriod.key,

                    label: marketPeriod.label,

                    activePairs: [],

                    scannerEnabled: false
                },

                realtime: getRealtimeStatus(),

                newsFilter: {

                    enabled: true,

                    eventsLoaded: economicEvents.length,

                    blockedCount: 0,

                    blockedPairs: [],

                    calendarUpdatedAt: economicCalendarUpdatedAt
                },

                generatedAt: new Date()
                    .toISOString(),

                montrealTime: getTimeInZone(
                    'America/Toronto'
                ).formatted,

                results: []
            });
        }


        // ==============================================
        // SCAN ACTIVE PAIRS
        // ==============================================

        for (
            const symbol
            of activePairs
        ) {

            scanStats.pairsAttempted++;

            try {

                // ======================================
                // NEWS FILTER
                // ======================================

                const newsRisk =
                    checkNewsRisk(
                        symbol,
                        economicEvents
                    );


                if (
                    newsRisk.blocked
                ) {

                    console.log(
                        ''
                    );


                    console.log(
                        '[NEWS FILTER]',
                        symbol,
                        'SKIPPED'
                    );


                    console.log(
                        'Currency:',
                        newsRisk.currency
                    );


                    console.log(
                        'Event:',
                        newsRisk.event
                    );


                    console.log(
                        'Impact:',
                        newsRisk.impact
                    );


                    console.log(
                        'Minutes until event:',
                        newsRisk.minutesUntilEvent
                    );


                    console.log(
                        'Blocked until:',
                        newsRisk.blockedUntil
                    );


                    scanStats.skips++;

                    decisions.push({
                        symbol,
                        action: 'SKIP',
                        reason: 'NEWS_BLOCKED',
                        signal: 'NO SIGNAL'
                    });

                    newsBlocked.push({

                        symbol: symbol,

                        currency: newsRisk.currency,

                        impact: newsRisk.impact,

                        event: newsRisk.event,

                        eventTime: newsRisk.eventTime,

                        minutesUntilEvent: newsRisk.minutesUntilEvent,

                        blockedUntil: newsRisk.blockedUntil
                    });


                    continue;
                }


                // ======================================
                // LOCAL HISTORY FIRST
                // ======================================
                //
                // REST is used only when history has not
                // been bootstrapped yet, or during the
                // periodic safety resync.
                // ======================================

                let closedCandles =
                    getLocalHistory(
                        symbol
                    );


                if (
                    localHistoryNeedsBootstrap(
                        symbol
                    )
                ) {

                    try {

                        closedCandles =
                            await bootstrapLocalHistory(
                                symbol
                            );


                    } catch (
                        historyError
                    ) {

                        console.error(
                            '[LOCAL HISTORY ERROR]',
                            symbol,
                            historyError.message
                        );


                        // If we already have enough local
                        // candles, keep running without REST.
                        closedCandles =
                            getLocalHistory(
                                symbol
                            );
                    }
                }


                const restSnapshot =
                    latestRestSnapshots.get(
                        symbol
                    ) || null;


                const candleData = {

                    livePrice: restSnapshot ?
                        restSnapshot.livePrice : null,

                    closedCandles: closedCandles,

                    newestApiCandle: restSnapshot ?
                        restSnapshot.newestApiCandle : null,

                    newestClosedCandle: restSnapshot &&
                        restSnapshot.newestClosedCandle ?
                        restSnapshot.newestClosedCandle :
                        (
                            closedCandles.length ?
                            closedCandles[0].datetime : null
                        ),

                    newestClosedAgeSeconds: restSnapshot &&
                        Number.isFinite(
                            Number(
                                restSnapshot.newestClosedAgeSeconds
                            )
                        ) ?
                        Number(
                            restSnapshot.newestClosedAgeSeconds
                        ) :
                        (
                            closedCandles.length ?
                            Math.max(
                                0,
                                Math.floor(
                                    (
                                        Date.now() -
                                        (
                                            parseCandleUtc(
                                                closedCandles[0].datetime
                                            ).getTime() +
                                            60 * 1000
                                        )
                                    ) /
                                    1000
                                )
                            ) : null
                        ),

                    firstCandleIsOpen: restSnapshot ?
                        Boolean(
                            restSnapshot.firstCandleIsOpen
                        ) :
                        Boolean(
                            getRealtimeCurrentCandle(
                                symbol
                            )
                        )
                };


                // ======================================
                // REAL-TIME PRICE
                // ======================================

                const realtime =
                    getLivePrice(
                        symbol
                    );


                const realtimePrice =
                    realtime &&
                    realtime.fresh &&
                    Number.isFinite(
                        Number(
                            realtime.price
                        )
                    ) ?
                    Number(
                        realtime.price
                    ) :
                    null;


                const restLivePrice =
                    Number.isFinite(
                        Number(
                            candleData.livePrice
                        )
                    ) ?
                    Number(
                        candleData.livePrice
                    ) : null;


                const localFallbackPrice =
                    closedCandles.length ?
                    Number(
                        closedCandles[0].close
                    ) :
                    null;


                const livePrice =
                    realtimePrice !==
                    null ?
                    realtimePrice :
                    (
                        restLivePrice !== null ?
                        restLivePrice :
                        (
                            Number.isFinite(
                                localFallbackPrice
                            ) ?
                            localFallbackPrice : null
                        )
                    );


                const livePriceSource =
                    realtimePrice !==
                    null ?
                    'WEBSOCKET' :
                    (
                        restLivePrice !== null ?
                        'REST_LIVE' :
                        'LOCAL_HISTORY_FALLBACK'
                    );


                // ======================================
                // WEBSOCKET CLOSED 1M CANDLES
                // ======================================

                const websocketClosedCandles =
                    getRealtimeClosedCandles(
                        symbol
                    );


                // ======================================
                // MERGE REST + WS CLOSED CANDLES
                // ======================================

                closedCandles =
                    mergeClosedCandles(
                        closedCandles,
                        websocketClosedCandles
                    );


                localHistoricalCandles.set(
                    symbol,
                    closedCandles.slice(
                        0,
                        LOCAL_HISTORY_LIMIT
                    )
                );


                // ======================================
                // VALID PRICE
                // ======================================

                if (!Number.isFinite(
                        Number(
                            livePrice
                        )
                    )) {

                    console.log(
                        '[SCAN SKIP]',
                        symbol,
                        'No valid live price'
                    );

                    scanStats.skips++;
                    decisions.push({
                        symbol,
                        action: 'SKIP',
                        reason: 'NO_VALID_LIVE_PRICE',
                        signal: 'NO SIGNAL'
                    });

                    continue;
                }


                // ======================================
                // ENOUGH CLOSED CANDLES?
                // ======================================

                if (!Array.isArray(
                        closedCandles
                    ) ||
                    closedCandles.length <
                    100
                ) {

                    console.log(
                        '[SCAN SKIP]',
                        symbol,
                        'Not enough closed candles'
                    );

                    scanStats.skips++;
                    decisions.push({
                        symbol,
                        action: 'SKIP',
                        reason: 'NOT_ENOUGH_CLOSED_CANDLES',
                        signal: 'NO SIGNAL'
                    });

                    continue;
                }


                // ======================================
                // ANALYSIS ENGINE
                // ======================================

                const analysis =
                    combinedAnalysis(
                        symbol,
                        closedCandles,
                        livePrice,
                        {
                            userMinScore:
                                userMinScore,
                            scoreWeights:
                                scoreWeights
                        }
                    );


                // ======================================
                // SIGNAL
                // ======================================

                const signal =
                    analysis.signal ||
                    'NO SIGNAL';


                if (
                    signal ===
                    'NO SIGNAL'
                ) {

                    const diagnostics =
                        analysis.signalDiagnostics &&
                        typeof analysis.signalDiagnostics ===
                            'object'
                            ?
                            analysis.signalDiagnostics
                            :
                            {};


                    const weakScore =
                        Number(
                            diagnostics.bestDirectionScore
                        ) || 0;


                    const weakDirection =
                        diagnostics.bestDirection ===
                            'UP' ||
                        diagnostics.bestDirection ===
                            'DOWN'
                            ?
                            diagnostics.bestDirection
                            :
                            null;


                    const weakEdge =
                        Number(
                            diagnostics.actualEdge
                        ) || 0;


                    const weakRequiredEdge =
                        Number(
                            diagnostics.requiredEdge
                        ) || 0;


                    const weakRequiredScore =
                        Number(
                            diagnostics.requiredScore
                        ) || 0;


                    const isWeakWatchCandidate =
                        showWeakSetups &&
                        weakDirection &&
                        weakScore >=
                            weakSetupMinScore &&
                        weakScore <
                            weakRequiredScore &&
                        weakEdge >=
                            weakRequiredEdge;


                    if (
                        isWeakWatchCandidate
                    ) {

                        const blockerText =
                            Array.isArray(
                                diagnostics.blockers
                            ) &&
                            diagnostics.blockers.length
                                ?
                                diagnostics.blockers.join(
                                    '; '
                                )
                                :
                                `Score ${weakScore} is below required ${weakRequiredScore}`;


                        console.log(
                            '[SCAN CANDIDATE]',
                            symbol,
                            weakDirection,
                            '| Score:',
                            weakScore,
                            '| Required:',
                            weakRequiredScore
                        );


                        decisions.push({
                            symbol:
                                symbol,

                            action:
                                'CANDIDATE',

                            decision:
                                'CANDIDATE',

                            reasonCode:
                                'CANDIDATE_SCORE_FILTER',

                            reason:
                                blockerText,

                            signal:
                                weakDirection,

                            score:
                                weakScore,

                            requiredScore:
                                weakRequiredScore,

                            actualEdge:
                                weakEdge,

                            requiredEdge:
                                weakRequiredEdge,

                            strategyName:
                                analysis.primaryStrategy &&
                                analysis.primaryStrategy.name
                                    ?
                                    analysis.primaryStrategy.name
                                    :
                                    (
                                        analysis.strategyName ||
                                        analysis.strategy ||
                                        null
                                    ),

                            entryStatus:
                                'NO ENTRY YET',

                            entryQuality:
                                'CANDIDATE ONLY',

                            strength:
                                'SCORE CANDIDATE',

                            expirationMinutes:
                                null,

                            expirationAt:
                                null,

                            candidateOnly:
                                true
                        });


                        continue;
                    }


                    console.log(
                        '[SCAN SKIP]',
                        symbol,
                        'NO SIGNAL'
                    );

                    scanStats.skips++;
                    decisions.push({
                        symbol,
                        action: 'SKIP',
                        reason: 'NO_SIGNAL',
                        signal: 'NO SIGNAL'
                    });

                    continue;
                }


                const score =
                    Number(
                        analysis.score
                    ) || 0;


                const signalAge =
                    analysis.signalAge || {

                        seconds: candleData
                            .newestClosedAgeSeconds,

                        status: 'UNKNOWN'
                    };


                // ======================================
                // ENTRY ZONE
                // ======================================

                const entryZone =
                    analysis.entryZone || {

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

                        worstEntrySource: null,

                        currentPrice: livePrice,

                        currentEntryQuality: 'NO SIGNAL',

                        currentEntryScore: 0,

                        distanceToBestAtr: null,

                        distanceToLastAcceptableAtr: null,

                        distanceToWorstAtr: null,

                        reason: 'No confirmed market signal'
                    };


                // ======================================
                // SIGNAL STRENGTH
                // ======================================

                const signalStrength =
                    analysis.signalStrength || {

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


                // ======================================
                // EXPIRATION
                // ======================================

                const expiration =
                    analysis.expiration ||
                    null;


                const recommendedExpiration =
                    expiration &&
                    expiration.recommendedMinutes !==
                    undefined &&
                    expiration.recommendedMinutes !==
                    null ?
                    Number(
                        expiration
                        .recommendedMinutes
                    ) :
                    (
                        analysis.recommendedExpiration !==
                        undefined &&
                        analysis.recommendedExpiration !==
                        null ?
                        Number(
                            analysis
                            .recommendedExpiration
                        ) :
                        null
                    );


                // ======================================
                // ABSOLUTE EXPIRATION TIME
                // ======================================
                //
                // Horizon is anchored to the CLOSE of the
                // signal 1M candle, not to the time when
                // REST/analysis finishes.
                // ======================================

                const signalCandleOpenTime =
                    parseCandleUtc(
                        candleData.newestClosedCandle
                    );


                const signalCandleCloseMs =
                    signalCandleOpenTime
                        ?
                        signalCandleOpenTime.getTime() +
                        60 * 1000
                        :
                        null;


                const expirationAtMs =
                    Number.isFinite(
                        recommendedExpiration
                    ) &&
                    Number.isFinite(
                        signalCandleCloseMs
                    )
                        ?
                        signalCandleCloseMs +
                        recommendedExpiration *
                        60 *
                        1000
                        :
                        null;


                const expirationAt =
                    Number.isFinite(
                        expirationAtMs
                    )
                        ?
                        new Date(
                            expirationAtMs
                        )
                        .toISOString()
                        :
                        null;


                const expirationRemainingSeconds =
                    Number.isFinite(
                        expirationAtMs
                    )
                        ?
                        Math.max(
                            0,
                            Math.floor(
                                (
                                    expirationAtMs -
                                    Date.now()
                                ) /
                                1000
                            )
                        )
                        :
                        null;


                const expirationExpired =
                    Number.isFinite(
                        expirationAtMs
                    )
                        ?
                        expirationAtMs <=
                        Date.now()
                        :
                        false;


                // ======================================
                // PRIMARY STRATEGY
                // ======================================

                const primaryStrategy =
                    analysis.primaryStrategy ||
                    (
                        analysis.strategyName ? {
                            name: analysis.strategyName
                        } :
                        (
                            analysis.strategy ? {
                                name: analysis.strategy
                            } :
                            null
                        )
                    );


                // ======================================
                // ENTRY ENGINE / CANDLE CONFIRMATION
                // ======================================

                const entryEngine =
                    analysis.entryEngine ||
                    analysis.entryTiming ||
                    null;

                const candleConfirmation =
                    analysis.candleConfirmation ||
                    null;

                // ======================================
                // EXECUTION GATE
                // ======================================

                // A directional market setup is not automatically an actionable trade.
                // Keep late / poor entries out of Active Signals and the paper logger.
                const entryStatus = String(entryZone.status || '').toUpperCase();
                const entryQuality = String(entryZone.currentEntryQuality || '').toUpperCase();
                const strengthRecommendation = String(signalStrength.recommendation || '').toUpperCase();

                const entryEngineStatus = String(
                    entryEngine && entryEngine.status || ''
                ).toUpperCase();

                const candleConfirmed = Boolean(
                    candleConfirmation &&
                    candleConfirmation.confirmed === true
                );

                const hardEntryBlock =
                    entryStatus.includes('TOO LATE') ||
                    entryQuality.includes('DO NOT ENTER') ||
                    entryQuality.includes('WORST ENTRY') ||
                    strengthRecommendation.includes('NOT RECOMMENDED') ||
                    entryEngineStatus.includes('TOO LATE') ||
                    entryEngineStatus.includes('MTF CONFLICT');

                // v4.9.2 hard gate: a high Score can never bypass missing
                // closed-candle confirmation or a non-actionable Entry Engine.
                const waitEntry =
                    !hardEntryBlock && (
                        !candleConfirmed ||
                        entryEngineStatus !== 'ENTER NOW' ||
                        strengthRecommendation.includes('WAIT') ||
                        entryStatus.includes('WAIT')
                    );

                const executionAction = hardEntryBlock ?
                    'SKIP' :
                    (waitEntry ? 'WAIT' : 'TRADE');

                if (executionAction !== 'TRADE') {
                    console.log(
                        '[SCAN ' + executionAction + ']',
                        symbol,
                        '| signal:', signal,
                        '| entry:', entryZone.status || entryZone.currentEntryQuality || 'N/A',
                        '| strength:', signalStrength.recommendation || signalStrength.level || 'N/A'
                    );

                    if (executionAction === 'WAIT') {
                        scanStats.waits++;
                    } else {
                        scanStats.skips++;
                    }

                    decisions.push({
                        symbol,
                        action: executionAction,
                        signal,
                        score,
                        entryStatus: entryZone.status || null,
                        entryQuality: entryZone.currentEntryQuality || null,
                        strength: signalStrength.recommendation || signalStrength.level || null,

                        strategyName:
                            primaryStrategy &&
                            primaryStrategy.name
                                ?
                                primaryStrategy.name
                                :
                                (
                                    analysis.strategyName ||
                                    analysis.strategy ||
                                    null
                                ),

                        expirationMinutes: Number.isFinite(recommendedExpiration) ?
                            recommendedExpiration :
                            null,

                        expirationAt:
                            expirationAt,

                        expirationAtMs:
                            expirationAtMs,

                        expirationRemainingSeconds:
                            expirationRemainingSeconds,

                        expirationExpired:
                            expirationExpired
                    });

                    continue;
                }


                // ======================================
                // TRADE PRIORITY
                // ======================================

                let tradePriority =
                    analysis.tradePriority;


                if (
                    tradePriority &&
                    typeof tradePriority ===
                    'object'
                ) {

                    tradePriority = {

                        score: Number(
                            tradePriority.score
                        ) || 0,

                        level: tradePriority.level ||
                            null,

                        color: tradePriority.color ||
                            null
                    };

                } else {

                    tradePriority =
                        Number(
                            tradePriority
                        ) || 0;
                }


                // ======================================
                // SESSION
                // ======================================

                const pairSession =
                    getPairSession(
                        symbol
                    );


                // ======================================
                // HTF IMBALANCE
                // ======================================

                const htfImbalanceConfluence =
                    analysis
                    .htfImbalanceConfluence !==
                    undefined &&
                    analysis
                    .htfImbalanceConfluence !==
                    null ?
                    analysis
                    .htfImbalanceConfluence :
                    (
                        analysis
                        .higherTimeframeFvgConfluence !==
                        undefined &&
                        analysis
                        .higherTimeframeFvgConfluence !==
                        null ?
                        analysis
                        .higherTimeframeFvgConfluence :
                        0
                    );


                // ======================================
                // SERVER DIAGNOSTICS
                // ======================================

                console.log(
                    ''
                );


                console.log(
                    '------------------------------------------'
                );


                console.log(
                    symbol
                );


                console.log(
                    'Server UTC:',
                    new Date()
                    .toISOString()
                );


                console.log(
                    'Newest REST candle:',
                    candleData
                    .newestApiCandle
                );


                console.log(
                    'Newest CLOSED REST candle:',
                    candleData
                    .newestClosedCandle
                );


                console.log(
                    'REST closed candle age:',
                    candleData
                    .newestClosedAgeSeconds,
                    'sec'
                );


                console.log(
                    'WS closed 1M candles:',
                    websocketClosedCandles.length
                );


                console.log(
                    'WS current 1M candle:',
                    getRealtimeCurrentCandle(
                        symbol
                    )
                );


                console.log(
                    'Live price:',
                    livePrice
                );


                console.log(
                    'Live price source:',
                    livePriceSource
                );


                console.log(
                    'WebSocket tick age:',
                    realtime ?
                    `${realtime.ageMs} ms` :
                    'N/A'
                );


                console.log(
                    'Merged closed candles:',
                    closedCandles.length
                );


                if (
                    analysis.signalDiagnostics
                ) {

                    console.log(
                        'Signal Diagnostics:',
                        analysis
                        .signalDiagnostics
                    );
                }


                console.log(
                    'UP Score:',
                    analysis.upScore
                );


                console.log(
                    'DOWN Score:',
                    analysis.downScore
                );


                console.log(
                    'Entry Zone:',
                    entryZone
                );


                console.log(
                    'Best Entry:',
                    entryZone
                    .bestEntryPrice
                );


                console.log(
                    'Optimal Zone:',
                    entryZone
                    .bestZoneLow,
                    '-',
                    entryZone
                    .bestZoneHigh
                );


                console.log(
                    'Last Acceptable:',
                    entryZone
                    .lastAcceptablePrice
                );


                console.log(
                    'Do Not Chase:',
                    entryZone
                    .worstEntryPrice
                );


                console.log(
                    'Signal Strength:',
                    signalStrength
                );


                console.log(
                    'Expiration:',
                    expiration
                );


                console.log(
                    'Recommended Expiration:',
                    recommendedExpiration
                );


                console.log(
                    'Trade Priority:',
                    tradePriority
                );


                console.log(
                    'Signal:',
                    signal
                );


                console.log(
                    'Score:',
                    score
                );


                console.log(
                    'Signal age:',
                    signalAge
                );
                // ======================================
                // SIGNAL LOGGER
                // ======================================

                if (
                    signal ===
                    'UP' ||
                    signal ===
                    'DOWN'
                ) {

                    try {

                        logSignal({

                            symbol: symbol,

                            signal: signal,

                            score: score,

                            upScore: Number(analysis.upScore) || 0,

                            downScore: Number(analysis.downScore) || 0,

                            multiTimeframe: analysis.multiTimeframe || null,

                            primaryStrategy: primaryStrategy || null,

                            pairSession: pairSession || null,

                            marketRegime: analysis.marketRegime || null,

                            price: livePrice,

                            livePriceSource: livePriceSource,

                            realtimePriceAgeMs: realtime ?
                                realtime.ageMs : null,

                            referencePrice: analysis
                                .referencePrice ||
                                livePrice,

                            expiration: expiration,

                            expirationMinutes: recommendedExpiration,

                            expirationAt:
                                expirationAt,

                            expirationAtMs:
                                expirationAtMs,

                            expirationRemainingSeconds:
                                expirationRemainingSeconds,

                            signalCandleCloseMs:
                                signalCandleCloseMs,

                            expirationResearch: expiration &&
                                Array.isArray(
                                    expiration.candidates
                                ) ?
                                expiration.candidates : null,

                            strategy: analysis.strategy ||
                                null,

                            strategyName: analysis.strategyName ||
                                null,

                            signalAge: signalAge,

                            signalStrength: signalStrength,

                            entryZone: entryZone,

                            entryQuality: entryZone
                                .currentEntryQuality ||
                                null,

                            entryScore: entryZone
                                .currentEntryScore ||
                                null,

                            marketBias: analysis
                                .marketBias ||
                                (
                                    analysis
                                    .signalDiagnostics ?
                                    analysis
                                    .signalDiagnostics
                                    .marketBias :
                                    null
                                ),

                            signalStage: analysis
                                .signalStage ||
                                (
                                    analysis
                                    .signalDiagnostics ?
                                    analysis
                                    .signalDiagnostics
                                    .signalStage :
                                    null
                                ),

                            session: pairSession,

                            diagnostics: analysis
                                .signalDiagnostics ||
                                null,

                            createdAt: new Date()
                                .toISOString()
                        });


                    } catch (
                        loggerError
                    ) {

                        console.error(
                            '[SIGNAL LOGGER ERROR]',
                            symbol,
                            loggerError.message
                        );
                    }
                }


                // ======================================
                // RESULT FOR GUI
                // ======================================

                scanStats.trades++;
                decisions.push({
                    symbol,
                    action: 'TRADE',
                    signal,
                    score,
                    entryStatus: entryZone.status || null,
                    entryQuality: entryZone.currentEntryQuality || null,
                    strength: signalStrength.recommendation || signalStrength.level || null,

                    strategyName:
                        primaryStrategy &&
                        primaryStrategy.name
                            ?
                            primaryStrategy.name
                            :
                            (
                                analysis.strategyName ||
                                analysis.strategy ||
                                null
                            ),

                    expirationMinutes: Number.isFinite(recommendedExpiration) ?
                        recommendedExpiration :
                        null,

                    expirationAt:
                        expirationAt,

                    expirationAtMs:
                        expirationAtMs,

                    expirationRemainingSeconds:
                        expirationRemainingSeconds,

                    expirationExpired:
                        expirationExpired
                });

                results.push({

                    // ----------------------------------
                    // BASIC
                    // ----------------------------------

                    symbol: symbol,

                    signal: signal,

                    decision: 'TRADE',

                    candleId: candleData.newestClosedCandle &&
                        candleData.newestClosedCandle.datetime ?
                        String(candleData.newestClosedCandle.datetime) :
                        (Number.isFinite(signalCandleCloseMs) ? String(signalCandleCloseMs) : null),

                    analysisId: [
                        symbol,
                        signal,
                        candleData.newestClosedCandle && candleData.newestClosedCandle.datetime ?
                            String(candleData.newestClosedCandle.datetime) :
                            (Number.isFinite(signalCandleCloseMs) ? String(signalCandleCloseMs) : 'NO_CANDLE'),
                        String(score)
                    ].join('|'),

                    score: score,

                    scoreUp: Number(
                        analysis.upScore
                    ) || 0,

                    scoreDown: Number(
                        analysis.downScore
                    ) || 0,


                    // ----------------------------------
                    // TRADE PRIORITY
                    // ----------------------------------

                    tradePriority: tradePriority,


                    // ----------------------------------
                    // PRICE / REALTIME
                    // ----------------------------------

                    livePrice: livePrice,

                    currentPrice: livePrice,

                    livePriceSource: livePriceSource,

                    realtimePriceAgeMs: realtime ?
                        realtime.ageMs : null,

                    realtimePriceFresh: Boolean(
                        realtime &&
                        realtime.fresh
                    ),

                    referencePrice: analysis
                        .referencePrice ||
                        livePrice,

                    watchPrice: analysis.watchPrice !==
                        undefined &&
                        analysis.watchPrice !==
                        null ?
                        analysis.watchPrice :
                        (
                            analysis.referencePrice ||
                            livePrice
                        ),


                    // ----------------------------------
                    // ENTRY POINTS
                    // ----------------------------------

                    bestEntryPrice: entryZone
                        .bestEntryPrice,

                    optimalZoneLow: entryZone
                        .bestZoneLow,

                    optimalZoneHigh: entryZone
                        .bestZoneHigh,

                    lastAcceptablePrice: entryZone
                        .lastAcceptablePrice,

                    doNotChasePrice: entryZone
                        .worstEntryPrice,

                    worstEntryPrice: entryZone
                        .worstEntryPrice,

                    worstEntrySource: entryZone
                        .worstEntrySource ||
                        null,


                    // ----------------------------------
                    // SESSION
                    // ----------------------------------

                    pairSession: pairSession,


                    // ----------------------------------
                    // STRATEGY
                    // ----------------------------------

                    strategy: analysis.strategy ||
                        null,

                    strategyName: analysis.strategyName ||
                        null,

                    primaryStrategy: primaryStrategy,


                    // ----------------------------------
                    // SIGNAL STAGE
                    // ----------------------------------

                    signalStage: analysis.signalStage ||
                        (
                            analysis
                            .signalDiagnostics ?
                            analysis
                            .signalDiagnostics
                            .signalStage :
                            null
                        ),

                    marketBias: analysis.marketBias ||
                        (
                            analysis
                            .signalDiagnostics ?
                            analysis
                            .signalDiagnostics
                            .marketBias :
                            null
                        ),


                    // ----------------------------------
                    // SIGNAL DIAGNOSTICS
                    // ----------------------------------

                    signalDiagnostics: analysis
                        .signalDiagnostics ||
                        null,


                    // ----------------------------------
                    // SIGNAL STRENGTH
                    // ----------------------------------

                    signalStrength: signalStrength,


                    // ----------------------------------
                    // ENTRY ZONE
                    // ----------------------------------

                    entryZone: entryZone,


                    // ----------------------------------
                    // ENTRY ENGINE
                    // ----------------------------------

                    entryTiming: entryEngine,

                    entryEngine: entryEngine,


                    // ----------------------------------
                    // EXPIRATION
                    // ----------------------------------

                    expiration: expiration,

                    recommendedExpiration:
                        recommendedExpiration,

                    // Original model horizon for research.
                    expirationMinutes:
                        recommendedExpiration,

                    // Absolute target anchored to signal candle close.
                    expirationAt:
                        expirationAt,

                    expirationAtMs:
                        expirationAtMs,

                    expirationRemainingSeconds:
                        expirationRemainingSeconds,

                    expirationExpired:
                        expirationExpired,

                    signalCandleCloseAt:
                        Number.isFinite(
                            signalCandleCloseMs
                        )
                            ?
                            new Date(
                                signalCandleCloseMs
                            )
                            .toISOString()
                            :
                            null,

                    expirationScore: expiration &&
                        expiration.recommendedScore !==
                        undefined ?
                        expiration
                        .recommendedScore : null,

                    expirationResearch: expiration &&
                        Array.isArray(
                            expiration.candidates
                        ) ?
                        expiration.candidates : [],


                    // ----------------------------------
                    // SIGNAL AGE
                    // ----------------------------------

                    signalAge: signalAge,


                    // ----------------------------------
                    // SMC
                    // ----------------------------------

                    smc: analysis.smc ||
                        null,


                    // ----------------------------------
                    // MARKET REGIME
                    // ----------------------------------

                    marketRegime: analysis
                        .marketRegime ||
                        null,

                    volatilityRegime: analysis
                        .volatilityRegime ||
                        null,


                    // ----------------------------------
                    // FVG / IMBALANCE
                    // ----------------------------------

                    imbalanceQuality: analysis
                        .imbalanceQuality !==
                        undefined &&
                        analysis
                        .imbalanceQuality !==
                        null ?
                        analysis
                        .imbalanceQuality : null,

                    htfImbalanceConfluence: htfImbalanceConfluence,

                    higherTimeframeFvg: analysis
                        .higherTimeframeFvg !==
                        undefined &&
                        analysis
                        .higherTimeframeFvg !==
                        null ?
                        analysis
                        .higherTimeframeFvg : null,

                    higherTimeframeFvgConfluence: htfImbalanceConfluence,


                    // ----------------------------------
                    // OPPOSING ZONE
                    // ----------------------------------

                    opposingZone: analysis
                        .opposingZone ||
                        null,

                    obstacle: analysis.obstacle ||
                        signalStrength.obstacle ||
                        null,


                    // ----------------------------------
                    // SCORES
                    // ----------------------------------

                    contextScore: analysis.contextScore !==
                        undefined &&
                        analysis.contextScore !==
                        null ?
                        analysis.contextScore : null,

                    setupScore: analysis.setupScore !==
                        undefined &&
                        analysis.setupScore !==
                        null ?
                        analysis.setupScore : null,

                    entryScore: analysis.entryScore !==
                        undefined &&
                        analysis.entryScore !==
                        null ?
                        analysis.entryScore : null,

                    strategyScore: analysis.strategyScore !==
                        undefined &&
                        analysis.strategyScore !==
                        null ?
                        analysis.strategyScore : null,

                    sessionScore: analysis.sessionScore !==
                        undefined &&
                        analysis.sessionScore !==
                        null ?
                        analysis.sessionScore : null,


                    // ----------------------------------
                    // DIRECTIONS
                    // ----------------------------------

                    contextDirection: analysis
                        .contextDirection ||
                        (
                            analysis
                            .signalDiagnostics ?
                            analysis
                            .signalDiagnostics
                            .contextDirection :
                            null
                        ),

                    setupDirection: analysis
                        .setupDirection ||
                        (
                            analysis
                            .signalDiagnostics ?
                            analysis
                            .signalDiagnostics
                            .setupDirection :
                            null
                        ),


                    // ----------------------------------
                    // DATA INFORMATION
                    // ----------------------------------

                    dataStatus: {

                        newestApiCandle: candleData
                            .newestApiCandle,

                        newestClosedCandle: candleData
                            .newestClosedCandle,

                        newestClosedAgeSeconds: candleData
                            .newestClosedAgeSeconds,

                        firstCandleIsOpen: candleData
                            .firstCandleIsOpen,

                        closedCandles: closedCandles.length,

                        websocketClosedCandles: websocketClosedCandles.length,

                        websocketCurrentCandle: getRealtimeCurrentCandle(
                            symbol
                        ),

                        marketData: {

                            source: localHistoryNeedsBootstrap(
                                    symbol
                                ) ?
                                'LOCAL_HISTORY_RESYNC_DUE' : 'LOCAL_HISTORY',

                            localHistoryCandles: closedCandles.length,

                            bootstrappedAt: localHistoryBootstrappedAt.get(
                                    symbol
                                ) ||
                                null
                        },

                        livePriceSource: livePriceSource,

                        realtimePriceAgeMs: realtime ?
                            realtime.ageMs : null,

                        realtimeConnected: getRealtimeStatus()
                            .connected
                    },


                    // ----------------------------------
                    // NEWS
                    // ----------------------------------

                    newsRisk: {

                        blocked: false
                    },


                    // ----------------------------------
                    // FULL ANALYSIS
                    // ----------------------------------

                    analysis: analysis
                });

                // ======================================
                // TELEGRAM TRADE ALERT
                // ======================================
                // Send the CURRENT trade object only after it has been fully
                // constructed. WAIT / SKIP never reach this point.
                const currentTradeResult = results[results.length - 1];

                sendTradeAlert(currentTradeResult)
                    .then(telegramResult => {
                        if (telegramResult.sent) {
                            console.log(
                                '[TELEGRAM SENT]',
                                symbol,
                                signal,
                                '| Score:',
                                score
                            );
                        } else if (telegramResult.reason === 'DUPLICATE_SIGNAL') {
                            console.log(
                                '[TELEGRAM SKIP]',
                                symbol,
                                'duplicate signal'
                            );
                        }
                    })
                    .catch(error => {
                        console.error(
                            '[TELEGRAM ERROR]',
                            symbol,
                            error.message
                        );
                    });


            } catch (
                error
            ) {

                console.error(
                    '[SCAN ERROR]',
                    symbol,
                    error.message
                );

                scanStats.errors++;
                decisions.push({
                    symbol,
                    action: 'ERROR',
                    reason: error.message
                });

                continue;
            }
        }


        // ==============================================
        // CHECK OLD PAPER SIGNALS
        // ==============================================

        try {

            await checkExpiredPaperSignals();

        } catch (
            error
        ) {

            console.error(
                '[SIGNAL RESULT CHECK ERROR]',
                error.message
            );
        }


        // ==============================================
        // SORT RESULTS
        // ==============================================

        results.sort(
            (
                a,
                b
            ) => {

                const priorityA =
                    Number(
                        a.tradePriority &&
                        typeof a.tradePriority ===
                        'object' ?
                        a.tradePriority.score :
                        a.tradePriority
                    ) || 0;


                const priorityB =
                    Number(
                        b.tradePriority &&
                        typeof b.tradePriority ===
                        'object' ?
                        b.tradePriority.score :
                        b.tradePriority
                    ) || 0;


                if (
                    priorityB !==
                    priorityA
                ) {

                    return (
                        priorityB -
                        priorityA
                    );
                }


                return (
                        Number(
                            b.score
                        ) || 0
                    ) -
                    (
                        Number(
                            a.score
                        ) || 0
                    );
            }
        );


        // ==============================================
        // CACHE LATEST SIGNAL SNAPSHOTS
        // ==============================================

        latestSignalSnapshots.clear();


        for (
            const result
            of results
        ) {

            if (
                result &&
                result.symbol
            ) {

                latestSignalSnapshots.set(
                    result.symbol,
                    result
                );
            }
        }


        // ==============================================
        // SCAN COMPLETE
        // ==============================================

        console.log(
            ''
        );


        console.log(
            '=========================================='
        );


        console.log(
            'SCAN COMPLETE'
        );


        console.log(
            'Active signals:',
            results.length
        );


        console.log(
            'Hidden due to news:',
            newsBlocked.length
        );


        if (
            newsBlocked.length
        ) {

            console.log(
                'NEWS BLOCKED:',
                newsBlocked.map(
                    item =>
                    `${item.symbol} (${item.currency}: ${item.event})`
                )
            );
        }


        console.log(
            'WebSocket:',
            getRealtimeStatus()
            .connected ?
            'CONNECTED' :
            'NOT CONNECTED'
        );


        console.log(
            '=========================================='
        );


        // ==============================================
        // RESPONSE
        // ==============================================

        res.json({

            status: 'ok',

            mode: 'PAPER_ANALYSIS',

            scanned: scanStats.pairsAttempted,

            successful: scanStats.pairsAttempted - scanStats.errors,

            activeSignals: results.length,

            errors: scanStats.errors,

            waits: scanStats.waits,

            skips: scanStats.skips,

            hiddenDueToNews: newsBlocked.length,


            // ==========================================
            // SCORE FILTER
            // ==========================================

            scoreFilter: {

                userMinimum:
                    userMinScore,

                rule:
                    'max(User Min Score, Pair Safety Minimum)',

                appliedInsideAnalysis:
                    true
            },


            // ==========================================
            // MARKET PERIOD
            // ==========================================

            marketPeriod: {

                key: marketPeriod.key,

                label: marketPeriod.label,

                activePairs: activePairs,

                scannerEnabled: activePairs.length >
                    0
            },


            // ==========================================
            // REAL-TIME STATUS
            // ==========================================

            realtime: getRealtimeStatus(),


            // ==========================================
            // NEWS FILTER
            // ==========================================

            newsFilter: {

                enabled: true,

                eventsLoaded: economicEvents.length,

                blockedCount: newsBlocked.length,

                blockedPairs: newsBlocked,

                calendarUpdatedAt: economicCalendarUpdatedAt
            },


            // ==========================================
            // TIME
            // ==========================================

            generatedAt: new Date()
                .toISOString(),


            montrealTime: getTimeInZone(
                'America/Toronto'
            ).formatted,


            // ==========================================
            // RESULTS
            // ==========================================

            results: results,

            decisions: decisions,

            scanStats: scanStats
        });

        } finally {
            scanInProgress = false;
        }
    }
);
// ======================================================
// TELEGRAM TEST
// ======================================================

app.post(
    '/api/telegram/test',
    async (req, res) => {
        try {
            const response = await sendTestAlert();

            res.json({
                status: 'ok',
                telegram: 'sent',
                sentCount:
                    response.sentCount,

                failedCount:
                    response.failedCount,

                deliveries:
                    response.deliveries
            });
        } catch (error) {
            console.error('[TELEGRAM TEST ERROR]', error.message);

            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    }
);


// ======================================================
// LOCAL HISTORY STATUS
// ======================================================

app.get(
    '/api/local-history-status',

    (
        req,
        res
    ) => {

        const symbols =
            getAllSessionPairs();


        const history = {};


        for (
            const symbol
            of symbols
        ) {

            const candles =
                getLocalHistory(
                    symbol
                );


            history[symbol] = {

                candles: candles.length,

                newestCandle: candles.length ?
                    candles[0].datetime : null,

                bootstrappedAt: localHistoryBootstrappedAt.get(
                        symbol
                    ) ||
                    null,

                resyncDue: localHistoryNeedsBootstrap(
                    symbol
                )
            };
        }


        res.json({

            status: 'ok',

            historyLimit: LOCAL_HISTORY_LIMIT,

            resyncEveryMinutes: LOCAL_HISTORY_RESYNC_MS /
                60000,

            symbols: history
        });
    }
);


// ======================================================
// VISUAL CHART REVIEW
// ======================================================
//
// Upload exactly one screenshot for each timeframe:
// 1m, 3m, 5m, 15m, 30m.
//
// This is an educational paper-analysis comparison layer.
// It does not replace the numerical entry boundaries.
// ======================================================

app.post(
    '/api/visual-review/:symbol',

    visualReviewUpload.fields(
        [
            {
                name:
                    'm1',

                maxCount:
                    1
            },
            {
                name:
                    'm3',

                maxCount:
                    1
            },
            {
                name:
                    'm5',

                maxCount:
                    1
            },
            {
                name:
                    'm15',

                maxCount:
                    1
            },
            {
                name:
                    'm30',

                maxCount:
                    1
            }
        ]
    ),

    async (
        req,
        res
    ) => {

        try {

            const symbol =
                decodeURIComponent(
                    String(
                        req.params.symbol ||
                        ''
                    )
                );


            const snapshot =
                latestSignalSnapshots.get(
                    symbol
                );


            if (
                !snapshot
            ) {

                return res
                    .status(
                        404
                    )
                    .json({

                        status:
                            'error',

                        error:
                            'No current scanner signal snapshot exists for this pair. Run/refresh the scanner first.'
                    });
            }


            const files =
                req.files ||
                {};


            const images = {

                '1m':
                    files.m1 &&
                    files.m1[0]
                        ?
                        files.m1[0]
                        :
                        null,

                '3m':
                    files.m3 &&
                    files.m3[0]
                        ?
                        files.m3[0]
                        :
                        null,

                '5m':
                    files.m5 &&
                    files.m5[0]
                        ?
                        files.m5[0]
                        :
                        null,

                '15m':
                    files.m15 &&
                    files.m15[0]
                        ?
                        files.m15[0]
                        :
                        null,

                '30m':
                    files.m30 &&
                    files.m30[0]
                        ?
                        files.m30[0]
                        :
                        null
            };


            const missing =
                Object
                    .entries(
                        images
                    )
                    .filter(
                        (
                            [
                                timeframe,
                                file
                            ]
                        ) =>
                            !file
                    )
                    .map(
                        (
                            [
                                timeframe
                            ]
                        ) =>
                            timeframe
                    );


            if (
                missing.length
            ) {

                return res
                    .status(
                        400
                    )
                    .json({

                        status:
                            'error',

                        error:
                            `Missing screenshots: ${missing.join(', ')}`
                    });
            }


            const review =
                await analyzeChartScreenshots({

                    symbol:
                        symbol,

                    signalSnapshot:
                        snapshot,

                    images:
                        images
                });


            return res.json({

                status:
                    'ok',

                symbol:
                    symbol,

                generatedAt:
                    new Date()
                        .toISOString(),

                dataAnalysis: {

                    signal:
                        snapshot.signal,

                    score:
                        snapshot.score,

                    signalStrength:
                        snapshot.signalStrength,

                    entryZone:
                        snapshot.entryZone,

                    entryEngine:
                        snapshot.entryEngine,

                    expiration:
                        snapshot.expiration
                },

                visualAnalysis:
                    review.visual,

                fusionReview:
                    review.fusion,

                model:
                    review.model,

                responseId:
                    review.responseId
            });


        } catch (
            error
        ) {

            console.error(
                '[VISUAL REVIEW ERROR]',
                error.message
            );


            return res
                .status(
                    500
                )
                .json({

                    status:
                        'error',

                    error:
                        error.message
                });
        }
    }
);


// ======================================================
// MULTER ERROR HANDLER
// ======================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        if (
            error instanceof
            multer.MulterError ||
            (
                error &&
                String(
                    error.message ||
                    ''
                )
                .includes(
                    'screenshots'
                )
            ) ||
            (
                error &&
                String(
                    error.message ||
                    ''
                )
                .includes(
                    'PNG'
                )
            )
        ) {

            return res
                .status(
                    400
                )
                .json({

                    status:
                        'error',

                    error:
                        error.message
                });
        }


        next(
            error
        );
    }
);


// ======================================================
// HEALTH
// ======================================================

app.get(
    '/api/health',

    (
        req,
        res
    ) => {

        const marketPeriod =
            getActiveMarketPeriod();


        res.json({

            status: 'ok',

            server: 'Market Data Scanner v7 Modular',

            mode: 'PAPER_ANALYSIS',

            configuredPairs: getAllSessionPairs()
                .length,

            marketPeriod: marketPeriod,

            activePairs: marketPeriod.activePairs,

            apiKeyConfigured: Boolean(
                API_KEY
            ),

            economicCalendarConnected: economicEvents.length >
                0,

            economicCalendarEvents: economicEvents.length,

            economicCalendarUpdatedAt: economicCalendarUpdatedAt,

            marketCache: getMarketDataCacheStatus(),

            realtime: getRealtimeStatus(),

            montrealTime: getTimeInZone(
                'America/Toronto'
            ).formatted,

            time: new Date()
                .toISOString()
        });
    }
);


// ======================================================
// REAL-TIME WEBSOCKET STATUS
// ======================================================

app.get(
    '/api/realtime-status',

    (
        req,
        res
    ) => {

        res.json({

            status: 'ok',

            realtime: getRealtimeStatus()
        });
    }
);


// ======================================================
// SIGNAL HISTORY
// ======================================================

app.get(
    '/api/signal-history',

    (
        req,
        res
    ) => {

        const limit =
            Math.min(

                Math.max(

                    Number(
                        req.query.limit ||
                        100
                    ),

                    1
                ),

                1000
            );


        try {

            const history =
                getSignalHistory(
                    limit
                );


            res.json({

                status: 'ok',

                count: Array.isArray(
                        history
                    ) ?
                    history.length : 0,

                results: history
            });


        } catch (
            error
        ) {

            console.error(
                '[SIGNAL HISTORY ERROR]',
                error.message
            );


            res
                .status(
                    500
                )
                .json({

                    status: 'error',

                    error: error.message
                });
        }
    }
);


// ======================================================
// SIGNAL STATISTICS
// ======================================================

app.get(
    '/api/signal-stats',

    (
        req,
        res
    ) => {

        try {

            const stats =
                getSignalStats();


            res.json({

                status: 'ok',

                stats: stats
            });


        } catch (
            error
        ) {

            console.error(
                '[SIGNAL STATS ERROR]',
                error.message
            );


            res
                .status(
                    500
                )
                .json({

                    status: 'error',

                    error: error.message
                });
        }
    }
);


// ======================================================
// NEWS FILTER STATUS
// ======================================================

app.get(
    '/api/news-status',

    (
        req,
        res
    ) => {

        const blockedNow = [];


        const marketPeriod =
            getActiveMarketPeriod();


        const activePairs =
            Array.isArray(
                marketPeriod.activePairs
            ) ?
            marketPeriod.activePairs : [];


        for (
            const symbol
            of activePairs
        ) {

            const risk =
                checkNewsRisk(
                    symbol,
                    economicEvents
                );


            if (
                risk.blocked
            ) {

                blockedNow.push({

                    symbol: symbol,

                    currency: risk.currency,

                    impact: risk.impact,

                    event: risk.event,

                    eventTime: risk.eventTime,

                    minutesUntilEvent: risk.minutesUntilEvent,

                    blockedUntil: risk.blockedUntil
                });
            }
        }


        res.json({

            status: 'ok',

            enabled: true,

            eventsLoaded: economicEvents.length,

            calendarUpdatedAt: economicCalendarUpdatedAt,

            marketPeriod: marketPeriod,

            activePairs: activePairs,

            blockedCount: blockedNow.length,

            blockedPairs: blockedNow
        });
    }
);


// ======================================================
// MARKET DATA CACHE STATUS
// ======================================================

app.get(
    '/api/market-cache',

    (
        req,
        res
    ) => {

        res.json({

            status: 'ok',

            cache: getMarketDataCacheStatus()
        });
    }
);


// ======================================================
// CLEAR MARKET CACHE
// ======================================================

app.post(
    '/api/market-cache/clear',

    (
        req,
        res
    ) => {

        res.json(
            clearMarketDataCache()
        );
    }
);


// ======================================================
// SIGNAL CHECKER
// ======================================================
//
// Проверяем завершившиеся paper-сигналы
// примерно раз в 2 минуты.
// ======================================================

setInterval(
    () => {

        checkExpiredPaperSignals()
            .catch(
                error => {

                    console.error(
                        '[SIGNAL CHECKER]',
                        error.message
                    );
                }
            );

    },

    120 * 1000
);


// ======================================================
// AUTO SESSION / WEBSOCKET REFRESH
// ======================================================
//
// Сервер может работать часами без нажатия Scan.
//
// Поэтому раз в минуту проверяем:
// изменилась ли торговая сессия.
//
// Если изменилась:
//
// OLD PAIRS
//    ↓
// unsubscribe
//    ↓
// NEW SESSION PAIRS
//    ↓
// subscribe
//
// ======================================================

let lastRealtimePeriodKey =
    null;


setInterval(
    () => {

        try {

            const marketPeriod =
                getActiveMarketPeriod();


            if (
                marketPeriod.key !==
                lastRealtimePeriodKey
            ) {

                lastRealtimePeriodKey =
                    marketPeriod.key;


                console.log(
                    ''
                );


                console.log(
                    '=========================================='
                );


                console.log(
                    '[SESSION CHANGE]',
                    marketPeriod.label
                );


                console.log(
                    '[SESSION PAIRS]',
                    marketPeriod
                    .activePairs
                    .length ?
                    marketPeriod
                    .activePairs
                    .join(
                        ', '
                    ) :
                    'NONE'
                );


                console.log(
                    '=========================================='
                );


                setRealtimeSymbols(
                    marketPeriod.activePairs
                );
            }


        } catch (
            error
        ) {

            console.error(
                '[SESSION REFRESH ERROR]',
                error.message
            );
        }

    },

    60 * 1000
);


// ======================================================
// JSON ERROR HANDLER
// ======================================================
// Keep API failures machine-readable for the GUI (including Multer
// upload-limit/type errors from visual review).
app.use((error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }

    const status = Number(error && error.status) ||
        (error && error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);

    console.error('[HTTP ERROR]', error && error.message ? error.message : error);

    res.status(status).json({
        status: 'error',
        error: error && error.message ? error.message : 'Unexpected server error'
    });
});


// ======================================================
// START SERVER
// ======================================================

app.listen(
    PORT,

    () => {

        const marketPeriod =
            getActiveMarketPeriod();


        lastRealtimePeriodKey =
            marketPeriod.key;


        console.log(
            ''
        );


        console.log(
            '=========================================='
        );


        console.log(
            'Market Data Scanner v7 Modular'
        );


        console.log(
            `http://localhost:${PORT}`
        );


        console.log(
            'Mode: PAPER_ANALYSIS'
        );


        console.log(
            'MTF: 1m / 3m / 5m / 15m / 30m / 1h'
        );


        console.log(
            'Closed candle filter: ENABLED'
        );


        console.log(
            'News filter: ENABLED'
        );


        console.log(
            'Market Data cache/retry: ENABLED'
        );


        console.log(
            `Twelve Data WebSocket: ${realtimeConfig.enabled ? 'ENABLED' : 'DISABLED'}`
        );


        console.log(
            `Realtime 1M candle builder: ${realtimeConfig.enabled ? 'ENABLED' : 'DISABLED'}`
        );


        console.log(
            `Local history from WebSocket: ${realtimeConfig.enabled ? 'ENABLED' : 'DISABLED'}`
        );


        console.log(
            'Visual chart review:',
            process.env.OPENAI_API_KEY
                ?
                'ENABLED'
                :
                'DISABLED — OPENAI_API_KEY missing'
        );


        console.log(
            'REST history policy:',
            realtimeConfig.enabled ?
            'BOOTSTRAP + 30 min safety resync' :
            `REST-only refresh every ~${Math.round(LOCAL_HISTORY_RESYNC_MS / 1000)} sec (cached)`
        );


        console.log(
            'WebSocket stale limit:',
            `${realtimeConfig.staleMs} ms`
        );


        console.log(
            'WebSocket heartbeat:',
            `${realtimeConfig.heartbeatMs} ms`
        );


        console.log(
            'WebSocket reconnect:',
            `${realtimeConfig.reconnectMs} ms`
        );


        console.log(
            'Realtime candle history limit:',
            realtimeConfig.candleHistoryLimit
        );


        console.log(
            'Telegram alerts:',
            isTelegramConfigured()
                ?
                'ENABLED'
                :
                'DISABLED / NOT CONFIGURED'
        );


        console.log(
            'Paper signal checker:',
            '120 sec'
        );


        console.log(
            'Economic calendar events:',
            economicEvents.length
        );


        console.log(
            'Market period:',
            marketPeriod.label
        );


        console.log(
            'Active pairs:',
            marketPeriod
            .activePairs
            .length ?
            marketPeriod
            .activePairs
            .join(
                ', '
            ) :
            'NONE — scanner is OFF'
        );


        // ==============================================
        // START REAL-TIME STREAM
        // ==============================================

        setRealtimeSymbols(
            marketPeriod.activePairs
        );


        console.log(
            '=========================================='
        );
    }
);