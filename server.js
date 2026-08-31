require('dotenv').config();

const realtimeEventMonitor = require('./realtimeMarketData');
const { onRealtimePrice, onRealtimeClosed1mCandle } = realtimeEventMonitor;

const {
    checkNewsRisk
} = require('./newsFilter');

const {
    logSignal,
    resolveSignal,
    getExpiredPendingSignals,
    getSignalHistory,
    getSignalStats,
    observePendingSignals,
    getPendingSignalSymbols
} = require('./signalLogger');

const {
    logScoreDiagnostic,
    getScoreDiagnosticHistory,
    clearScoreDiagnosticHistory
} = require('./scoreDiagnosticsLogger');

const {
    recordStage,
    getPerformanceStats,
    estimateAccuracy
} = require('./signalPerformanceEngine');

const express =
    require(
        'express'
    );


const {
    isTelegramConfigured,
    sendTradeAlert,
    sendEarlyAlert,
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

const {
    trackEntryZone,
    getEntryZoneHistory,
    getEntryZones,
    clearEntryZoneHistory
} = require('./entryZoneHistoryTracker');

const {
    evaluateAdaptivePrefilter
} = require('./adaptivePrefilter');

const {
    scanFvgBirths,
    updateFvgBirthWithAnalysis,
    getFvgBirths,
    getFvgBirthHistory,
    clearFvgBirthHistory
} = require('./fvgBirthTracker');


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


// ======================================================
// SHARED REST PRICE SNAPSHOT — API ECONOMY
// ======================================================
// No outbound request is made here. Consumers reuse the latest
// time_series snapshot produced by the single shared REST updater.
function getSharedRestPrice(symbol) {
    const snapshot = latestRestSnapshots.get(symbol) || null;

    if (snapshot && Number.isFinite(Number(snapshot.livePrice))) {
        return {
            price: Number(snapshot.livePrice),
            source: 'SHARED_TIME_SERIES',
            ageMs: Math.max(0, Date.now() - Number(snapshot.refreshedAt || 0))
        };
    }

    const history = getLocalHistory(symbol);
    if (history.length && Number.isFinite(Number(history[0].close))) {
        return {
            price: Number(history[0].close),
            source: 'LOCAL_LAST_CLOSE',
            ageMs: null
        };
    }

    return { price: null, source: 'NONE', ageMs: null };
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
                        (getLocalHistory(symbol).length ? 'REST INCREMENTAL' : 'REST BOOTSTRAP')
                    );


                    const existingHistory = getLocalHistory(symbol);
                    const isInitialBootstrap = existingHistory.length === 0;
                    const requestedOutputsize = isInitialBootstrap
                        ? 1500
                        : Math.max(3, Math.min(20, Number(process.env.REST_INCREMENTAL_CANDLES) || 5));

                    const data =
                        await getTimeSeries(
                            symbol, {
                                interval: '1min',
                                outputsize: requestedOutputsize
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


                    // IMPORTANT: incremental REST must EXTEND the existing
                    // 1500-candle local history, never replace it with the
                    // small 3-20 candle refresh window. REST wins on duplicate
                    // datetimes, then any completed WS candle is merged on top.
                    const restMerged =
                        mergeCandleLists(
                            existingHistory,
                            prepared.closedCandles
                        );

                    const local =
                        mergeCandleLists(
                            restMerged,
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
    clearMarketDataCache,
    getApiUsageStatus
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
                // SHARED REST SNAPSHOT FALLBACK
                // ======================================
                // Result checks do not spend an extra /price credit.
                const shared = getSharedRestPrice(signal.symbol);
                currentPrice = Number(shared.price);
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


            const outcomeCandles = getLocalHistory(signal.symbol);
            observePendingSignals(signal.symbol, currentPrice, Date.now(), { candles: outcomeCandles });

            resolveSignal(
                signal.id,
                currentPrice,
                { candles: outcomeCandles }
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

function buildExpirationSnapshot(analysis, newestClosedCandleDatetime) {
    const expiration = analysis && analysis.expiration ? analysis.expiration : null;
    const rawMinutes = expiration && expiration.recommendedMinutes !== undefined && expiration.recommendedMinutes !== null
        ? expiration.recommendedMinutes
        : (analysis && analysis.recommendedExpiration !== undefined && analysis.recommendedExpiration !== null
            ? analysis.recommendedExpiration
            : null);
    const expirationMinutes = Number(rawMinutes);
    const openTime = parseCandleUtc(newestClosedCandleDatetime);
    const signalCandleCloseMs = openTime ? openTime.getTime() + 60 * 1000 : null;
    const expirationAtMs = Number.isFinite(expirationMinutes) && Number.isFinite(signalCandleCloseMs)
        ? signalCandleCloseMs + expirationMinutes * 60 * 1000
        : null;
    const expirationAt = Number.isFinite(expirationAtMs) ? new Date(expirationAtMs).toISOString() : null;
    const expirationRemainingSeconds = Number.isFinite(expirationAtMs)
        ? Math.max(0, Math.floor((expirationAtMs - Date.now()) / 1000))
        : null;
    return {
        expiration,
        expirationMinutes: Number.isFinite(expirationMinutes) ? expirationMinutes : null,
        expirationAt,
        expirationAtMs,
        expirationRemainingSeconds,
        expirationExpired: Number.isFinite(expirationAtMs) ? expirationAtMs <= Date.now() : false,
        expirationGenerated: Boolean(Number.isFinite(expirationMinutes) && expirationAt)
    };
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


// ======================================================
// v4.14.4 EVENT-DRIVEN MARKET MONITOR
// REST remains the source for historical/heavy analysis.
// Realtime events only re-evaluate the CURRENT known setup.
// ======================================================

const eventDrivenState = new Map();
const EVENT_RECHECK_MIN_MS = 750;

function rememberAnalysisForRealtime(symbol, analysis) {
    if (!symbol || !analysis) return;

    const zone = analysis.entryZone;
    const diagnostics = analysis.signalDiagnostics;

    eventDrivenState.set(symbol, {
        symbol,
        analysis,
        updatedAt: Date.now(),
        lastRealtimeCheckAt: 0,
        fvgId: zone?.fvgId || null,
        signal: analysis.signal || diagnostics?.bestDirection || null
    });
}

function evaluateRealtimeEntryWindow(symbol, livePrice, trigger = 'PRICE') {
    const state = eventDrivenState.get(symbol);
    if (!state || !state.analysis) return null;

    const now = Date.now();
    if ((now - state.lastRealtimeCheckAt) < EVENT_RECHECK_MIN_MS) return null;
    state.lastRealtimeCheckAt = now;

    const analysis = state.analysis;
    const zone = analysis.entryZone;
    const signal = analysis.signal || analysis.signalDiagnostics?.bestDirection;

    if (!zone?.available || !signal || !Number.isFinite(Number(livePrice))) {
        return null;
    }

    const price = Number(livePrice);
    const best = Number(zone.bestEntryPrice);
    const last = Number(zone.lastAcceptablePrice);
    const worst = Number(zone.worstEntryPrice);

    let realtimeEntryStatus = zone.status || 'UNKNOWN';

    if (signal === 'UP') {
        if (Number.isFinite(worst) && price >= worst) realtimeEntryStatus = 'TOO LATE';
        else if (Number.isFinite(last) && price > last) realtimeEntryStatus = 'BAD ENTRY';
        else if (Number.isFinite(best) && price >= best) realtimeEntryStatus = 'GOOD ENTRY';
    } else if (signal === 'DOWN') {
        if (Number.isFinite(worst) && price <= worst) realtimeEntryStatus = 'TOO LATE';
        else if (Number.isFinite(last) && price < last) realtimeEntryStatus = 'BAD ENTRY';
        else if (Number.isFinite(best) && price <= best) realtimeEntryStatus = 'GOOD ENTRY';
    }

    const strengthScore = Number(analysis.signalStrength?.score || 0);
    const confirmed =
        Boolean(analysis.candleConfirmation?.confirmed) ||
        String(analysis.candleConfirmation?.status || '').toUpperCase() === 'CONFIRMED';

    let realtimeDecision = 'WAIT';

    if (realtimeEntryStatus === 'TOO LATE') {
        realtimeDecision = 'SKIP';
    } else if (
        realtimeEntryStatus === 'GOOD ENTRY' &&
        strengthScore >= 50 &&
        confirmed
    ) {
        realtimeDecision = 'TRADE';
    }

    const result = {
        symbol,
        trigger,
        timestamp: new Date().toISOString(),
        price,
        fvgId: zone.fvgId || null,
        signal,
        entryStatus: realtimeEntryStatus,
        strengthScore,
        confirmed,
        decision: realtimeDecision
    };

    console.log(
        `[REALTIME CHECK] ${symbol} | ${trigger} | ${signal} | ${realtimeEntryStatus} | ` +
        `Strength ${strengthScore} | Confirmed ${confirmed} | ${realtimeDecision}`
    );

    state.lastRealtime = result;
    return result;
}

onRealtimePrice(({ symbol, price }) => {
    evaluateRealtimeEntryWindow(symbol, price, 'PRICE');
});

onRealtimeClosed1mCandle(({ symbol, candle, price }) => {
    const closePrice = Number(price ?? candle?.close);
    if (Number.isFinite(closePrice)) {
        evaluateRealtimeEntryWindow(symbol, closePrice, '1M CLOSE');
    }
});


app.get('/api/realtime-monitor', (req, res) => {
    const data = Array.from(eventDrivenState.values()).map(item => ({
        symbol: item.symbol,
        updatedAt: item.updatedAt,
        fvgId: item.fvgId,
        signal: item.signal,
        lastRealtime: item.lastRealtime || null
    }));

    res.json({
        status: 'ok',
        mode: 'EVENT_DRIVEN_MONITOR',
        realtimeAvailable: typeof onRealtimePrice === 'function',
        pairs: data
    });
});

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
// FAST REST RECHECK WATCHLIST — v4.15
// ======================================================
// REST-only timing observer. Full scans add directional WAIT setups here.
// Between full scans, only watched pairs are force-refreshed and re-analysed.
// This is observational: it does not send Telegram and does not bypass any
// existing full-scan decision gate.

const fastRecheckWatchlist = new Map();
// Keep the latest observed state briefly even after READY/SKIP is removed
// from the active watchlist. This lets the REST-only GUI learn about terminal
// state changes without keeping the market observer alive or spending credits.
const fastRecheckRecent = new Map();
const FAST_RECHECK_RECENT_TTL_MS = Math.max(
    60 * 1000,
    Number(process.env.FAST_RECHECK_RECENT_TTL_MS) || 5 * 60 * 1000
);
let fastRecheckRunning = false;
const FAST_RECHECK_INTERVAL_MS = Math.max(
    15 * 1000,
    Number(process.env.FAST_RECHECK_INTERVAL_MS) || 30 * 1000
);
const FAST_RECHECK_MAX_AGE_MS = Math.max(
    2 * 60 * 1000,
    Number(process.env.FAST_RECHECK_MAX_AGE_MS) || 10 * 60 * 1000
);
const FAST_RECHECK_READY_TIMEOUT_MS = Math.max(
    60 * 1000,
    Number(process.env.FAST_RECHECK_READY_TIMEOUT_MS) || 3 * 60 * 1000
);
// v5.0.1: GET READY is intentionally an early paper-analysis alert.
// Allow a small score gap while all structural/entry/strength gates remain strong.
// Final TRADE still requires the full requiredScore and all strict gates.
const getReadyToleranceEnv = Number(process.env.GET_READY_SCORE_TOLERANCE);
const GET_READY_SCORE_TOLERANCE = Math.max(
    0,
    Math.min(5, Number.isFinite(getReadyToleranceEnv) ? getReadyToleranceEnv : 2)
);
const priorityScanPending = new Set();

function createSetupId(symbol, signal, createdAtMs = Date.now()) {
    return `${String(symbol || '').replace('/', '')}-${signal}-${createdAtMs}`;
}

function requestPrioritySymbolScan(symbol, watch) {
    if (!symbol || priorityScanPending.has(symbol) || scanInProgress) return false;
    priorityScanPending.add(symbol);
    const params = new URLSearchParams({ minScore: String(watch.userMinScore || 50), showWeak: '1', symbol, priority: '1' });
    console.log('[PRIORITY SCAN] requested', symbol, '| setupId:', watch.setupId);
    const http = require('http');
    const request = http.get(`http://127.0.0.1:${PORT}/api/scan?${params.toString()}`, response => {
        response.resume();
        response.on('end', () => {
            priorityScanPending.delete(symbol);
            console.log('[PRIORITY SCAN] completed', symbol, '| status:', response.statusCode);
        });
    });
    request.on('error', error => {
        priorityScanPending.delete(symbol);
        console.warn('[PRIORITY SCAN ERROR]', symbol, error.message);
    });
    request.setTimeout(90 * 1000, () => request.destroy(new Error('Priority scan timeout')));
    return true;
}

function addFastRecheckWatch(symbol, signal, userMinScore, scoreWeights) {
    if (signal !== 'UP' && signal !== 'DOWN') return;
    const now = Date.now();
    const existing = fastRecheckWatchlist.get(symbol);
    // A new full-scan WAIT supersedes any old terminal GUI state.
    fastRecheckRecent.delete(symbol);
    const setupId = existing && existing.signal === signal ? existing.setupId : createSetupId(symbol, signal, now);
    fastRecheckWatchlist.set(symbol, {
        symbol,
        signal,
        setupId,
        userMinScore,
        scoreWeights: { ...scoreWeights },
        addedAt: existing ? existing.addedAt : now,
        updatedAt: now,
        checks: existing ? existing.checks : 0,
        last: existing ? existing.last : null,
        getReadyAt: existing ? existing.getReadyAt : null,
        expirationTelegramSentAt: existing ? existing.expirationTelegramSentAt : null,
        readyAt: existing ? existing.readyAt : null,
        priorityScanRequestedAt: existing ? existing.priorityScanRequestedAt : null
    });

    console.log(
        '[FAST RECHECK WATCH]', symbol, signal,
        '| setupId:', setupId,
        '| watched:', fastRecheckWatchlist.size,
        '| interval:', `${Math.round(FAST_RECHECK_INTERVAL_MS / 1000)}s`
    );

    return fastRecheckWatchlist.get(symbol);
}

function fastRecheckSnapshot() {
    return Array.from(fastRecheckWatchlist.values()).map(item => ({
        symbol: item.symbol,
        signal: item.signal,
        setupId: item.setupId || null,
        addedAt: new Date(item.addedAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        checks: item.checks,
        last: item.last
    }));
}

function fastRecheckRecentSnapshot() {
    const now = Date.now();
    for (const [symbol, item] of fastRecheckRecent.entries()) {
        if (!item || now - item.updatedAt > FAST_RECHECK_RECENT_TTL_MS) {
            fastRecheckRecent.delete(symbol);
        }
    }

    return Array.from(fastRecheckRecent.values()).map(item => ({
        symbol: item.symbol,
        signal: item.signal,
        setupId: item.setupId || null,
        updatedAt: new Date(item.updatedAt).toISOString(),
        last: item.last
    }));
}

async function runFastRestRecheck() {
    if (fastRecheckRunning) {
        console.log('[FAST RECHECK TIMER] skipped | reason: already running');
        return;
    }
    if (scanInProgress) {
        console.log('[FAST RECHECK TIMER] skipped | reason: full scan in progress | watched:', fastRecheckWatchlist.size);
        return;
    }
    if (fastRecheckWatchlist.size === 0) return;

    console.log('[FAST RECHECK TIMER] running | watched:', fastRecheckWatchlist.size);
    fastRecheckRunning = true;
    try {
        for (const [symbol, watch] of Array.from(fastRecheckWatchlist.entries())) {
            const nowMs = Date.now();
            const readyTimedOut = watch.readyAt && nowMs - watch.readyAt > FAST_RECHECK_READY_TIMEOUT_MS;
            if (readyTimedOut || nowMs - watch.addedAt > FAST_RECHECK_MAX_AGE_MS) {
                fastRecheckWatchlist.delete(symbol);
                const terminalStage = readyTimedOut ? 'READY_TIMEOUT' : 'WATCH_TIMEOUT';
                recordStage({ symbol, signal: watch.signal, setupId: watch.setupId, stage: 'SKIP', skipReason: terminalStage, currentPrice: watch.last && watch.last.price });
                console.log('[FAST RECHECK EXPIRE]', symbol, '| reason:', terminalStage, '| setupId:', watch.setupId);
                continue;
            }

            try {
                // v5.0 API Economy: Fast Recheck is analysis-only.
                // It never calls Twelve Data directly. The shared REST updater
                // owns refreshes and Fast Recheck reuses local history/price.
                const closedCandles = getLocalHistory(symbol);
                const sharedPrice = getSharedRestPrice(symbol);
                const livePrice = Number(sharedPrice.price);
                const priceSource = sharedPrice.source;

                console.log(
                    '[SMART REST RECHECK]', symbol,
                    '| history: REUSED',
                    '| price:', priceSource,
                    '| age:', Number.isFinite(sharedPrice.ageMs) ? `${Math.round(sharedPrice.ageMs / 1000)}s` : 'N/A'
                );

                if (!Number.isFinite(livePrice) || closedCandles.length < 200) continue;

                // Reuse the price we already fetched for Fast Recheck; no extra REST credit.
                observePendingSignals(symbol, livePrice, Date.now(), { candles: closedCandles });

                const analysis = combinedAnalysis(symbol, closedCandles, livePrice, {
                    userMinScore: watch.userMinScore,
                    scoreWeights: watch.scoreWeights
                });

                const signal = analysis && (analysis.signal || analysis.bestDirection);
                const entryZone = analysis && analysis.entryZone ? analysis.entryZone : {};
                const strength = analysis && analysis.signalStrength ? analysis.signalStrength : {};
                const cc = analysis && analysis.candleConfirmation ? analysis.candleConfirmation : null;
                const diagnostics = analysis && analysis.signalDiagnostics ? analysis.signalDiagnostics : {};
                const score = Number(diagnostics.bestDirectionScore ?? analysis.bestDirectionScore ?? 0);
                const requiredScore = Number(diagnostics.requiredScore ?? diagnostics.effectiveMinScore ?? 0);
                const expirationSnapshot = buildExpirationSnapshot(analysis, closedCandles.length ? closedCandles[0].datetime : null);

                const entryStatus = String(entryZone.status || '').toUpperCase();
                const entryQuality = String(entryZone.currentEntryQuality || '').toUpperCase();
                const strengthRecommendation = String(strength.recommendation || '').toUpperCase();
                // Persistent Candidate Watch (v4.17.3): a candidate that was deliberately
                // placed on the watchlist must not be removed merely because it is still below
                // the final TRADE score. Keep observing while it remains above the candidate floor.
                // Final GET_READY/TRADE thresholds remain unchanged.
                const candidateWatchFloor = Number(diagnostics.candidateWatchFloor ?? 35);
                const hardBlock =
                    signal !== watch.signal ||
                    score < candidateWatchFloor ||
                    diagnostics.contextSetupConflict === true ||
                    entryStatus.includes('TOO LATE') ||
                    entryQuality.includes('DO NOT ENTER') ||
                    entryQuality.includes('WORST ENTRY') ||
                    strengthRecommendation.includes('NOT RECOMMENDED');
                const wait = !hardBlock && (
                    strengthRecommendation.includes('WAIT') ||
                    entryStatus.includes('WAIT') ||
                    !(cc && cc.confirmed === true)
                );
                const state = hardBlock ? 'SKIP' : (wait ? 'WAIT' : 'READY');

                const tf = cc && cc.timeframes ? cc.timeframes : {};
                const fmt = value => {
                    if (!value || value.available === false) return 'N/A';
                    const label = value.confirmed ? 'YES' : (value.opposite ? 'OPPOSITE' : 'NO');
                    return `${label} ${value.expectedScore ?? 0}/${value.oppositeScore ?? 0}`;
                };

                watch.checks += 1;
                watch.updatedAt = Date.now();
                watch.last = {
                    at: new Date().toISOString(),
                    state,
                    score,
                    requiredScore,
                    candidateWatchFloor,
                    entryStatus: entryZone.status || null,
                    entryQuality: entryZone.currentEntryQuality || null,
                    strength: strength.recommendation || strength.level || null,
                    candleConfirmed: Boolean(cc && cc.confirmed),
                    m1: fmt(tf.m1),
                    m3: fmt(tf.m3),
                    m5: fmt(tf.m5),
                    price: livePrice,
                    // Full WAIT snapshot for REST-only GUI live refresh.
                    // Keep this focused on display fields so /api/fast-recheck stays lightweight.
                    gui: {
                        livePrice,
                        currentPrice: livePrice,
                        scoreUp: Number(analysis.upScore) || 0,
                        scoreDown: Number(analysis.downScore) || 0,
                        marketBias: analysis.marketBias || diagnostics.marketBias || null,
                        signalStage: analysis.signalStage || diagnostics.signalStage || null,
                        entryZone: entryZone || null,
                        signalStrength: strength || null,
                        candleConfirmation: cc || null,
                        signalDiagnostics: diagnostics || null,
                        strategyName: analysis.strategyName || analysis.strategy || null,
                        expiration: expirationSnapshot.expiration,
                        expirationMinutes: expirationSnapshot.expirationMinutes,
                        expirationAt: expirationSnapshot.expirationAt,
                        expirationAtMs: expirationSnapshot.expirationAtMs,
                        expirationRemainingSeconds: expirationSnapshot.expirationRemainingSeconds,
                        expirationExpired: expirationSnapshot.expirationExpired,
                        referencePrice: analysis.referencePrice || livePrice,
                        watchPrice: analysis.watchPrice !== undefined ? analysis.watchPrice : null,
                        historicalEffectiveness: estimateAccuracy({
                            symbol, signal: watch.signal, score, entryZone,
                            signalStrength: strength, candleConfirmation: cc,
                            signalDiagnostics: diagnostics
                        }, getSignalHistory(5000))
                    }
                };

                fastRecheckRecent.set(symbol, {
                    symbol,
                    signal: watch.signal,
                    setupId: watch.setupId,
                    updatedAt: watch.updatedAt,
                    last: { ...watch.last }
                });

                console.log(
                    '[FAST RECHECK]', symbol, watch.signal,
                    '| state:', state,
                    '| score:', `${score}/${requiredScore}`,
                    '| candidate floor:', candidateWatchFloor,
                    '| entry:', entryZone.status || entryZone.currentEntryQuality || 'N/A',
                    '| strength:', strength.recommendation || strength.level || 'N/A',
                    '| candle:', cc && cc.confirmed ? 'CONFIRMED' : 'WAIT',
                    '| 1M:', fmt(tf.m1),
                    '| 3M:', fmt(tf.m3),
                    '| 5M:', fmt(tf.m5)
                );

                const perfPayload = {
                    symbol,
                    signal: watch.signal,
                    setupId: watch.setupId,
                    stage: state,
                    score,
                    requiredScore,
                    currentPrice: livePrice,
                    marketBias: analysis.marketBias,
                    signalStage: analysis.signalStage,
                    entryZone,
                    signalStrength: strength,
                    candleConfirmation: cc,
                    signalDiagnostics: diagnostics,
                    strategyName: analysis.strategyName || analysis.strategy || null,
                    expiration: expirationSnapshot.expiration,
                    expirationMinutes: expirationSnapshot.expirationMinutes,
                    expirationAt: expirationSnapshot.expirationAt,
                    expirationAtMs: expirationSnapshot.expirationAtMs,
                    expirationRemainingSeconds: expirationSnapshot.expirationRemainingSeconds,
                    expirationExpired: expirationSnapshot.expirationExpired
                };
                recordStage(perfPayload);

                const frEntry = String(entryZone.currentEntryQuality || entryZone.status || '').toUpperCase();
                const frStrength = Number(strength.score) || 0;
                const frGetReadyScoreFloor = Math.max(candidateWatchFloor, requiredScore - GET_READY_SCORE_TOLERANCE);
                const frGetReady = state === 'WAIT' && score >= frGetReadyScoreFloor &&
                    Number(diagnostics.actualEdge || 0) >= Number(diagnostics.requiredEdge || 0) &&
                    diagnostics.contextSetupConflict !== true && frStrength >= 45 &&
                    !frEntry.includes('BAD') && !frEntry.includes('WORST') && !frEntry.includes('DO NOT ENTER') &&
                    !String(entryZone.status || '').toUpperCase().includes('TOO LATE');
                if (frGetReady) {
                    if (!watch.getReadyAt) {
                        watch.getReadyAt = Date.now();
                        recordStage({ ...perfPayload, stage: 'GET_READY' });
                    }
                    if (expirationSnapshot.expirationGenerated && !expirationSnapshot.expirationExpired && !watch.expirationTelegramSentAt) {
                        const gr = { ...perfPayload, stage: 'GET_READY' };
                        sendEarlyAlert(gr)
                            .then(r => {
                                if (r.sent) watch.expirationTelegramSentAt = Date.now();
                                console.log(r.sent ? '[TELEGRAM EXPIRATION SENT]' : '[TELEGRAM EXPIRATION SKIP]', symbol, '|', r.reason || 'GET_READY');
                            })
                            .catch(e => console.error('[TELEGRAM EXPIRATION ERROR]', symbol, e.message));
                    } else if (!expirationSnapshot.expirationGenerated) {
                        console.log('[TELEGRAM EXPIRATION WAIT]', symbol, '| expiration not generated yet');
                    }
                }

                // v5.0: READY is a transition, not a terminal state. Keep observing and
                // request the strict full pipeline for this pair immediately.
                if (state === 'READY') {
                    if (!watch.readyAt) watch.readyAt = Date.now();
                    const lastPriority = Number(watch.priorityScanRequestedAt || 0);
                    if (Date.now() - lastPriority >= 30 * 1000 && requestPrioritySymbolScan(symbol, watch)) {
                        watch.priorityScanRequestedAt = Date.now();
                    }
                }
                if (state === 'SKIP') {
                    console.log('[FAST RECHECK REMOVE]', symbol, '| invalidated | setupId:', watch.setupId);
                    fastRecheckWatchlist.delete(symbol);
                }
            } catch (error) {
                console.warn('[FAST RECHECK ERROR]', symbol, error.message);
            }
        }
    } finally {
        fastRecheckRunning = false;
    }
}

setInterval(runFastRestRecheck, FAST_RECHECK_INTERVAL_MS);

app.get('/api/fast-recheck', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        enabled: true,
        mode: 'SMART_REST_OBSERVATIONAL',
        intervalMs: FAST_RECHECK_INTERVAL_MS,
        maxAgeMs: FAST_RECHECK_MAX_AGE_MS,
        running: fastRecheckRunning,
        watched: fastRecheckSnapshot(),
        recent: fastRecheckRecentSnapshot()
    });
});

// ======================================================
// SCANNER
// ======================================================

// Prevent overlapping manual scans from double-spending REST credits
// and running the same analysis twice when the Scan button is clicked
// repeatedly or two clients call /api/scan at the same time.
let scanInProgress = false;

// v4.17.1 — server-side Auto Scan.
// The first manual /api/scan arms one repeating scan every 10 minutes.
// It keeps running while the Node server is alive, even if the browser is closed.
const AUTO_SCAN_INTERVAL_MS = Math.max(10 * 60 * 1000, Number(process.env.AUTO_SCAN_INTERVAL_MS) || 10 * 60 * 1000);
let autoScanTimer = null;
let autoScanEnabled = false;
let autoScanQuery = 'minScore=50&showWeak=1';
let autoScanLastStartedAt = null;
let autoScanNextAt = null;

function scheduleAutoScan() {
    if (autoScanTimer) clearTimeout(autoScanTimer);
    if (!autoScanEnabled) return;
    autoScanNextAt = new Date(Date.now() + AUTO_SCAN_INTERVAL_MS).toISOString();
    autoScanTimer = setTimeout(() => {
        autoScanTimer = null;
        if (scanInProgress) {
            console.log('[AUTO SCAN] skipped: scan already in progress');
            scheduleAutoScan();
            return;
        }
        autoScanLastStartedAt = new Date().toISOString();
        console.log('[AUTO SCAN] starting | next cycle interval:', Math.round(AUTO_SCAN_INTERVAL_MS / 60000), 'min');
        const http = require('http');
        const request = http.get(`http://127.0.0.1:${PORT}/api/scan?${autoScanQuery}&auto=1`, response => {
            response.resume();
            response.on('end', () => scheduleAutoScan());
        });
        request.on('error', error => {
            console.warn('[AUTO SCAN ERROR]', error.message);
            scheduleAutoScan();
        });
        request.setTimeout(Math.max(60000, AUTO_SCAN_INTERVAL_MS), () => request.destroy(new Error('Auto scan request timeout')));
    }, AUTO_SCAN_INTERVAL_MS);
}

function armAutoScanFromRequest(req) {
    if (String(req.query.auto || '') === '1' || String(req.query.priority || '') === '1') return;
    const params = new URLSearchParams();
    for (const key of ['minScore', 'showWeak', 'weights']) {
        if (req.query[key] !== undefined) params.set(key, String(req.query[key]));
    }
    autoScanQuery = params.toString() || 'minScore=50&showWeak=1';
    if (!autoScanEnabled) console.log('[AUTO SCAN] armed after manual scan | interval:', Math.round(AUTO_SCAN_INTERVAL_MS / 60000), 'min');
    autoScanEnabled = true;
    scheduleAutoScan();
}


// ======================================================
// v5.0.7 API ECONOMY V3 — SINGLE SHARED REST UPDATER
// ======================================================
// One owner of recurring time_series requests. Default 12s tick means
// no more than ~5 scheduled refresh attempts/minute, leaving headroom
// under the existing 7/min REST Credit Manager.
const SHARED_REST_UPDATER_TICK_MS = Math.max(
    10 * 1000,
    Number(process.env.SHARED_REST_UPDATER_TICK_MS) || 12 * 1000
);
let sharedRestUpdaterRunning = false;
let sharedRestUpdaterIndex = 0;
let sharedRestUpdaterLast = null;

function getSharedRestRefreshQueue() {
    const period = getActiveMarketPeriod();
    const queue = [];
    const seen = new Set();

    const add = symbol => {
        const key = String(symbol || '').trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        queue.push(key);
    };

    for (const symbol of (period.activePairs || [])) add(symbol);
    for (const symbol of fastRecheckWatchlist.keys()) add(symbol);
    for (const symbol of getPendingSignalSymbols()) add(symbol);

    return queue;
}

async function runSharedRestUpdater() {
    if (!autoScanEnabled || sharedRestUpdaterRunning || scanInProgress) return;

    const queue = getSharedRestRefreshQueue();
    if (!queue.length) return;

    sharedRestUpdaterIndex = sharedRestUpdaterIndex % queue.length;
    const symbol = queue[sharedRestUpdaterIndex];
    sharedRestUpdaterIndex = (sharedRestUpdaterIndex + 1) % queue.length;

    if (!localHistoryNeedsBootstrap(symbol)) return;

    sharedRestUpdaterRunning = true;
    try {
        const before = getLocalHistory(symbol).length;
        await bootstrapLocalHistory(symbol, false);
        const shared = getSharedRestPrice(symbol);
        sharedRestUpdaterLast = {
            symbol,
            at: new Date().toISOString(),
            mode: before < 100 ? 'BOOTSTRAP' : 'INCREMENTAL',
            priceSource: shared.source
        };
        console.log(
            '[SHARED REST UPDATER]', symbol,
            '|', sharedRestUpdaterLast.mode,
            '| next tick:', `${Math.round(SHARED_REST_UPDATER_TICK_MS / 1000)}s`
        );
    } catch (error) {
        console.warn('[SHARED REST UPDATER ERROR]', symbol, error.message);
    } finally {
        sharedRestUpdaterRunning = false;
    }
}

setInterval(() => {
    runSharedRestUpdater().catch(error =>
        console.warn('[SHARED REST UPDATER ERROR]', error.message)
    );
}, SHARED_REST_UPDATER_TICK_MS);


// ======================================================
// v5.0.3 — LIGHTWEIGHT CANDIDATE DISCOVERY
// ======================================================
// Full market scan stays on the 10-minute Auto Scan cadence.
// Between full scans, refresh a small session-ranked universe every 2 minutes,
// run only the existing adaptive prefilter, and request a strict single-pair
// priority scan for promising NEW candidates. This does not create TRADE,
// GET_READY, WAIT, or GUI signals by itself; the normal full decision pipeline
// remains authoritative.
const CANDIDATE_DISCOVERY_INTERVAL_MS = Math.max(
    2 * 60 * 1000,
    Number(process.env.CANDIDATE_DISCOVERY_INTERVAL_MS) || 2 * 60 * 1000
);
const CANDIDATE_DISCOVERY_REFRESH_OUTPUTSIZE = Math.max(
    120,
    Math.min(300, Number(process.env.CANDIDATE_DISCOVERY_REFRESH_OUTPUTSIZE) || 180)
);
const CANDIDATE_DISCOVERY_PREFILTER_MIN = Math.max(
    28,
    Math.min(100, Number(process.env.CANDIDATE_DISCOVERY_PREFILTER_MIN) || 45)
);
const CANDIDATE_DISCOVERY_PAIR_LIMIT = Math.max(
    1,
    Math.min(5, Number(process.env.CANDIDATE_DISCOVERY_PAIR_LIMIT) || 5)
);
const CANDIDATE_DISCOVERY_PRIORITY_COOLDOWN_MS = Math.max(
    2 * 60 * 1000,
    Number(process.env.CANDIDATE_DISCOVERY_PRIORITY_COOLDOWN_MS) || 5 * 60 * 1000
);
let candidateDiscoveryRunning = false;
let candidateDiscoveryLastStartedAt = null;
let candidateDiscoveryLastCompletedAt = null;
let candidateDiscoveryLastResults = [];
const candidateDiscoveryPriorityAt = new Map();
// Pair + latest closed 1M candle dedupe. Prevents Candidate Discovery from
// re-running the same strict priority scan on unchanged market data.
const candidateDiscoveryPriorityCandleKey = new Map();

function getLatestClosed1mKey(symbol) {
    const history = getLocalHistory(symbol);
    if (!Array.isArray(history) || !history.length) return null;

    const candle = history[0];
    const parsed = candle && candle.datetime ? parseCandleUtc(candle.datetime) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
        return candle && candle.datetime ? String(candle.datetime) : null;
    }

    // Normalize to the minute so formatting differences cannot bypass dedupe.
    return String(Math.floor(parsed.getTime() / 60000));
}

async function refreshDiscoveryHistory(symbol) {
    // v5.0 API Economy: Candidate Discovery is strictly local.
    // It must never own REST requests; the shared updater refreshes history.
    return getLocalHistory(symbol);
}

function requestDiscoveryPriorityScan(symbol) {
    if (!symbol || priorityScanPending.has(symbol) || scanInProgress) return false;

    const candleKey = getLatestClosed1mKey(symbol);
    if (candleKey && candidateDiscoveryPriorityCandleKey.get(symbol) === candleKey) {
        console.log('[CANDIDATE DISCOVERY] priority scan deduped', symbol, '| closed1m:', candleKey);
        return false;
    }

    const last = Number(candidateDiscoveryPriorityAt.get(symbol)) || 0;
    if ((Date.now() - last) < CANDIDATE_DISCOVERY_PRIORITY_COOLDOWN_MS) return false;

    candidateDiscoveryPriorityAt.set(symbol, Date.now());
    if (candleKey) candidateDiscoveryPriorityCandleKey.set(symbol, candleKey);
    priorityScanPending.add(symbol);
    const params = new URLSearchParams({ minScore: '50', showWeak: '1', symbol, priority: '1', discovery: '1' });
    console.log('[CANDIDATE DISCOVERY] priority scan requested', symbol);
    const http = require('http');
    const request = http.get(`http://127.0.0.1:${PORT}/api/scan?${params.toString()}`, response => {
        response.resume();
        response.on('end', () => {
            priorityScanPending.delete(symbol);
            console.log('[CANDIDATE DISCOVERY] priority scan completed', symbol, '| status:', response.statusCode);
        });
    });
    request.on('error', error => {
        priorityScanPending.delete(symbol);
        console.warn('[CANDIDATE DISCOVERY ERROR]', symbol, error.message);
    });
    request.setTimeout(90 * 1000, () => request.destroy(new Error('Candidate discovery priority scan timeout')));
    return true;
}

async function runCandidateDiscovery() {
    if (!autoScanEnabled || candidateDiscoveryRunning || scanInProgress || fastRecheckRunning) return;
    candidateDiscoveryRunning = true;
    candidateDiscoveryLastStartedAt = new Date().toISOString();
    const rows = [];
    try {
        const period = getActiveMarketPeriod();
        if (period.key === 'ROLLOVER') return;
        const ranked = getRankedSessionPairs(period.key, CANDIDATE_DISCOVERY_PAIR_LIMIT);
        const maxSessionScore = Math.max(1, ...ranked.map(item => Number(item.sessionScore) || 0));
        console.log('[CANDIDATE DISCOVERY] starting | pairs:', ranked.map(x => x.symbol).join(', '));
        for (const item of ranked) {
            if (scanInProgress) break;
            try {
                const history = await refreshDiscoveryHistory(item.symbol);
                if (!Array.isArray(history) || history.length < 120) continue;
                scanFvgBirths(item.symbol, history);
                const prefilter = evaluateAdaptivePrefilter({
                    symbol: item.symbol,
                    oneMinuteCandles: history,
                    sessionScore: item.sessionScore,
                    maxSessionScore
                });
                const row = {
                    symbol: item.symbol,
                    prefilterScore: Number(prefilter.prefilterScore) || 0,
                    priorityScore: Number(prefilter.priorityScore) || 0,
                    opportunityBonus: Number(prefilter.opportunityBonus) || 0,
                    priorityRequested: false
                };
                const alreadyWatched = fastRecheckWatchlist.has(item.symbol);
                row.alreadyWatched = alreadyWatched;
                rows.push(row);
                console.log('[CANDIDATE DISCOVERY]', item.symbol,
                    '| prefilter:', row.prefilterScore,
                    '| priority:', row.priorityScore,
                    '| watched:', alreadyWatched);
            } catch (error) {
                rows.push({ symbol: item.symbol, error: error.message });
                console.warn('[CANDIDATE DISCOVERY ERROR]', item.symbol, error.message);
            }
        }

        // Request at most ONE strict priority scan per discovery cycle.
        // This avoids overlapping internal scans and keeps REST usage predictable.
        const bestNewCandidate = rows
            .filter(row => !row.error && !row.alreadyWatched && row.priorityScore >= CANDIDATE_DISCOVERY_PREFILTER_MIN)
            .sort((a, b) => b.priorityScore - a.priorityScore)[0];
        if (bestNewCandidate && !scanInProgress) {
            bestNewCandidate.priorityRequested = requestDiscoveryPriorityScan(bestNewCandidate.symbol);
        }
    } finally {
        candidateDiscoveryLastResults = rows;
        candidateDiscoveryLastCompletedAt = new Date().toISOString();
        candidateDiscoveryRunning = false;
    }
}

setInterval(() => {
    runCandidateDiscovery().catch(error => console.warn('[CANDIDATE DISCOVERY ERROR]', error.message));
}, CANDIDATE_DISCOVERY_INTERVAL_MS);

app.get('/api/candidate-discovery', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        enabled: autoScanEnabled,
        running: candidateDiscoveryRunning,
        intervalMs: CANDIDATE_DISCOVERY_INTERVAL_MS,
        intervalMinutes: CANDIDATE_DISCOVERY_INTERVAL_MS / 60000,
        prefilterMin: CANDIDATE_DISCOVERY_PREFILTER_MIN,
        pairLimit: CANDIDATE_DISCOVERY_PAIR_LIMIT,
        lastStartedAt: candidateDiscoveryLastStartedAt,
        lastCompletedAt: candidateDiscoveryLastCompletedAt,
        results: candidateDiscoveryLastResults
    });
});

app.get('/api/auto-scan', (req, res) => {
    res.json({
        status: 'ok',
        enabled: autoScanEnabled,
        intervalMs: AUTO_SCAN_INTERVAL_MS,
        intervalMinutes: AUTO_SCAN_INTERVAL_MS / 60000,
        lastStartedAt: autoScanLastStartedAt,
        nextAt: autoScanNextAt,
        scanInProgress,
        apiUsage: getApiUsageStatus(),
        apiEconomy: {
            sharedRestUpdater: true,
            updaterTickMs: SHARED_REST_UPDATER_TICK_MS,
            updaterRunning: sharedRestUpdaterRunning,
            lastRefresh: sharedRestUpdaterLast,
            candidateDiscoveryUsesRest: false,
            fastRecheckUsesRest: false
        }
    });
});

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

        armAutoScanFromRequest(req);

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


        // v4.9.8 Unified Candidate Gate:
        // Keep server weak-watch output consistent with analysisEngine.
        // 35-<required = CANDIDATE / WAIT, below 35 = NO SIGNAL.
        const weakSetupMinScore =
            35;


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


        // ==============================================
        // ADAPTIVE SESSION PREFILTER — v4.14.4
        // ==============================================
        // 17 pairs -> session Top 8 -> lightweight local
        // prefilter -> dynamic Top 5 -> existing scanner.
        // The prefilter never creates a signal and cannot
        // bypass Score / Entry / Candle / TOO LATE gates.
        // ==============================================

        const sessionTop8 =
            getRankedSessionPairs(
                marketPeriod.key,
                8
            );

        const prefilterRanking = [];

        if (
            marketPeriod.key !== 'ROLLOVER' &&
            sessionTop8.length
        ) {

            const maxSessionScore =
                Math.max(
                    1,
                    ...sessionTop8.map(
                        item => Number(item.sessionScore) || 0
                    )
                );

            for (const item of sessionTop8) {
                try {
                    // IMPORTANT v4.13.1:
                    // Prefilter must NOT bootstrap all Top-8 pairs.
                    // Doing 8 sequential 1500-candle REST bootstraps before
                    // the normal scanner loop can make the scan look frozen
                    // and can exhaust/rate-limit the data provider.
                    //
                    // Prefilter uses LOCAL history only. If a pair has not
                    // been bootstrapped yet, it stays eligible through a
                    // lightweight session fallback. The normal full-analysis
                    // loop bootstraps only the selected Top-5 pairs.
                    const history =
                        getLocalHistory(
                            item.symbol
                        );

                    if (
                        Array.isArray(history) &&
                        history.length >= 120
                    ) {
                        // Observe structural FVG birth only from already
                        // available CLOSED local candles.
                        const bornZones =
                            scanFvgBirths(
                                item.symbol,
                                history
                            );

                        if (bornZones.length) {
                            console.log(
                                '[FVG BIRTH]',
                                item.symbol,
                                '| New:',
                                bornZones.length
                            );
                        }

                        const prefilter =
                            evaluateAdaptivePrefilter({
                                symbol: item.symbol,
                                oneMinuteCandles: history,
                                sessionScore: item.sessionScore,
                                maxSessionScore: maxSessionScore
                            });

                        prefilterRanking.push({
                            ...prefilter,
                            sessionScore: item.sessionScore,
                            historyReady: true
                        });

                    } else {
                        // Fail-open fallback for a cold start.
                        // Session score is mapped into the 0..100 ranking
                        // space so scanner remains responsive and the pair
                        // can still be selected for normal bootstrap.
                        const sessionOnlyScore =
                            Math.round(
                                Math.max(
                                    0,
                                    Math.min(
                                        100,
                                        (
                                            (Number(item.sessionScore) || 0) /
                                            maxSessionScore
                                        ) * 100
                                    )
                                ) * 10
                            ) / 10;

                        prefilterRanking.push({
                            symbol: item.symbol,
                            prefilterScore: sessionOnlyScore,
                            priorityScore: sessionOnlyScore,
                            opportunityBonus: 0,
                            contextDirection: 'UNKNOWN',
                            components: {
                                context30M: 0,
                                setup15M: 0,
                                momentum5M: 0,
                                volatilityATR: 0,
                                sessionRelevance:
                                    Math.round(
                                        (
                                            (Number(item.sessionScore) || 0) /
                                            maxSessionScore
                                        ) * 10
                                    )
                            },
                            entryOpportunity: null,
                            currentPrice: null,
                            sessionScore: item.sessionScore,
                            historyReady: false,
                            fallbackReason:
                                'LOCAL_HISTORY_NOT_READY'
                        });
                    }

                } catch (prefilterError) {
                    console.warn(
                        '[PREFILTER ERROR]',
                        item.symbol,
                        prefilterError.message
                    );
                }
            }
        }

        const passedPrefilter =
            prefilterRanking
            .filter(
                item => Number(item.prefilterScore) >= 28
            )
            .sort(
                (a, b) =>
                    Number(b.priorityScore) -
                    Number(a.priorityScore)
            );

        // If fewer than 5 pass 28, fill remaining slots
        // with the strongest successfully evaluated pairs.
        const fallbackPrefilter =
            prefilterRanking
            .slice()
            .sort(
                (a, b) =>
                    Number(b.priorityScore) -
                    Number(a.priorityScore)
            );

        const selectedPrefilter = [];
        const selectedSymbols = new Set();

        for (const row of [
            ...passedPrefilter,
            ...fallbackPrefilter
        ]) {
            if (selectedSymbols.has(row.symbol)) {
                continue;
            }

            selectedSymbols.add(row.symbol);
            selectedPrefilter.push(row);

            if (selectedPrefilter.length >= 5) {
                break;
            }
        }

        const requestedPrioritySymbol = String(req.query.symbol || '').trim();
        const activePairs = requestedPrioritySymbol ? [requestedPrioritySymbol] : selectedPrefilter.map(item => item.symbol);
        if (requestedPrioritySymbol) console.log('[PRIORITY SCAN] strict full-pipeline single pair:', requestedPrioritySymbol);


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
            'Prefilter Top 8:',
            prefilterRanking.length ?
            prefilterRanking
            .slice()
            .sort(
                (a, b) =>
                    Number(b.priorityScore) -
                    Number(a.priorityScore)
            )
            .map(
                row =>
                    `${row.symbol}:${row.prefilterScore}` +
                    (row.opportunityBonus ?
                        `(+${row.opportunityBonus})` :
                        '')
            )
            .join(', ') :
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
                    !Array.isArray(closedCandles) ||
                    closedCandles.length < 100
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


                // ======================================
                // FVG BIRTH TRACKER — POST REFRESH
                // v4.14.4
                // ======================================
                //
                // Important when WebSocket is disconnected:
                // the prefilter can only see the LOCAL history
                // that existed before this scan. The normal
                // scanner may then REST-resync and receive a
                // newly CLOSED 1M candle / newly formed FVG.
                //
                // Therefore scan births again AFTER bootstrap/
                // resync and BEFORE full analysis. Zone IDs are
                // deterministic, so already-known FVGs are not
                // duplicated.
                // ======================================

                try {
                    const bornAfterRefresh =
                        scanFvgBirths(
                            symbol,
                            closedCandles
                        );

                    if (bornAfterRefresh.length) {
                        for (const born of bornAfterRefresh) {
                            console.log(
                                '[FVG BIRTH]',
                                symbol,
                                '| ID:',
                                born.zoneId,
                                '|',
                                born.direction,
                                born.timeframe,
                                '| Formed:',
                                born.formationDatetime,
                                '| First seen:',
                                born.firstSeenAt,
                                '| Best:',
                                born.bestEntryPrice
                            );
                        }
                    }
                } catch (birthRefreshError) {
                    console.warn(
                        '[FVG BIRTH POST-REFRESH ERROR]',
                        symbol,
                        birthRefreshError.message
                    );
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
        rememberAnalysisForRealtime(symbol, analysis);

                // ======================================
                // CANDLE AUDIT — v4.14.4
                // Diagnostic only. Runs for every analyzed pair before any
                // later WAIT/SKIP/continue path. 5M does NOT change decision.
                try {
                    const cc = analysis && analysis.candleConfirmation;
                    const signalForAudit = analysis && (analysis.signal || analysis.bestDirection);
                    if (cc && (signalForAudit === 'UP' || signalForAudit === 'DOWN')) {
                        const m1 = cc.timeframes && cc.timeframes.m1;
                        const m3 = cc.timeframes && cc.timeframes.m3;
                        const m5 = cc.timeframes && cc.timeframes.m5;
                        const fmt = (tf) => {
                            if (!tf || tf.available === false) return 'N/A';
                            const state = tf.confirmed ? 'CONFIRMED' : (tf.opposite ? 'OPPOSITE' : 'NO');
                            return `${state} ${tf.expectedScore ?? 0}/${tf.oppositeScore ?? 0}`;
                        };
                        console.log(
                            '[CANDLE AUDIT]', symbol, signalForAudit,
                            '| final:', cc.status || 'N/A',
                            '| combined:', `${cc.score ?? 0}/${cc.oppositeScore ?? 0}`,
                            '| 1M:', fmt(m1),
                            '| 3M:', fmt(m3),
                            '| 5M:', fmt(m5),
                            '| 5M diagnostic only:', true
                        );
                    }
                } catch (auditError) {
                    console.warn('[CANDLE AUDIT ERROR]', symbol, auditError.message);
                }


                // ======================================
                // PERSISTENT ZONE HISTORY — v4.12.3
                // ======================================
                // Persist before any later WAIT/SKIP/continue path.
                try {
                    const persistedZone =
                        trackEntryZone(
                            symbol,
                            analysis
                        );

                    if (persistedZone) {
                        analysis.entryZoneHistory =
                            persistedZone;

                        console.log(
                            '[ZONE HISTORY]',
                            symbol,
                            '| ID:',
                            persistedZone.zoneId,
                            '| First:',
                            persistedZone.firstSeenAt,
                            '| State:',
                            persistedZone.latest &&
                                persistedZone.latest.state,
                            '| Final:',
                            persistedZone.finalState || '-'
                        );
                    }
                } catch (e) {
                    console.warn(
                        '[ZONE HISTORY ERROR]',
                        symbol,
                        e.message
                    );
                }


                // ======================================
                // FVG BIRTH -> ANALYSIS LINK — v4.13
                // ======================================
                try {
                    const birthRecord =
                        updateFvgBirthWithAnalysis(
                            symbol,
                            analysis
                        );

                    if (birthRecord) {
                        analysis.fvgBirthHistory =
                            birthRecord;
                    }
                } catch (e) {
                    console.warn(
                        '[FVG BIRTH UPDATE ERROR]',
                        symbol,
                        e.message
                    );
                }


                // ======================================
                // SCORE DIAGNOSTIC HISTORY — v4.9.6
                // ======================================
                // Instrumentation only: does not change signal/filter logic.
                try {
                    logScoreDiagnostic(
                        symbol,
                        analysis
                    );
                } catch (
                    diagnosticError
                ) {
                    console.error(
                        '[SCORE TRACE ERROR]',
                        symbol,
                        diagnosticError.message
                    );
                }


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


                    // v4.9.7: the legacy weak-watch row must respect
                    // Context + Setup alignment. It is display/watch logic
                    // only and must not advertise the opposite direction.
                    const weakDirectionMatchesAlignment =
                        diagnostics.contextSetupAligned ===
                            true &&
                        (
                            (
                                diagnostics.contextDirection ===
                                    'BULLISH' &&
                                weakDirection ===
                                    'UP'
                            ) ||
                            (
                                diagnostics.contextDirection ===
                                    'BEARISH' &&
                                weakDirection ===
                                    'DOWN'
                            )
                        );


                    const zoneLifecycle =
                        analysis.entryZoneLifecycle &&
                        typeof analysis.entryZoneLifecycle ===
                            'object'
                            ?
                            analysis.entryZoneLifecycle
                            :
                            null;


                    const showZoneLifecycle =
                        Boolean(
                            zoneLifecycle &&
                            zoneLifecycle.active === true &&
                            (
                                zoneLifecycle.state === 'IN ZONE' ||
                                zoneLifecycle.state === 'APPROACHING' ||
                                zoneLifecycle.state === 'TRACKING' ||
                                zoneLifecycle.state === 'MISSED'
                            )
                        );


                    const preOpportunityWatch =
                        analysis.preEntryOpportunityWatch &&
                        typeof analysis.preEntryOpportunityWatch ===
                            'object'
                            ?
                            analysis.preEntryOpportunityWatch
                            :
                            null;


                    const isPreOpportunity =
                        Boolean(
                            preOpportunityWatch &&
                            preOpportunityWatch.active ===
                                true
                        );


                    if (
                        isPreOpportunity
                    ) {

                        const preZone =
                            preOpportunityWatch.entryZone &&
                            typeof preOpportunityWatch.entryZone ===
                                'object'
                                ?
                                preOpportunityWatch.entryZone
                                :
                                {};


                        console.log(
                            '[SCAN PRE-OPPORTUNITY]',
                            symbol,
                            preOpportunityWatch.direction,
                            '| Score:',
                            preOpportunityWatch.score,
                            '| Setup: NEUTRAL',
                            '| Zone:',
                            preZone.status ||
                                'NO ENTRY ZONE'
                        );


                        decisions.push({
                            symbol,
                            action:
                                'PRE-OPPORTUNITY',
                            decision:
                                'PRE-OPPORTUNITY',
                            reasonCode:
                                'PRE_ENTRY_OPPORTUNITY_WATCH',
                            reason:
                                preOpportunityWatch.reason,
                            signal:
                                preOpportunityWatch.direction,
                            score:
                                preOpportunityWatch.score,
                            requiredScore:
                                weakRequiredScore,
                            actualEdge:
                                weakEdge,
                            requiredEdge:
                                weakRequiredEdge,
                            entryStatus:
                                preZone.status ||
                                'WATCH',
                            entryQuality:
                                preZone.currentEntryQuality ||
                                'PRE-OPPORTUNITY',
                            bestEntryPrice:
                                preZone.bestEntryPrice ??
                                null,
                            lastAcceptablePrice:
                                preZone.lastAcceptablePrice ??
                                null,
                            worstEntryPrice:
                                preZone.worstEntryPrice ??
                                null,
                            currentPrice:
                                preZone.currentPrice ??
                                null,
                            strength:
                                'PRE-OPPORTUNITY WATCH',
                            expirationMinutes:
                                null,
                            expirationAt:
                                null,
                            candidateOnly:
                                false,
                            opportunityOnly:
                                false,
                            preOpportunityOnly:
                                true
                        });


                        continue;
                    }


                    const opportunityWatch =
                        analysis.entryOpportunityWatch &&
                        typeof analysis.entryOpportunityWatch ===
                            'object'
                            ?
                            analysis.entryOpportunityWatch
                            :
                            null;


                    // v5.0.2 Current Decision Isolation:
                    // An early OPPORTUNITY is a current-scan observation only when
                    // its own freshly calculated watch zone is still actionable.
                    // Historical/late zones remain in Zone History but must not
                    // become a current OPPORTUNITY decision.
                    const opportunityZoneForGate =
                        opportunityWatch && opportunityWatch.entryZone &&
                        typeof opportunityWatch.entryZone === 'object'
                            ? opportunityWatch.entryZone
                            : null;
                    const opportunityZoneStatus = String(
                        opportunityZoneForGate?.status || ''
                    ).toUpperCase();
                    const opportunityEntryQuality = String(
                        opportunityZoneForGate?.currentEntryQuality || ''
                    ).toUpperCase();
                    const opportunityZoneActionable = Boolean(
                        opportunityZoneForGate &&
                        opportunityZoneForGate.available === true &&
                        opportunityZoneStatus !== 'TOO LATE' &&
                        !opportunityEntryQuality.includes('WORST') &&
                        !opportunityEntryQuality.includes('DO NOT ENTER')
                    );

                    const isEntryOpportunity =
                        Boolean(
                            opportunityWatch &&
                            opportunityWatch.active === true &&
                            opportunityZoneActionable &&
                            weakScore >= Number(opportunityWatch.floor || 30) &&
                            weakScore < weakSetupMinScore
                        );


                    if (
                        isEntryOpportunity
                    ) {

                        const opportunityZone =
                            opportunityWatch.entryZone &&
                            typeof opportunityWatch.entryZone ===
                                'object'
                                ?
                                opportunityWatch.entryZone
                                :
                                {};


                        console.log(
                            '[SCAN OPPORTUNITY]',
                            symbol,
                            weakDirection,
                            '| Score:',
                            weakScore,
                            '| Candidate Floor:',
                            weakSetupMinScore,
                            '| Zone:',
                            opportunityZone.status ||
                                'NO ENTRY ZONE'
                        );


                        decisions.push({
                            symbol:
                                symbol,

                            action:
                                'OPPORTUNITY',

                            decision:
                                'OPPORTUNITY',

                            reasonCode:
                                'ENTRY_OPPORTUNITY_WATCH',

                            reason:
                                opportunityWatch.reason ||
                                'Early aligned setup near Entry Zone',

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

                            entryStatus:
                                opportunityZone.status ||
                                'WATCH',

                            entryQuality:
                                opportunityZone.currentEntryQuality ||
                                'EARLY WATCH',

                            bestEntryPrice:
                                opportunityZone.bestEntryPrice ??
                                null,

                            lastAcceptablePrice:
                                opportunityZone.lastAcceptablePrice ??
                                null,

                            worstEntryPrice:
                                opportunityZone.worstEntryPrice ??
                                null,

                            currentPrice:
                                opportunityZone.currentPrice ??
                                null,

                            strength:
                                'EARLY ENTRY WATCH',

                            expirationMinutes:
                                null,

                            expirationAt:
                                null,

                            candidateOnly:
                                false,

                            opportunityOnly:
                                true
                        });


                        continue;
                    }


                    const isWeakWatchCandidate =
                        showWeakSetups &&
                        weakDirection &&
                        weakDirectionMatchesAlignment &&
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
                            '| Candidate Floor:',
                            weakSetupMinScore,
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


                    if (showZoneLifecycle) {
                        // v5.0.2: historical zone lifecycle is diagnostics/history,
                        // never a current Scan Decision. This prevents one symbol
                        // from becoming both ZONE WATCH and SKIP in the same scan.
                        console.log(
                            '[ZONE OBSERVATION]',
                            symbol,
                            zoneLifecycle.direction,
                            '| State:', zoneLifecycle.state,
                            '| Score:', zoneLifecycle.score,
                            '| Best:', zoneLifecycle.bestEntryPrice,
                            '| current decision: NO SIGNAL'
                        );
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
                // EXECUTION GATE
                // ======================================

                // A directional market setup is not automatically an actionable trade.
                // Keep late / poor entries out of Active Signals and the paper logger.
                const entryStatus = String(entryZone.status || '').toUpperCase();
                const entryQuality = String(entryZone.currentEntryQuality || '').toUpperCase();
                const strengthRecommendation = String(signalStrength.recommendation || '').toUpperCase();

                const hardEntryBlock =
                    entryStatus.includes('TOO LATE') ||
                    entryQuality.includes('DO NOT ENTER') ||
                    entryQuality.includes('WORST ENTRY') ||
                    strengthRecommendation.includes('NOT RECOMMENDED');

                const waitEntry =
                    !hardEntryBlock && (
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
                        const lifecycleWatch = addFastRecheckWatch(
                            symbol,
                            signal,
                            userMinScore,
                            scoreWeights
                        );


                        const earlyPayload = {
                            setupId: lifecycleWatch && lifecycleWatch.setupId,
                            symbol,
                            signal,
                            stage: 'WAIT',
                            score,
                            requiredScore: analysis.signalDiagnostics?.requiredScore || analysis.signalDiagnostics?.effectiveMinScore,
                            currentPrice: livePrice,
                            marketBias: analysis.marketBias,
                            signalStage: analysis.signalStage,
                            entryZone,
                            signalStrength,
                            candleConfirmation: analysis.candleConfirmation || null,
                            signalDiagnostics: analysis.signalDiagnostics || null,
                            strategyName: primaryStrategy?.name || analysis.strategyName || analysis.strategy || null,
                            expiration,
                            expirationMinutes: Number.isFinite(recommendedExpiration) ? recommendedExpiration : null,
                            expirationAt,
                            expirationAtMs,
                            expirationRemainingSeconds,
                            expirationExpired
                        };
                        recordStage(earlyPayload);

                        // v5 research: track high-confidence WAIT setups separately
                        // from real TRADE statistics. Strict rule: score must be > 60.
                        // We only persist the WAIT once an expiration exists, because
                        // without a horizon there is no meaningful WIN/LOSS outcome.
                        if (
                            Number(score) > 60 &&
                            Number.isFinite(Number(recommendedExpiration)) &&
                            Number(recommendedExpiration) > 0 &&
                            Number.isFinite(Number(livePrice))
                        ) {
                            try {
                                const waitResearchRecord = logSignal({
                                    setupId: lifecycleWatch && lifecycleWatch.setupId,
                                    symbol,
                                    signal,
                                    score,
                                    upScore: Number(analysis.upScore) || 0,
                                    downScore: Number(analysis.downScore) || 0,
                                    multiTimeframe: analysis.multiTimeframe || null,
                                    primaryStrategy: primaryStrategy || null,
                                    pairSession: pairSession || null,
                                    marketRegime: analysis.marketRegime || null,
                                    price: livePrice,
                                    referencePrice: analysis.referencePrice || livePrice,
                                    expiration,
                                    expirationMinutes: recommendedExpiration,
                                    expirationAt,
                                    expirationAtMs,
                                    signalCandleCloseMs,
                                    signalAge,
                                    signalStrength,
                                    candleConfirmation: analysis.candleConfirmation || null,
                                    decision: 'WAIT',
                                    entryZone,
                                    entryQuality: entryZone.currentEntryQuality || null,
                                    entryScore: entryZone.currentEntryScore || null,
                                    marketBias: analysis.marketBias || (analysis.signalDiagnostics && analysis.signalDiagnostics.marketBias) || null,
                                    signalStage: analysis.signalStage || (analysis.signalDiagnostics && analysis.signalDiagnostics.signalStage) || null,
                                    diagnostics: analysis.signalDiagnostics || null
                                });

                                if (waitResearchRecord) {
                                    console.log(
                                        '[WAIT RESEARCH LOGGER]',
                                        symbol,
                                        signal,
                                        '| Score:', score,
                                        '| Expiration:', recommendedExpiration + 'm',
                                        '| setupId:', waitResearchRecord.setupId
                                    );
                                }
                            } catch (waitLoggerError) {
                                console.error('[WAIT RESEARCH LOGGER ERROR]', symbol, waitLoggerError.message);
                            }
                        }

                        const earlyEntry = String(entryZone.currentEntryQuality || entryZone.status || '').toUpperCase();
                        const earlyStrength = Number(signalStrength.score) || 0;
                        const earlyDiag = analysis.signalDiagnostics || {};
                        const earlyRequiredScore = Number(earlyDiag.requiredScore ?? earlyDiag.effectiveMinScore ?? 0);
                        const earlyCandidateFloor = Number(earlyDiag.candidateWatchFloor ?? 35);
                        const earlyGetReadyScoreFloor = Math.max(earlyCandidateFloor, earlyRequiredScore - GET_READY_SCORE_TOLERANCE);
                        const isGetReady =
                            Number(score) >= earlyGetReadyScoreFloor &&
                            Number(earlyDiag.actualEdge || 0) >= Number(earlyDiag.requiredEdge || 0) &&
                            earlyDiag.contextSetupConflict !== true &&
                            earlyStrength >= 45 &&
                            !earlyEntry.includes('BAD') &&
                            !earlyEntry.includes('WORST') &&
                            !earlyEntry.includes('DO NOT ENTER') &&
                            !String(entryZone.status || '').toUpperCase().includes('TOO LATE');

                        if (isGetReady) {
                            const firstGetReady = lifecycleWatch && !lifecycleWatch.getReadyAt;
                            if (firstGetReady) lifecycleWatch.getReadyAt = Date.now();
                            const getReadyPayload = {
                                ...earlyPayload,
                                stage: 'GET_READY',
                                getReadyScoreFloor: earlyGetReadyScoreFloor,
                                scoreTolerance: GET_READY_SCORE_TOLERANCE
                            };
                            if (firstGetReady || !lifecycleWatch) recordStage(getReadyPayload);

                            const expirationGenerated = Number.isFinite(Number(recommendedExpiration)) && Boolean(expirationAt);
                            if (expirationGenerated && !expirationExpired && (!lifecycleWatch || !lifecycleWatch.expirationTelegramSentAt)) {
                                sendEarlyAlert(getReadyPayload)
                                    .then(r => {
                                        if (r.sent && lifecycleWatch) lifecycleWatch.expirationTelegramSentAt = Date.now();
                                        console.log(r.sent ? '[TELEGRAM EXPIRATION SENT]' : '[TELEGRAM EXPIRATION SKIP]', symbol, '|', r.reason || 'GET_READY');
                                    })
                                    .catch(e => console.error('[TELEGRAM EXPIRATION ERROR]', symbol, e.message));
                            } else if (!expirationGenerated) {
                                console.log('[TELEGRAM EXPIRATION WAIT]', symbol, '| expiration not generated yet');
                            }
                        }
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
                        historicalEffectiveness: estimateAccuracy({
                            symbol, signal, score, entryZone, signalStrength,
                            candleConfirmation: analysis.candleConfirmation || null,
                            signalDiagnostics: analysis.signalDiagnostics || null
                        }, getSignalHistory(5000)),

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
                // ENTRY ENGINE
                // ======================================

                const entryEngine =
                    analysis.entryEngine ||
                    analysis.entryTiming ||
                    null;


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
                // Telegram alert is sent only AFTER the current TRADE result is pushed below.

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

                        const activeLifecycleWatch = fastRecheckWatchlist.get(symbol);
                        logSignal({

                            setupId: activeLifecycleWatch && activeLifecycleWatch.signal === signal ? activeLifecycleWatch.setupId : null,
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

                            candleConfirmation: analysis.candleConfirmation || null,
                            decision: 'TRADE',

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

                    decision: 'TRADE',

                    signal: signal,

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

                    candleConfirmation: analysis.candleConfirmation || null,
                    candleConfirmation5mDiagnostic: analysis.candleConfirmation?.alternative5m || null,


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
                // TELEGRAM — CURRENT FINAL TRADE ONLY
                // ======================================
                const currentTradeResult = results[results.length - 1];
                const lifecycleWatch = fastRecheckWatchlist.get(symbol);
                const recentLifecycle = fastRecheckRecent.get(symbol);
                currentTradeResult.setupId = currentTradeResult.setupId ||
                    (lifecycleWatch && lifecycleWatch.setupId) ||
                    (recentLifecycle && recentLifecycle.setupId) ||
                    createSetupId(symbol, signal);
                currentTradeResult.historicalEffectiveness = estimateAccuracy({
                    ...currentTradeResult,
                    entryZone,
                    signalStrength,
                    candleConfirmation: analysis.candleConfirmation || null,
                    signalDiagnostics: analysis.signalDiagnostics || null
                }, getSignalHistory(5000));
                recordStage({
                    ...currentTradeResult,
                    stage: 'TRADE',
                    signalStrength: currentTradeResult?.signalStrength || signalStrength,
                    candleConfirmation: currentTradeResult?.candleConfirmation || analysis.candleConfirmation || null,
                    signalDiagnostics: currentTradeResult?.signalDiagnostics || analysis.signalDiagnostics || null
                });
                console.log(
                    '[DECISION TRACE]', symbol,
                    '| decision:', currentTradeResult?.decision || 'UNKNOWN',
                    '| entry:', entryZone.status || 'N/A',
                    '| strength:', signalStrength.score ?? 'N/A'
                );

                if (lifecycleWatch && lifecycleWatch.signal === signal) {
                    fastRecheckWatchlist.delete(symbol);
                    fastRecheckRecent.set(symbol, {
                        symbol, signal, setupId: currentTradeResult.setupId, updatedAt: Date.now(),
                        last: { ...(lifecycleWatch.last || {}), state: 'TRADE', setupId: currentTradeResult.setupId }
                    });
                    console.log('[SIGNAL LIFECYCLE] TRADE terminal', symbol, '| setupId:', currentTradeResult.setupId);
                }

                sendTradeAlert(currentTradeResult)
                    .then(telegramResult => {
                        if (telegramResult.sent) {
                            console.log('[TELEGRAM SENT]', symbol, signal, '| Score:', score);
                        } else {
                            console.log('[TELEGRAM SKIP]', symbol, '| reason:', telegramResult.reason || 'UNKNOWN');
                        }
                    })
                    .catch(error => {
                        console.error('[TELEGRAM ERROR]', symbol, error.message);
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
            'Final TRADE signals:',
            results.length
        );


        // v5.0.1: one pair must contribute exactly one current scan decision.
        // ZONE WATCH / lifecycle observations can be emitted before the final SKIP/WAIT,
        // so collapse duplicates by symbol and keep the last (authoritative) decision.
        const finalDecisionMap = new Map();
        for (const item of decisions) {
            const key = String(item?.symbol || '').toUpperCase();
            if (!key) continue;
            finalDecisionMap.set(key, item);
        }
        const finalDecisions = Array.from(finalDecisionMap.values());
        const decisionSummary = finalDecisions.reduce((acc, item) => {
            const key = String(item?.action || item?.decision || 'UNKNOWN').toUpperCase();
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        console.log('Decision summary:', decisionSummary);


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
                    0,

                selectionMode:
                    'ADAPTIVE_SESSION_PREFILTER_TOP8_TO_TOP5',

                prefilterMinimum: 28,

                sessionTop8: sessionTop8,

                prefilterRanking:
                    prefilterRanking
                    .slice()
                    .sort(
                        (a, b) =>
                            Number(b.priorityScore) -
                            Number(a.priorityScore)
                    ),

                prefilterSelected:
                    selectedPrefilter
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

            decisions: finalDecisions,

            scanStats: scanStats
        });

        } finally {
            scanInProgress = false;

            // v4.14.8: do not wait for the next 30s interval boundary.
            // A full scan may itself occupy the timer window, so kick one
            // REST-only observational recheck immediately after it finishes.
            if (fastRecheckWatchlist.size > 0) {
                console.log('[FAST RECHECK TIMER] post-scan kick scheduled | watched:', fastRecheckWatchlist.size);
                setTimeout(() => {
                    runFastRestRecheck().catch(error => {
                        console.warn('[FAST RECHECK ERROR] post-scan kick', error.message);
                    });
                }, 1000);
            }
        }
    }
);
// ======================================================
// FVG BIRTH TRACKER API — v4.13
// ======================================================

app.get(
    '/api/fvg-births',
    (req, res) => {
        res.json({
            status: 'ok',
            zones: getFvgBirths({
                symbol: req.query.symbol || null,
                limit: req.query.limit || 100
            })
        });
    }
);

app.get(
    '/api/fvg-birth-history',
    (req, res) => {
        res.json({
            status: 'ok',
            history: getFvgBirthHistory({
                symbol: req.query.symbol || null,
                zoneId: req.query.zoneId || null,
                limit: req.query.limit || 100
            })
        });
    }
);

app.post(
    '/api/fvg-birth-history/clear',
    (req, res) => {
        res.json(
            clearFvgBirthHistory()
        );
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

            apiUsage: getApiUsageStatus(),

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
// SCORE DIAGNOSTIC HISTORY — v4.9.6
// ======================================================

app.get(
    '/api/score-diagnostics',

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

        const symbol =
            req.query.symbol ?
            String(
                req.query.symbol
            ) :
            null;

        try {

            const results =
                getScoreDiagnosticHistory(
                    limit,
                    symbol
                );

            res.json({
                status: 'ok',
                count: results.length,
                symbol: symbol,
                results: results
            });

        } catch (
            error
        ) {

            console.error(
                '[SCORE DIAGNOSTICS ERROR]',
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


app.post(
    '/api/score-diagnostics/clear',

    (
        req,
        res
    ) => {

        try {
            res.json(
                clearScoreDiagnosticHistory()
            );
        } catch (
            error
        ) {
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
// SIGNAL PERFORMANCE / HISTORICAL EFFECTIVENESS
// ======================================================
app.get('/api/signal-performance', (req, res) => {
    try { res.json({ status:'ok', ...getPerformanceStats() }); }
    catch (error) { res.status(500).json({status:'error', error:error.message}); }
});

app.get('/api/signal-effectiveness', (req, res) => {
    try {
        const sample = {
            symbol: req.query.symbol || null,
            signal: String(req.query.signal || '').toUpperCase(),
            score: Number(req.query.score),
            entryQuality: req.query.entryQuality || null,
            strengthScore: Number(req.query.strength),
            candleConfirmation: { confirmed: String(req.query.candleConfirmed).toLowerCase() === 'true' }
        };
        res.json({ status:'ok', query:sample, effectiveness:estimateAccuracy(sample, getSignalHistory(5000)) });
    } catch (error) { res.status(500).json({status:'error', error:error.message}); }
});

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
// v5.0 PAPER OUTCOME ENGINE — API ECONOMY
// ======================================================
// Samples pending signals from the shared REST snapshot/local history.
// This loop performs ZERO direct Twelve Data requests.
const OUTCOME_SAMPLE_INTERVAL_MS = Math.max(
    60 * 1000,
    Number(process.env.OUTCOME_SAMPLE_INTERVAL_MS) || 60 * 1000
);
let outcomeSamplerRunning = false;

async function samplePendingSignalOutcomes() {
    if (outcomeSamplerRunning || scanInProgress) return;
    const symbols = getPendingSignalSymbols();
    if (!symbols.length) return;

    outcomeSamplerRunning = true;
    try {
        console.log('[OUTCOME ENGINE] sampling | pending symbols:', symbols.length);

        for (const symbol of symbols) {
            try {
                const live = getLivePrice(symbol);
                let price = live && live.fresh ? Number(live.price) : NaN;
                let source = 'REALTIME';

                if (!Number.isFinite(price)) {
                    const shared = getSharedRestPrice(symbol);
                    price = Number(shared.price);
                    source = shared.source;
                }

                if (!Number.isFinite(price)) continue;

                const outcomeCandles = getLocalHistory(symbol);
                observePendingSignals(symbol, price, Date.now(), { candles: outcomeCandles });
                console.log('[OUTCOME SAMPLE]', symbol, '| price:', price, '| source:', source);
            } catch (error) {
                console.warn('[OUTCOME SAMPLE ERROR]', symbol, error.message);
            }
        }
    } finally {
        outcomeSamplerRunning = false;
    }
}

setInterval(() => {
    samplePendingSignalOutcomes().catch(error =>
        console.error('[OUTCOME ENGINE]', error.message)
    );
}, OUTCOME_SAMPLE_INTERVAL_MS);

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

// v4.12 persistent Entry Zone history API
app.get('/api/entry-zones', (req,res) => {
    res.json({status:'ok',zones:getEntryZones({symbol:req.query.symbol||null,limit:req.query.limit||100})});
});
app.get('/api/entry-zone-history', (req,res) => {
    res.json({status:'ok',rows:getEntryZoneHistory({symbol:req.query.symbol||null,zoneId:req.query.zoneId||null,limit:req.query.limit||100})});
});
app.post('/api/entry-zone-history/clear', (req,res) => {
    clearEntryZoneHistory(); res.json({status:'ok',cleared:true});
});

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
