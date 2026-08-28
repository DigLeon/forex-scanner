'use strict';

const WebSocket = require('ws');
const { API_KEY } = require('./config');

const REALTIME_ENABLED = /^(1|true|yes|on)$/i.test(
    String(process.env.ENABLE_TWELVE_WS || '')
);

let onClosedCandle = null;

function configureRealtime(options = {}) {
    onClosedCandle = typeof options.onClosedCandle === 'function'
        ? options.onClosedCandle
        : null;
}

// ======================================================
// TWELVE DATA REAL-TIME WEBSOCKET
// ======================================================
//
// REST /time_series stays the source of historical
// closed candles. WebSocket supplies the freshest
// live tick price. If it is unavailable or stale,
// scanner automatically falls back to REST.
// ======================================================

const REALTIME_STALE_MS =
    15000;

const WS_HEARTBEAT_MS =
    10000;

const WS_RECONNECT_MS =
    5000;


let realtimeSocket =
    null;

let realtimeHeartbeatTimer =
    null;

let realtimeReconnectTimer =
    null;

let realtimeDesiredSymbols = [];

let realtimeSubscribedSymbols = [];


const realtimePrices =
    new Map();


// ======================================================
// REAL-TIME 1M CANDLE BUILDER
// ======================================================
//
// Important:
// - Only CLOSED WebSocket candles are merged into analysis.
// - The first candle after connect/reconnect is marked partial
//   because we may have joined in the middle of the minute.
// - Partial candles are NOT used for analysis.
// - This avoids look-ahead and incomplete OHLC data.
// ======================================================

const realtimeCurrentCandles =
    new Map();

const realtimeClosedCandles =
    new Map();

const REALTIME_CANDLE_HISTORY_LIMIT =
    180;



function getUtcMinuteStartMs(
    timestampMs
) {

    return Math.floor(
            timestampMs /
            60000
        ) *
        60000;
}


// ======================================================
// FORMAT CANDLE DATETIME
// ======================================================

function formatUtcCandleDatetime(
    minuteStartMs
) {

    return new Date(
            minuteStartMs
        )
        .toISOString()
        .slice(
            0,
            19
        )
        .replace(
            'T',
            ' '
        );
}


// ======================================================
// SAVE CLOSED REALTIME CANDLE
// ======================================================

function pushRealtimeClosedCandle(
    symbol,
    candle
) {

    if (!symbol ||
        !candle ||
        candle.partial
    ) {

        return;
    }


    const list =
        realtimeClosedCandles.get(
            symbol
        ) || [];


    const normalized = {

        datetime: formatUtcCandleDatetime(
            candle.minuteStartMs
        ),

        open: String(
            candle.open
        ),

        high: String(
            candle.high
        ),

        low: String(
            candle.low
        ),

        close: String(
            candle.close
        ),

        volume: '0',

        _source: 'WEBSOCKET'
    };


    const filtered =
        list.filter(
            item =>
            item.datetime !==
            normalized.datetime
        );


    filtered.unshift(
        normalized
    );


    realtimeClosedCandles.set(
        symbol,
        filtered.slice(
            0,
            REALTIME_CANDLE_HISTORY_LIMIT
        )
    );


    if (onClosedCandle) {
        onClosedCandle(symbol, normalized);
    }


    console.log(
        '[WS CANDLE CLOSED]',
        symbol,
        normalized.datetime,
        'O:',
        normalized.open,
        'H:',
        normalized.high,
        'L:',
        normalized.low,
        'C:',
        normalized.close
    );
}


// ======================================================
// BUILD 1M CANDLE FROM PRICE TICK
// ======================================================

function updateRealtimeCandleFromTick(
    symbol,
    price,
    tickTimestampMs
) {

    if (!symbol ||
        !Number.isFinite(
            price
        )
    ) {

        return;
    }


    const safeTimestampMs =
        Number.isFinite(
            tickTimestampMs
        ) ?
        tickTimestampMs :
        Date.now();


    const minuteStartMs =
        getUtcMinuteStartMs(
            safeTimestampMs
        );


    const existing =
        realtimeCurrentCandles.get(
            symbol
        );


    // ==================================================
    // FIRST TICK
    // ==================================================
    //
    // We may have joined the WebSocket stream
    // in the middle of an already-open minute.
    //
    // Therefore this first candle is incomplete.
    // ==================================================

    if (!existing) {

        realtimeCurrentCandles.set(
            symbol, {

                minuteStartMs: minuteStartMs,

                open: price,

                high: price,

                low: price,

                close: price,

                partial: true
            }
        );


        return;
    }


    // ==================================================
    // SAME MINUTE
    // ==================================================

    if (
        existing.minuteStartMs ===
        minuteStartMs
    ) {

        existing.high =
            Math.max(
                existing.high,
                price
            );


        existing.low =
            Math.min(
                existing.low,
                price
            );


        existing.close =
            price;


        return;
    }


    // ==================================================
    // NEW MINUTE
    // ==================================================

    if (
        minuteStartMs >
        existing.minuteStartMs
    ) {

        // ----------------------------------------------
        // CLOSE PREVIOUS 1M CANDLE
        // ----------------------------------------------

        pushRealtimeClosedCandle(
            symbol,
            existing
        );


        // ----------------------------------------------
        // START NEXT COMPLETE CANDLE
        // ----------------------------------------------

        realtimeCurrentCandles.set(
            symbol, {

                minuteStartMs: minuteStartMs,

                open: price,

                high: price,

                low: price,

                close: price,

                partial: false
            }
        );
    }
}


// ======================================================
// RESET CURRENT WS CANDLES AFTER DISCONNECT
// ======================================================

function markRealtimeCandlesPartial() {

    /*
        If WebSocket disconnects inside a minute,
        some ticks may be missing.

        Therefore current candles are no longer
        trustworthy and must not later become
        confirmed candles.
    */

    realtimeCurrentCandles.clear();
}


// ======================================================
// GET CLOSED WS CANDLES
// ======================================================

function getRealtimeClosedCandles(
    symbol
) {

    const list =
        realtimeClosedCandles.get(
            symbol
        );


    return Array.isArray(
            list
        ) ?
        list : [];
}


// ======================================================
// GET CURRENT BUILDING WS CANDLE
// ======================================================

function getRealtimeCurrentCandle(
    symbol
) {

    const candle =
        realtimeCurrentCandles.get(
            symbol
        );


    if (!candle) {

        return null;
    }


    return {

        datetime: formatUtcCandleDatetime(
            candle.minuteStartMs
        ),

        open: candle.open,

        high: candle.high,

        low: candle.low,

        close: candle.close,

        partial: candle.partial
    };
}

function normalizeRealtimeSymbols(
    symbols
) {

    if (!Array.isArray(
            symbols
        )) {

        return [];
    }


    return [

        ...new Set(

            symbols
            .map(
                symbol =>
                String(
                    symbol || ''
                )
                .trim()
            )
            .filter(
                Boolean
            )
        )
    ];
}


// ======================================================
// COMPARE SYMBOL LISTS
// ======================================================

function sameSymbolList(
    a,
    b
) {

    const left =
        normalizeRealtimeSymbols(
            a
        )
        .slice()
        .sort();


    const right =
        normalizeRealtimeSymbols(
            b
        )
        .slice()
        .sort();


    if (
        left.length !==
        right.length
    ) {

        return false;
    }


    return left.every(
        (
            value,
            index
        ) =>
        value ===
        right[index]
    );
}


// ======================================================
// SEND WEBSOCKET EVENT
// ======================================================

function sendRealtimeEvent(
    action,
    symbols
) {

    if (!realtimeSocket ||
        realtimeSocket.readyState !==
        WebSocket.OPEN
    ) {

        return false;
    }


    const payload = {

        action: action
    };


    if (
        Array.isArray(
            symbols
        ) &&
        symbols.length
    ) {

        payload.params = {

            symbols: normalizeRealtimeSymbols(
                    symbols
                )
                .join(',')
        };
    }


    try {

        realtimeSocket.send(
            JSON.stringify(
                payload
            )
        );


        return true;


    } catch (
        error
    ) {

        console.error(
            '[WS SEND ERROR]',
            error.message
        );


        return false;
    }
}


// ======================================================
// HEARTBEAT
// ======================================================

function startRealtimeHeartbeat() {

    if (
        realtimeHeartbeatTimer
    ) {

        clearInterval(
            realtimeHeartbeatTimer
        );
    }


    realtimeHeartbeatTimer =
        setInterval(
            () => {

                if (
                    realtimeSocket &&
                    realtimeSocket.readyState ===
                    WebSocket.OPEN
                ) {

                    sendRealtimeEvent(
                        'heartbeat'
                    );
                }

            },

            WS_HEARTBEAT_MS
        );
}


function stopRealtimeHeartbeat() {

    if (
        realtimeHeartbeatTimer
    ) {

        clearInterval(
            realtimeHeartbeatTimer
        );


        realtimeHeartbeatTimer =
            null;
    }
}


// ======================================================
// RECONNECT
// ======================================================

function scheduleRealtimeReconnect() {

    if (
        realtimeReconnectTimer
    ) {

        return;
    }


    realtimeReconnectTimer =
        setTimeout(
            () => {

                realtimeReconnectTimer =
                    null;


                if (
                    realtimeDesiredSymbols.length
                ) {

                    connectRealtimeMarketData(
                        realtimeDesiredSymbols
                    );
                }

            },

            WS_RECONNECT_MS
        );
}


// ======================================================
// SUBSCRIBE TO SYMBOLS
// ======================================================

function subscribeRealtimeSymbols(
    symbols
) {

    const nextSymbols =
        normalizeRealtimeSymbols(
            symbols
        );


    if (!realtimeSocket ||
        realtimeSocket.readyState !==
        WebSocket.OPEN
    ) {

        return;
    }


    // ==================================================
    // UNSUBSCRIBE OLD SESSION PAIRS
    // ==================================================

    if (
        realtimeSubscribedSymbols.length
    ) {

        sendRealtimeEvent(
            'unsubscribe',
            realtimeSubscribedSymbols
        );
    }


    realtimeSubscribedSymbols = [];


    if (!nextSymbols.length) {

        return;
    }


    // ==================================================
    // SUBSCRIBE NEW SESSION PAIRS
    // ==================================================

    if (
        sendRealtimeEvent(
            'subscribe',
            nextSymbols
        )
    ) {

        realtimeSubscribedSymbols =
            nextSymbols;


        console.log(
            '[WS] Subscribed:',
            nextSymbols.join(
                ', '
            )
        );
    }
}


// ======================================================
// CONNECT TO TWELVE DATA WEBSOCKET
// ======================================================

function connectRealtimeMarketData(
    symbols = []
) {

    if (!REALTIME_ENABLED) {
        realtimeDesiredSymbols = normalizeRealtimeSymbols(symbols);
        return;
    }

    realtimeDesiredSymbols =
        normalizeRealtimeSymbols(
            symbols
        );


    // ==================================================
    // NO PAIRS
    // ==================================================

    if (!realtimeDesiredSymbols.length) {

        if (
            realtimeSocket &&
            realtimeSocket.readyState ===
            WebSocket.OPEN
        ) {

            subscribeRealtimeSymbols(
                []
            );
        }


        return;
    }


    // ==================================================
    // ALREADY CONNECTED
    // ==================================================

    if (
        realtimeSocket &&
        (
            realtimeSocket.readyState ===
            WebSocket.OPEN ||
            realtimeSocket.readyState ===
            WebSocket.CONNECTING
        )
    ) {

        if (
            realtimeSocket.readyState ===
            WebSocket.OPEN &&
            !sameSymbolList(
                realtimeSubscribedSymbols,
                realtimeDesiredSymbols
            )
        ) {

            subscribeRealtimeSymbols(
                realtimeDesiredSymbols
            );
        }


        return;
    }


    // ==================================================
    // OPEN NEW CONNECTION
    // ==================================================

    const url =
        'wss://ws.twelvedata.com/v1/quotes/price' +
        `?apikey=${encodeURIComponent(API_KEY)}`;


    realtimeSocket =
        new WebSocket(
            url
        );


    // ==================================================
    // CONNECTED
    // ==================================================

    realtimeSocket.on(
        'open',

        () => {

            console.log(
                '[WS] Connected to Twelve Data'
            );


            startRealtimeHeartbeat();


            subscribeRealtimeSymbols(
                realtimeDesiredSymbols
            );
        }
    );


    // ==================================================
    // INCOMING MESSAGE
    // ==================================================

    realtimeSocket.on(
        'message',

        rawData => {

            try {

                const message =
                    JSON.parse(
                        rawData.toString()
                    );


                // ======================================
                // PRICE EVENT
                // ======================================

                if (
                    message.event ===
                    'price'
                ) {

                    const symbol =
                        String(
                            message.symbol || ''
                        );


                    const price =
                        Number(
                            message.price
                        );


                    if (
                        symbol &&
                        Number.isFinite(
                            price
                        )
                    ) {

                        const rawTimestamp =
                            Number(
                                message.timestamp
                            );


                        const tickTimestampMs =
                            Number.isFinite(
                                rawTimestamp
                            ) ?
                            (
                                rawTimestamp >
                                100000000000 ?
                                rawTimestamp :
                                rawTimestamp *
                                1000
                            ) :
                            Date.now();


                        // ----------------------------------
                        // SAVE LIVE PRICE
                        // ----------------------------------

                        realtimePrices.set(
                            symbol, {

                                symbol: symbol,

                                price: price,

                                timestamp: Number.isFinite(
                                        rawTimestamp
                                    ) ?
                                    rawTimestamp : null,

                                receivedAt: Date.now()
                            }
                        );


                        // ----------------------------------
                        // BUILD REAL-TIME 1M CANDLE
                        // ----------------------------------

                        updateRealtimeCandleFromTick(
                            symbol,
                            price,
                            tickTimestampMs
                        );
                    }


                    return;
                }


                // ======================================
                // SUBSCRIBE STATUS
                // ======================================

                if (
                    message.event ===
                    'subscribe-status'
                ) {

                    console.log(
                        '[WS STATUS FULL]',
                        JSON.stringify(
                            message,
                            null,
                            2
                        )
                    );


                    return;
                }


                // ======================================
                // ERROR FROM TWELVE DATA
                // ======================================

                if (
                    message.status ===
                    'error'
                ) {

                    console.error(
                        '[WS API ERROR]',
                        message.message ||
                        message
                    );
                }


            } catch (
                error
            ) {

                console.error(
                    '[WS MESSAGE ERROR]',
                    error.message
                );
            }
        }
    );


    // ==================================================
    // WEBSOCKET ERROR
    // ==================================================

    realtimeSocket.on(
        'error',

        error => {

            console.error(
                '[WS ERROR]',
                error.message
            );
        }
    );


    // ==================================================
    // WEBSOCKET CLOSED
    // ==================================================

    realtimeSocket.on(
        'close',

        (
            code,
            reason
        ) => {

            console.log(
                '[WS] Closed:',
                code,
                reason ?
                reason.toString() :
                ''
            );


            stopRealtimeHeartbeat();


            markRealtimeCandlesPartial();


            realtimeSocket =
                null;


            realtimeSubscribedSymbols = [];


            scheduleRealtimeReconnect();
        }
    );
}


// ======================================================
// CHANGE CURRENT WS SYMBOLS
// ======================================================

function setRealtimeSymbols(
    symbols
) {

    if (!REALTIME_ENABLED) {
        realtimeDesiredSymbols = normalizeRealtimeSymbols(symbols);
        return;
    }

    const nextSymbols =
        normalizeRealtimeSymbols(
            symbols
        );


    realtimeDesiredSymbols =
        nextSymbols;


    if (!nextSymbols.length) {

        if (
            realtimeSocket &&
            realtimeSocket.readyState ===
            WebSocket.OPEN
        ) {

            subscribeRealtimeSymbols(
                []
            );
        }


        return;
    }


    connectRealtimeMarketData(
        nextSymbols
    );
}


// ======================================================
// GET REAL-TIME PRICE
// ======================================================

function getLivePrice(
    symbol
) {

    const data =
        realtimePrices.get(
            symbol
        );


    if (!data) {

        return null;
    }


    const ageMs =
        Math.max(
            0,
            Date.now() -
            data.receivedAt
        );


    return {

        ...data,

        ageMs: ageMs,

        fresh: ageMs <=
            REALTIME_STALE_MS
    };
}
// ======================================================
// REAL-TIME STATUS
// ======================================================

function getRealtimeStatus() {

    const prices = {};


    for (
        const [
            symbol,
            value
        ] of realtimePrices.entries()
    ) {

        const ageMs =
            Math.max(
                0,
                Date.now() -
                value.receivedAt
            );


        prices[symbol] = {

            price: value.price,

            ageMs: ageMs,

            fresh: ageMs <=
                REALTIME_STALE_MS
        };
    }


    const currentCandles = {};


    for (
        const [
            symbol,
            candle
        ] of realtimeCurrentCandles.entries()
    ) {

        currentCandles[symbol] = {

            datetime: formatUtcCandleDatetime(
                candle.minuteStartMs
            ),

            open: candle.open,

            high: candle.high,

            low: candle.low,

            close: candle.close,

            partial: candle.partial
        };
    }


    const closedCandleCounts = {};


    for (
        const [
            symbol,
            candles
        ] of realtimeClosedCandles.entries()
    ) {

        closedCandleCounts[symbol] =
            Array.isArray(
                candles
            ) ?
            candles.length :
            0;
    }


    return {

        enabled: REALTIME_ENABLED,

        connected: Boolean(
            realtimeSocket &&
            realtimeSocket.readyState ===
            WebSocket.OPEN
        ),

        desiredSymbols: realtimeDesiredSymbols,

        subscribedSymbols: realtimeSubscribedSymbols,

        staleAfterMs: REALTIME_STALE_MS,

        prices: prices,

        currentCandles: currentCandles,

        closedCandleCounts: closedCandleCounts
    };
}


function getRealtimeConfig() {
    return {
        enabled: REALTIME_ENABLED,
        staleMs: REALTIME_STALE_MS,
        heartbeatMs: WS_HEARTBEAT_MS,
        reconnectMs: WS_RECONNECT_MS,
        candleHistoryLimit: REALTIME_CANDLE_HISTORY_LIMIT
    };
}

module.exports = {
    configureRealtime,
    connectRealtimeMarketData,
    setRealtimeSymbols,
    getLivePrice,
    getRealtimeStatus,
    getRealtimeClosedCandles,
    getRealtimeCurrentCandle,
    getRealtimeConfig
};
