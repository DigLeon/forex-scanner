const WebSocket =
    require(
        'ws'
    );


const {
    API_KEY
} = require(
    './config'
);


// ======================================================
// REAL-TIME PRICE CACHE
// ======================================================

const livePrices =
    new Map();


let ws =
    null;


let subscribedSymbols = [];


// ======================================================
// CONNECT
// ======================================================

function connectRealtimeMarketData(
    symbols = []
) {

    subscribedSymbols =
        Array.isArray(
            symbols
        ) ?
        symbols :
        [];


    if (
        subscribedSymbols.length ===
        0
    ) {

        console.log(
            '[WS] No symbols to subscribe'
        );

        return;
    }


    const url =
        'wss://ws.twelvedata.com/v1/quotes/price' +
        `?apikey=${API_KEY}`;


    ws =
        new WebSocket(
            url
        );


    // ==================================================
    // OPEN
    // ==================================================

    ws.on(
        'open',

        () => {

            console.log(
                '[WS] Connected to Twelve Data'
            );


            subscribe(
                subscribedSymbols
            );
        }
    );


    // ==================================================
    // MESSAGE
    // ==================================================

    ws.on(
        'message',

        rawData => {

            try {

                const message =
                    JSON.parse(
                        rawData.toString()
                    );


                // Twelve Data real-time price event
                if (
                    message.event ===
                    'price' ||
                    message.price !==
                    undefined
                ) {

                    const symbol =
                        message.symbol;


                    const price =
                        Number(
                            message.price
                        );


                    const timestamp =
                        Number(
                            message.timestamp
                        );


                    if (
                        symbol &&
                        Number.isFinite(
                            price
                        )
                    ) {

                        livePrices.set(
                            symbol, {

                                symbol: symbol,

                                price: price,

                                timestamp: Number.isFinite(
                                        timestamp
                                    ) ?
                                    timestamp :
                                    null,

                                receivedAt: Date.now()
                            }
                        );


                        console.log(
                            '[WS PRICE]',
                            symbol,
                            price
                        );
                    }
                }


                if (
                    message.event ===
                    'subscribe-status'
                ) {

                    console.log(
                        '[WS SUBSCRIBE]',
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
    // ERROR
    // ==================================================

    ws.on(
        'error',

        error => {

            console.error(
                '[WS ERROR]',
                error.message
            );
        }
    );


    // ==================================================
    // CLOSE + RECONNECT
    // ==================================================

    ws.on(
        'close',

        () => {

            console.log(
                '[WS] Connection closed'
            );


            ws =
                null;


            setTimeout(
                () => {

                    connectRealtimeMarketData(
                        subscribedSymbols
                    );

                },

                5000
            );
        }
    );
}


// ======================================================
// SUBSCRIBE
// ======================================================

function subscribe(
    symbols
) {

    if (!ws ||
        ws.readyState !==
        WebSocket.OPEN
    ) {
        return;
    }


    const uniqueSymbols = [
        ...new Set(
            symbols
        )
    ];


    ws.send(
        JSON.stringify({

            action: 'subscribe',

            params: {

                symbols: uniqueSymbols.join(
                    ','
                )
            }
        })
    );


    console.log(
        '[WS] Subscribe:',
        uniqueSymbols.join(
            ', '
        )
    );
}


// ======================================================
// GET LIVE PRICE
// ======================================================

function getLivePrice(
    symbol
) {

    return (
        livePrices.get(
            symbol
        ) ||
        null
    );
}


// ======================================================
// GET ALL LIVE PRICES
// ======================================================

function getAllLivePrices() {

    return Object.fromEntries(
        livePrices
    );
}


// ======================================================
// PRICE AGE
// ======================================================

function getLivePriceAgeMs(
    symbol
) {

    const data =
        livePrices.get(
            symbol
        );


    if (!data) {

        return null;
    }


    return (
        Date.now() -
        data.receivedAt
    );
}


// ======================================================
// EXPORT
// ======================================================

module.exports = {

    connectRealtimeMarketData,

    subscribe,

    getLivePrice,

    getAllLivePrices,

    getLivePriceAgeMs
};