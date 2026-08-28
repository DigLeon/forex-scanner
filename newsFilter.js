// ======================================================
// NEWS FILTER
// ======================================================

const MAJOR_EVENTS = [
    'CPI',
    'CORE CPI',
    'PPI',
    'NFP',
    'NONFARM PAYROLLS',
    'INTEREST RATE DECISION',
    'FOMC',
    'FEDERAL RESERVE',
    'BANK OF CANADA',
    'BOC',
    'ECB',
    'BANK OF ENGLAND',
    'BOE',
    'GDP',
    'UNEMPLOYMENT RATE'
];


// ======================================================
// BLOCK WINDOWS
// ======================================================

const BLOCK_BEFORE_HIGH = 30;
const BLOCK_AFTER_HIGH = 15;

const BLOCK_BEFORE_MAJOR = 60;
const BLOCK_AFTER_MAJOR = 30;


// ======================================================
// NORMALIZE SYMBOL
//
// GBP/USD -> ["GBP", "USD"]
// EURCAD  -> ["EUR", "CAD"]
// ======================================================

function getPairCurrencies(symbol) {

    if (typeof symbol !== 'string') {
        return [];
    }

    const clean =
        symbol
        .trim()
        .toUpperCase()
        .replace(/[^A-Z]/g, '');


    if (clean.length !== 6) {
        return [];
    }


    return [
        clean.substring(0, 3),
        clean.substring(3, 6)
    ];
}


// ======================================================
// MAJOR EVENT
// ======================================================

function isMajorEvent(eventName) {

    if (typeof eventName !== 'string') {
        return false;
    }


    const name =
        eventName
        .trim()
        .toUpperCase();


    return MAJOR_EVENTS.some(
        event =>
        name.includes(event)
    );
}


// ======================================================
// HIGH IMPACT
// ======================================================

function isHighImpact(impact) {

    if (typeof impact !== 'string') {
        return false;
    }


    const value =
        impact
        .trim()
        .toUpperCase();


    return (
        value === 'HIGH' ||
        value === '3' ||
        value === 'RED'
    );
}


// ======================================================
// MINUTES BETWEEN
// ======================================================

function minutesBetween(dateA, dateB) {

    return Math.round(
        (
            dateB.getTime() -
            dateA.getTime()
        ) /
        60000
    );
}


// ======================================================
// CHECK NEWS RISK
// ======================================================

function checkNewsRisk(
    symbol,
    events = []
) {

    const currencies =
        getPairCurrencies(symbol);


    if (currencies.length !== 2) {

        return {
            blocked: false,
            reason: 'Invalid symbol'
        };
    }


    if (!Array.isArray(events)) {

        return {
            blocked: false,
            reason: 'No economic calendar'
        };
    }


    const now =
        new Date();


    let nearestBlockingEvent =
        null;


    for (const event of events) {

        if (!event ||
            typeof event !== 'object'
        ) {
            continue;
        }


        // ==============================================
        // EVENT CURRENCY
        // ==============================================

        const eventCurrency =
            typeof event.currency === 'string' ?
            event.currency
            .trim()
            .toUpperCase() :
            '';


        if (!eventCurrency) {
            continue;
        }


        // News must belong to one of the
        // currencies in the pair.

        if (!currencies.includes(
                eventCurrency
            )) {
            continue;
        }


        // ==============================================
        // EVENT NAME
        // ==============================================

        const eventName =
            typeof event.event === 'string' ?
            event.event :
            (
                typeof event.name === 'string' ?
                event.name :
                ''
            );


        // ==============================================
        // IMPACT
        // ==============================================

        const major =
            isMajorEvent(
                eventName
            );


        const high =
            isHighImpact(
                event.impact
            );


        /*
            MEDIUM / LOW news does not block
            the pair.

            Major events are blocked even if
            provider labels impact differently.
        */

        if (!major && !high) {
            continue;
        }


        // ==============================================
        // EVENT TIME
        // ==============================================

        const rawDate =
            event.datetime ||
            event.date ||
            event.time;


        if (!rawDate) {
            continue;
        }


        const eventTime =
            new Date(
                rawDate
            );


        if (
            Number.isNaN(
                eventTime.getTime()
            )
        ) {
            continue;
        }


        const minutesUntilEvent =
            minutesBetween(
                now,
                eventTime
            );


        // ==============================================
        // BLOCK WINDOW
        // ==============================================

        const beforeMinutes =
            major ?
            BLOCK_BEFORE_MAJOR :
            BLOCK_BEFORE_HIGH;


        const afterMinutes =
            major ?
            BLOCK_AFTER_MAJOR :
            BLOCK_AFTER_HIGH;


        /*
            Example:

            CPI 08:30

            major:
            07:30 -> block starts
            08:30 -> event
            09:00 -> block ends
        */

        if (
            minutesUntilEvent >
            beforeMinutes
        ) {
            continue;
        }


        if (
            minutesUntilEvent <
            -afterMinutes
        ) {
            continue;
        }


        const blockedUntil =
            new Date(
                eventTime.getTime() +
                afterMinutes * 60000
            );


        const candidate = {

            blocked: true,

            symbol: String(symbol),

            currencies: currencies,

            currency: eventCurrency,

            impact: major ?
                'MAJOR' :
                'HIGH',

            originalImpact: event.impact || null,

            event: eventName ||
                'Economic event',

            major: major,

            eventTime: eventTime.toISOString(),

            minutesUntilEvent: minutesUntilEvent,

            blockBeforeMinutes: beforeMinutes,

            blockAfterMinutes: afterMinutes,

            blockedUntil: blockedUntil.toISOString()
        };


        // Keep nearest relevant event.

        if (!nearestBlockingEvent ||
            Math.abs(
                candidate.minutesUntilEvent
            ) <
            Math.abs(
                nearestBlockingEvent
                .minutesUntilEvent
            )
        ) {

            nearestBlockingEvent =
                candidate;
        }
    }


    if (nearestBlockingEvent) {
        return nearestBlockingEvent;
    }


    return {

        blocked: false,

        symbol: String(symbol),

        currencies: currencies
    };
}


// ======================================================
// FILTER ALL PAIRS
// ======================================================

function filterPairsByNews(
    symbols,
    events = []
) {

    const tradable = [];
    const blocked = [];


    if (!Array.isArray(symbols)) {

        return {
            tradable,
            blocked
        };
    }


    for (const symbol of symbols) {

        const risk =
            checkNewsRisk(
                symbol,
                events
            );


        if (risk.blocked) {

            blocked.push({
                symbol: String(symbol),

                ...risk
            });

        } else {

            tradable.push(
                symbol
            );
        }
    }


    return {
        tradable,
        blocked
    };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    checkNewsRisk,
    filterPairsByNews,
    getPairCurrencies,
    isMajorEvent
};