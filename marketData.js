const fetch =
    require(
        'node-fetch'
    );

const {
    API_KEY
} = require('./config');



function requireApiKey() {
    if (API_KEY) {
        return;
    }

    const error = new Error(
        'Twelve Data API key is not configured. Add TWELVE_DATA_API_KEY to .env and restart the server.'
    );
    error.status = 503;
    throw error;
}

// ======================================================
// SETTINGS
// ======================================================

const CACHE_TTL_MS = Math.max(
    30 * 1000,
    Number(process.env.TWELVE_REST_CACHE_MS) || 60 * 1000
);

const STALE_CACHE_MAX_MS =
    5 * 60 * 1000;

const MAX_RETRIES =
    3;

const RETRYABLE_HTTP_CODES = [
    429,
    500,
    502,
    503,
    504,
    520,
    521,
    522,
    523,
    524
];


// ======================================================
// MEMORY CACHE
// ======================================================

const cache =
    new Map();

const inFlightRequests =
    new Map();


// ======================================================
// WAIT
// ======================================================

function sleep(
    milliseconds
) {
    return new Promise(
        resolve => {
            setTimeout(
                resolve,
                milliseconds
            );
        }
    );
}


// ======================================================
// CACHE KEY
// ======================================================

function makeCacheKey(
    type,
    symbol,
    interval,
    outputsize
) {
    return [
        type,
        symbol,
        interval || '',
        outputsize || ''
    ].join('|');
}


// ======================================================
// GET CACHE
// ======================================================

function getCached(
    key,
    maxAgeMs
) {
    const record =
        cache.get(
            key
        );

    if (!record) {
        return null;
    }


    const age =
        Date.now() -
        record.savedAt;


    if (
        age >
        maxAgeMs
    ) {
        return null;
    }


    return {
        data: record.data,

        ageMs: age,

        savedAt: record.savedAt
    };
}


// ======================================================
// SAVE CACHE
// ======================================================

function saveCache(
    key,
    data
) {
    cache.set(
        key, {
            data: data,

            savedAt: Date.now()
        }
    );
}


async function runCoalesced(
    key,
    task
) {
    if (
        inFlightRequests.has(
            key
        )
    ) {
        return inFlightRequests.get(
            key
        );
    }

    const promise =
        Promise.resolve()
            .then(
                task
            )
            .finally(
                () => {
                    inFlightRequests.delete(
                        key
                    );
                }
            );

    inFlightRequests.set(
        key,
        promise
    );

    return promise;
}


// ======================================================
// SHORT ERROR BODY
// ======================================================

function cleanErrorBody(
    text
) {
    if (!text) {
        return '';
    }


    /*
        Cloudflare sometimes sends an entire HTML page.

        We don't want 500 lines dumped into console.
    */

    return String(
            text
        )
        .replace(
            /\s+/g,
            ' '
        )
        .trim()
        .slice(
            0,
            300
        );
}


// ======================================================
// REQUEST WITH RETRY
// ======================================================

async function requestJson(
    url,
    options = {}
) {
    const retries =
        Number.isFinite(
            Number(
                options.retries
            )
        ) ?
        Number(
            options.retries
        ) :
        MAX_RETRIES;


    let lastError =
        null;


    for (
        let attempt = 1; attempt <= retries; attempt++
    ) {
        try {

            const response =
                await fetch(
                    url, {
                        timeout: 15000
                    }
                );


            if (
                response.ok
            ) {

                const data =
                    await response.json();


                /*
                    Twelve Data can return HTTP 200
                    but JSON status:error.
                */

                if (
                    data &&
                    data.status ===
                    'error'
                ) {

                    const code =
                        Number(
                            data.code
                        );


                    const error =
                        new Error(
                            data.message ||
                            'Twelve Data API error'
                        );


                    error.status =
                        Number.isFinite(
                            code
                        ) ?
                        code :
                        500;


                    throw error;
                }


                return data;
            }


            let body =
                '';


            try {

                body =
                    await response.text();

            } catch (
                error
            ) {

                body =
                    '';
            }


            const status =
                Number(
                    response.status
                );


            const error =
                new Error(
                    `HTTP ${status}: ` +
                    (
                        response.statusText ||
                        'Request failed'
                    ) +
                    (
                        body ?
                        ` | ${cleanErrorBody(body)}` :
                        ''
                    )
                );


            error.status =
                status;


            throw error;


        } catch (
            error
        ) {

            lastError =
                error;


            const status =
                Number(
                    error.status
                );


            const retryable =
                RETRYABLE_HTTP_CODES.includes(
                    status
                ) ||
                (!Number.isFinite(
                    status
                ));


            if (!retryable ||
                attempt >= retries
            ) {

                break;
            }


            /*
                429 needs a longer pause.
                502 / 522 usually need shorter retry.
            */

            let delay =
                1500 *
                attempt;


            if (
                status ===
                429
            ) {

                delay =
                    5000 *
                    attempt;
            }


            console.warn(
                '[TWELVE DATA RETRY]',
                `attempt ${attempt}/${retries}`,
                '|',
                error.message.slice(
                    0,
                    180
                ),
                '| wait',
                delay,
                'ms'
            );


            await sleep(
                delay
            );
        }
    }


    throw (
        lastError ||
        new Error(
            'Twelve Data request failed'
        )
    );
}


// ======================================================
// TIME SERIES
// ======================================================

async function getTimeSeries(
    symbol,
    options = {}
) {
    requireApiKey();

    const interval =
        options.interval ||
        '1min';


    const outputsize =
        Number(
            options.outputsize ||
            1500
        );


    const key =
        makeCacheKey(
            'time_series',
            symbol,
            interval,
            outputsize
        );


    // ==================================================
    // FRESH CACHE
    // ==================================================

    const fresh =
        getCached(
            key,
            CACHE_TTL_MS
        );


    if (
        fresh
    ) {

        console.log(
            '[MARKET CACHE]',
            symbol,
            'FRESH',
            Math.round(
                fresh.ageMs /
                1000
            ),
            'sec'
        );


        return {
            ...fresh.data,

            _marketData: {
                source: 'CACHE',

                stale: false,

                cacheAgeSeconds: Math.round(
                    fresh.ageMs /
                    1000
                )
            }
        };
    }


    // ==================================================
    // API REQUEST
    // ==================================================

    const url =
        'https://api.twelvedata.com/time_series' +

        `?symbol=${encodeURIComponent(symbol)}` +

        `&interval=${encodeURIComponent(interval)}` +

        `&outputsize=${outputsize}` +

        '&timezone=UTC' +

        `&apikey=${API_KEY}`;


    try {

        const data =
            await runCoalesced(
                key,
                () => requestJson(
                    url
                )
            );


        if (!data ||
            !Array.isArray(
                data.values
            )
        ) {

            throw new Error(
                data &&
                data.message ?
                data.message :
                'Twelve Data returned no candle values'
            );
        }


        saveCache(
            key,
            data
        );


        return {
            ...data,

            _marketData: {
                source: 'API',

                stale: false,

                cacheAgeSeconds: 0
            }
        };


    } catch (
        error
    ) {

        // ==============================================
        // STALE CACHE FALLBACK
        // ==============================================

        const stale =
            getCached(
                key,
                STALE_CACHE_MAX_MS
            );


        if (
            stale
        ) {

            console.warn(
                '[MARKET CACHE FALLBACK]',
                symbol,
                '| API failed:',
                error.message.slice(
                    0,
                    150
                ),
                '| using cache age:',
                Math.round(
                    stale.ageMs /
                    1000
                ),
                'sec'
            );


            return {
                ...stale.data,

                _marketData: {
                    source: 'STALE_CACHE',

                    stale: true,

                    apiError: error.message,

                    cacheAgeSeconds: Math.round(
                        stale.ageMs /
                        1000
                    )
                }
            };
        }


        throw error;
    }
}


// ======================================================
// CURRENT PRICE
// ======================================================

async function getPrice(
    symbol
) {
    requireApiKey();

    const key =
        makeCacheKey(
            'price',
            symbol
        );


    const fresh =
        getCached(
            key,
            15 * 1000
        );


    if (
        fresh
    ) {

        return {
            ...fresh.data,

            _marketData: {
                source: 'CACHE',

                stale: false,

                cacheAgeSeconds: Math.round(
                    fresh.ageMs /
                    1000
                )
            }
        };
    }


    const url =
        'https://api.twelvedata.com/price' +

        `?symbol=${encodeURIComponent(symbol)}` +

        `&apikey=${API_KEY}`;


    try {

        const data =
            await runCoalesced(
                key,
                () => requestJson(
                    url
                )
            );


        saveCache(
            key,
            data
        );


        return {
            ...data,

            _marketData: {
                source: 'API',

                stale: false,

                cacheAgeSeconds: 0
            }
        };


    } catch (
        error
    ) {

        const stale =
            getCached(
                key,
                2 * 60 * 1000
            );


        if (
            stale
        ) {

            return {
                ...stale.data,

                _marketData: {
                    source: 'STALE_CACHE',

                    stale: true,

                    apiError: error.message,

                    cacheAgeSeconds: Math.round(
                        stale.ageMs /
                        1000
                    )
                }
            };
        }


        throw error;
    }
}


// ======================================================
// CACHE STATUS
// ======================================================

function getMarketDataCacheStatus() {
    const now =
        Date.now();


    const entries = [];


    for (
        const [
            key,
            value
        ] of cache.entries()
    ) {

        entries.push({
            key: key,

            ageSeconds: Math.round(
                (
                    now -
                    value.savedAt
                ) /
                1000
            )
        });
    }


    return {
        size: cache.size,

        inFlight: inFlightRequests.size,

        entries: entries
    };
}


// ======================================================
// CLEAR CACHE
// ======================================================

function clearMarketDataCache() {

    cache.clear();


    return {
        status: 'ok'
    };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    getTimeSeries,
    getPrice,
    getMarketDataCacheStatus,
    clearMarketDataCache
};