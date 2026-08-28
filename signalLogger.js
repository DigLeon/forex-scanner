const fs =
    require('fs');

const path =
    require('path');


const HISTORY_FILE =
    path.join(
        __dirname,
        'signal-history.json'
    );


// ======================================================
// LOAD HISTORY
// ======================================================

function loadHistory() {

    try {

        if (!fs.existsSync(
                HISTORY_FILE
            )) {
            return [];
        }


        const text =
            fs.readFileSync(
                HISTORY_FILE,
                'utf8'
            );


        if (!text.trim()) {
            return [];
        }


        const data =
            JSON.parse(
                text
            );


        return Array.isArray(
                data
            ) ?
            data : [];


    } catch (
        error
    ) {

        console.error(
            '[SIGNAL LOGGER] Load error:',
            error.message
        );


        return [];
    }
}


// ======================================================
// SAVE HISTORY
// ======================================================

function saveHistory(
    history
) {

    try {

        fs.writeFileSync(
            HISTORY_FILE,
            JSON.stringify(
                history,
                null,
                2
            ),
            'utf8'
        );


    } catch (
        error
    ) {

        console.error(
            '[SIGNAL LOGGER] Save error:',
            error.message
        );
    }
}


// ======================================================
// UNIQUE SIGNAL ID
// ======================================================

function createSignalId(
    symbol,
    signal,
    timestamp
) {

    return (
        symbol
        .replace(
            '/',
            ''
        ) +
        '-' +
        signal +
        '-' +
        timestamp
    );
}


// ======================================================
// DATA AGE STATUS
// ======================================================

function getDataAgeStatus(
    result
) {

    if (
        result &&
        result.signalAge &&
        result.signalAge.status
    ) {
        return result
            .signalAge
            .status;
    }


    const seconds =
        result &&
        result.signalAge ?
        Number(
            result
            .signalAge
            .seconds
        ) :
        NaN;


    if (!Number.isFinite(
            seconds
        )) {
        return 'UNKNOWN';
    }


    if (
        seconds <= 30
    ) {
        return 'FRESH';
    }


    if (
        seconds <= 60
    ) {
        return 'ACTIVE';
    }


    if (
        seconds <= 120
    ) {
        return 'LATE';
    }


    return 'STALE';
}


// ======================================================
// RESEARCH HORIZONS
//
// These are paper-analysis horizons only.
// They allow us to compare multiple time windows later.
// ======================================================

function getResearchHorizons(
    dataAgeStatus
) {

    if (
        dataAgeStatus ===
        'FRESH'
    ) {
        return [
            5,
            10,
            15,
            20
        ];
    }


    if (
        dataAgeStatus ===
        'ACTIVE'
    ) {
        return [
            10,
            15,
            20,
            25
        ];
    }


    if (
        dataAgeStatus ===
        'LATE'
    ) {
        return [
            15,
            20,
            25,
            30
        ];
    }


    return [
        15,
        20,
        25,
        30
    ];
}


// ======================================================
// SHOULD LOG?
// ======================================================

function shouldLogSignal(
    result
) {

    if (!result) {
        return false;
    }


    if (
        result.signal !==
        'UP' &&
        result.signal !==
        'DOWN'
    ) {
        return false;
    }


    const expirationMinutes =
        Number(
            result.recommendedExpiration !==
                undefined &&
            result.recommendedExpiration !==
                null
                ?
                result.recommendedExpiration
                :
                result.expirationMinutes
        );


    if (
        !Number.isFinite(
            expirationMinutes
        ) ||
        expirationMinutes <=
            0
    ) {

        return false;
    }


    const watchPrice =
        Number(
            result.watchPrice !==
                undefined &&
            result.watchPrice !==
                null
                ?
                result.watchPrice
                :
                (
                    result.referencePrice !==
                        undefined &&
                    result.referencePrice !==
                        null
                        ?
                        result.referencePrice
                        :
                        (
                            result.currentPrice !==
                                undefined &&
                            result.currentPrice !==
                                null
                                ?
                                result.currentPrice
                                :
                                result.price
                        )
                )
        );


    if (
        !Number.isFinite(
            watchPrice
        )
    ) {

        return false;
    }


    const dataAgeStatus =
        getDataAgeStatus(
            result
        );


    // Do not log stale paper signals
    if (
        dataAgeStatus ===
        'STALE'
    ) {
        return false;
    }


    return true;
}


// ======================================================
// CHECK FOR DUPLICATE
//
// Avoid logging same pair/direction every scan.
// ======================================================

function hasRecentDuplicate(
    history,
    result
) {

    // Do not create overlapping paper trades for the same pair and
    // direction. A new signal can be logged once the previous one is
    // resolved. This keeps paper statistics from being inflated by
    // repeated scans of the same still-active setup.
    return history.some(
        item => {

            if (
                item.symbol !==
                result.symbol
            ) {
                return false;
            }


            if (
                item.signal !==
                result.signal
            ) {
                return false;
            }


            return item.status ===
                'PENDING';
        }
    );
}


// ======================================================
// LOG SIGNAL
// ======================================================

function logSignal(
    result
) {

    if (!shouldLogSignal(
            result
        )) {
        return null;
    }


    const history =
        loadHistory();


    const now =
        Date.now();


    if (
        hasRecentDuplicate(
            history,
            result
        )
    ) {
        return null;
    }


    const expirationMinutes =
        Number(
            result.recommendedExpiration !==
                undefined &&
            result.recommendedExpiration !==
                null
                ?
                result.recommendedExpiration
                :
                result.expirationMinutes
        );


    const suppliedExpiryAtMs =
        Number(
            result.expirationAtMs
        );


    const suppliedExpirationAtMs =
        result.expirationAt
            ?
            Date.parse(
                result.expirationAt
            )
            :
            NaN;


    const expiryAtMs =
        Number.isFinite(
            suppliedExpiryAtMs
        )
            ?
            suppliedExpiryAtMs
            :
            (
                Number.isFinite(
                    suppliedExpirationAtMs
                )
                    ?
                    suppliedExpirationAtMs
                    :
                    now +
                    expirationMinutes *
                    60 *
                    1000
            );


    const layers =
        result.multiTimeframe &&
        result.multiTimeframe.layers ?
        result.multiTimeframe.layers : {};


    const dataAgeSeconds =
        result.signalAge &&
        result.signalAge.seconds !==
        undefined ?
        Number(
            result
            .signalAge
            .seconds
        ) :
        null;


    const dataAgeStatus =
        getDataAgeStatus(
            result
        );


    const researchHorizons =
        getResearchHorizons(
            dataAgeStatus
        );


    const record = {

        // ==================================================
        // IDENTITY
        // ==================================================

        id: createSignalId(
            result.symbol,
            result.signal,
            now
        ),


        symbol: result.symbol,


        signal: result.signal,


        marketBias: result.marketBias ||
            null,


        signalStage: result.signalStage ||
            null,


        // ==================================================
        // SCORE
        // ==================================================

        score: result.score,


        upScore: result.upScore,


        downScore: result.downScore,


        // ==================================================
        // MTF
        // ==================================================

        context: layers.context ?
            layers
            .context
            .direction : null,


        setup: layers.setup ?
            layers
            .setup
            .direction : null,


        entry: layers.entry ?
            layers
            .entry
            .direction : null,


        // ==================================================
        // STRATEGY
        // ==================================================

        strategy: result.primaryStrategy ?
            result
            .primaryStrategy
            .name : null,


        strategyConfidence: result.primaryStrategy ?
            result
            .primaryStrategy
            .confidence : null,


        // ==================================================
        // SESSION
        // ==================================================

        sessionQuality: result.pairSession ?
            result
            .pairSession
            .quality : null,


        sessionStatus: result.pairSession ?
            result
            .pairSession
            .status : null,


        // ==================================================
        // MARKET
        // ==================================================

        marketRegime: result.marketRegime ?
            result
            .marketRegime
            .regime : null,


        // ==================================================
        // DATA FRESHNESS
        // ==================================================

        dataAgeSeconds,

        dataAgeStatus,


        // ==================================================
        // RESEARCH HORIZONS
        //
        // For later paper analysis.
        // ==================================================

        researchHorizons,


        // ==================================================
        // PRICES
        // ==================================================

        watchPrice:
            Number(
                result.watchPrice !==
                    undefined &&
                result.watchPrice !==
                    null
                    ?
                    result.watchPrice
                    :
                    (
                        result.referencePrice !==
                            undefined &&
                        result.referencePrice !==
                            null
                            ?
                            result.referencePrice
                            :
                            (
                                result.currentPrice !==
                                    undefined &&
                                result.currentPrice !==
                                    null
                                    ?
                                    result.currentPrice
                                    :
                                    result.price
                            )
                    )
            ),


        entryPrice:
            Number(
                result.currentPrice !==
                    undefined &&
                result.currentPrice !==
                    null
                    ?
                    result.currentPrice
                    :
                    (
                        result.price !==
                            undefined &&
                        result.price !==
                            null
                            ?
                            result.price
                            :
                            (
                                result.watchPrice !==
                                    undefined &&
                                result.watchPrice !==
                                    null
                                    ?
                                    result.watchPrice
                                    :
                                    result.referencePrice
                            )
                    )
            ),


        // ==================================================
        // MAIN EXPIRATION
        // ==================================================

        expirationMinutes: expirationMinutes,


        // ==================================================
        // CREATED
        // ==================================================

        createdAt: new Date(
                now
            )
            .toISOString(),


        createdAtMs: now,


        // ==================================================
        // MAIN EXPIRY
        // ==================================================

        expiryAt: new Date(
                expiryAtMs
            )
            .toISOString(),


        expiryAtMs: expiryAtMs,


        // ==================================================
        // STATUS
        // ==================================================

        status: 'PENDING',


        // ==================================================
        // RESULT
        // ==================================================

        resultPrice: null,


        result: null,


        priceDifference: null,


        checkedAt: null,


        // ==================================================
        // RESEARCH RESULTS
        //
        // We will later populate this with outcomes
        // for 5 / 10 / 15 / 20 etc.
        // ==================================================

        researchResults: {}
    };


    history.push(
        record
    );


    saveHistory(
        history
    );


    console.log(
        '[SIGNAL LOGGER]',
        'Logged:',
        record.symbol,
        record.signal,
        'Score:',
        record.score,
        'Data:',
        record.dataAgeStatus,
        record.dataAgeSeconds,
        'sec',
        'Expiration:',
        record.expirationMinutes,
        'min',
        'Research:',
        record.researchHorizons
    );


    return record;
}


// ======================================================
// RESOLVE RESULT
// ======================================================

function resolveSignal(
    id,
    currentPrice
) {

    const history =
        loadHistory();


    const record =
        history.find(
            item =>
            item.id ===
            id
        );


    if (!record) {
        return null;
    }


    if (
        record.status !==
        'PENDING'
    ) {
        return record;
    }


    const price =
        Number(
            currentPrice
        );


    if (!Number.isFinite(
            price
        )) {
        return null;
    }


    const startPrice =
        Number(
            record.entryPrice
        );


    if (!Number.isFinite(
            startPrice
        )) {
        return null;
    }


    const difference =
        price -
        startPrice;


    let outcome =
        'DRAW';


    if (
        record.signal ===
        'UP'
    ) {

        if (
            price >
            startPrice
        ) {
            outcome =
                'WIN';
        } else if (
            price <
            startPrice
        ) {
            outcome =
                'LOSS';
        }
    }


    if (
        record.signal ===
        'DOWN'
    ) {

        if (
            price <
            startPrice
        ) {
            outcome =
                'WIN';
        } else if (
            price >
            startPrice
        ) {
            outcome =
                'LOSS';
        }
    }


    record.resultPrice =
        price;


    record.priceDifference =
        difference;


    record.result =
        outcome;


    record.status =
        'COMPLETED';


    record.checkedAt =
        new Date()
        .toISOString();


    saveHistory(
        history
    );


    console.log(
        '[SIGNAL LOGGER]',
        record.symbol,
        record.signal,
        '→',
        outcome,
        '|',
        record.entryPrice,
        '→',
        record.resultPrice
    );


    return record;
}


// ======================================================
// PENDING SIGNALS
// ======================================================

function getExpiredPendingSignals() {

    const history =
        loadHistory();


    const now =
        Date.now();


    return history.filter(
        item =>
        item.status ===
        'PENDING' &&
        item.expiryAtMs <=
        now
    );
}


// ======================================================
// HISTORY
// ======================================================

function getSignalHistory(
    limit = 200
) {

    const history =
        loadHistory();


    return history
        .slice()
        .reverse()
        .slice(
            0,
            limit
        );
}


// ======================================================
// STATISTICS
// ======================================================

function getSignalStats() {

    const history =
        loadHistory();


    const completed =
        history.filter(
            item =>
            item.status ===
            'COMPLETED'
        );


    const wins =
        completed.filter(
            item =>
            item.result ===
            'WIN'
        )
        .length;


    const losses =
        completed.filter(
            item =>
            item.result ===
            'LOSS'
        )
        .length;


    const draws =
        completed.filter(
            item =>
            item.result ===
            'DRAW'
        )
        .length;


    const decided =
        wins +
        losses;


    const pending =
        history.filter(
            item =>
            item.status ===
            'PENDING'
        )
        .length;


    // ==================================================
    // DATA FRESHNESS STATS
    // ==================================================

    const freshness = {};


    completed.forEach(
        item => {

            const key =
                item.dataAgeStatus ||
                'UNKNOWN';


            if (!freshness[key]) {
                freshness[key] = {
                    total: 0,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    winRate: 0
                };
            }


            freshness[key]
                .total++;


            if (
                item.result ===
                'WIN'
            ) {
                freshness[key]
                    .wins++;
            } else if (
                item.result ===
                'LOSS'
            ) {
                freshness[key]
                    .losses++;
            } else if (
                item.result ===
                'DRAW'
            ) {
                freshness[key]
                    .draws++;
            }
        }
    );


    Object.keys(
            freshness
        )
        .forEach(
            key => {

                const group =
                    freshness[key];


                const groupDecided =
                    group.wins +
                    group.losses;


                group.winRate =
                    groupDecided ?
                    Number(
                        (
                            group.wins /
                            groupDecided *
                            100
                        )
                        .toFixed(
                            1
                        )
                    ) :
                    0;
            }
        );


    return {

        total: history.length,


        completed: completed.length,


        pending,


        wins,


        losses,


        draws,


        winRate: decided ?
            Number(
                (
                    wins /
                    decided *
                    100
                )
                .toFixed(
                    1
                )
            ) : 0,


        freshness
    };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    logSignal,
    resolveSignal,
    getExpiredPendingSignals,
    getSignalHistory,
    getSignalStats
};