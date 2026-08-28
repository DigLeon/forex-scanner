// ======================================================
// decisionEngine.js
// v4.6 — Decision Integrity
// ======================================================
//
// One final gate decides whether a setup is TRADE / WAIT /
// SKIP / ERROR. No other module should promote a result to
// TRADE after this function runs.
// ======================================================

const DECISIONS =
    Object.freeze({
        TRADE: 'TRADE',
        WAIT: 'WAIT',
        SKIP: 'SKIP',
        ERROR: 'ERROR'
    });


const REASON_CODES =
    Object.freeze({
        TRADE_CONFIRMED: 'TRADE_CONFIRMED',

        WAIT_RETEST: 'WAIT_RETEST',
        WAIT_CANDLE: 'WAIT_CANDLE',
        WAIT_CONFIRMATION: 'WAIT_CONFIRMATION',
        WAIT_ENTRY_ZONE: 'WAIT_ENTRY_ZONE',

        SKIP_TOO_LATE: 'SKIP_TOO_LATE',
        SKIP_WORST_ENTRY: 'SKIP_WORST_ENTRY',
        SKIP_NOT_RECOMMENDED: 'SKIP_NOT_RECOMMENDED',
        SKIP_NO_SIGNAL: 'SKIP_NO_SIGNAL',
        SKIP_CONTEXT_CONFLICT: 'SKIP_CONTEXT_CONFLICT',
        SKIP_DATA_STALE: 'SKIP_DATA_STALE',
        SKIP_NEWS: 'SKIP_NEWS',
        SKIP_WEAK_SCORE: 'SKIP_WEAK_SCORE',
        SKIP_WEAK_EDGE: 'SKIP_WEAK_EDGE',

        ERROR_MARKET_DATA: 'ERROR_MARKET_DATA',
        ERROR_ANALYSIS: 'ERROR_ANALYSIS',
        ERROR_UNKNOWN: 'ERROR_UNKNOWN'
    });


function upper(
    value
) {

    return String(
            value ||
            ''
        )
        .trim()
        .toUpperCase();
}


function numberOrNull(
    value
) {

    const number =
        Number(
            value
        );


    return Number.isFinite(
            number
        )
        ?
        number
        :
        null;
}


function makeDecision({
    symbol,
    analysis,
    dataFreshness,
    newsRisk,
    error
}) {

    // ==================================================
    // TECHNICAL ERROR
    // ==================================================

    if (
        error
    ) {

        return {

            decision:
                DECISIONS.ERROR,

            reasonCode:
                error.code ||
                REASON_CODES.ERROR_UNKNOWN,

            reason:
                error.message ||
                'Unknown scanner error',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    const safeAnalysis =
        analysis &&
        typeof analysis ===
            'object'
            ?
            analysis
            :
            {};


    const diagnostics =
        safeAnalysis.signalDiagnostics &&
        typeof safeAnalysis.signalDiagnostics ===
            'object'
            ?
            safeAnalysis.signalDiagnostics
            :
            {};


    const entryZone =
        safeAnalysis.entryZone &&
        typeof safeAnalysis.entryZone ===
            'object'
            ?
            safeAnalysis.entryZone
            :
            {};


    const entryEngine =
        (
            safeAnalysis.entryEngine ||
            safeAnalysis.entryTiming
        ) &&
        typeof (
            safeAnalysis.entryEngine ||
            safeAnalysis.entryTiming
        ) ===
            'object'
            ?
            (
                safeAnalysis.entryEngine ||
                safeAnalysis.entryTiming
            )
            :
            {};


    const signalStrength =
        safeAnalysis.signalStrength &&
        typeof safeAnalysis.signalStrength ===
            'object'
            ?
            safeAnalysis.signalStrength
            :
            {};


    const candleConfirmation =
        safeAnalysis.candleConfirmation &&
        typeof safeAnalysis.candleConfirmation ===
            'object'
            ?
            safeAnalysis.candleConfirmation
            :
            {};


    const signal =
        upper(
            safeAnalysis.signal
        );


    const score =
        numberOrNull(
            safeAnalysis.score
        ) ||
        0;


    const requiredScore =
        numberOrNull(
            diagnostics.requiredScore
        );


    const actualEdge =
        numberOrNull(
            diagnostics.actualEdge
        );


    const requiredEdge =
        numberOrNull(
            diagnostics.requiredEdge
        );


    // ==================================================
    // HARD BLOCKS
    // ==================================================

    if (
        newsRisk &&
        newsRisk.blocked
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_NEWS,

            reason:
                'High-impact news risk is active',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        dataFreshness &&
        dataFreshness.stale
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_DATA_STALE,

            reason:
                dataFreshness.reason ||
                'Market data is stale',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        signal !==
            'UP' &&
        signal !==
            'DOWN'
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_NO_SIGNAL,

            reason:
                'No confirmed UP/DOWN signal',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    const entryZoneStatus =
        upper(
            entryZone.status
        );


    const entryQuality =
        upper(
            entryZone.currentEntryQuality
        );


    if (
        entryZoneStatus ===
            'TOO LATE' ||
        entryEngine.status ===
            'TOO LATE'
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_TOO_LATE,

            reason:
                entryZone.reason ||
                entryEngine.reason ||
                'Price is already beyond the allowed entry area',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        entryQuality.includes(
            'WORST ENTRY'
        ) ||
        entryQuality.includes(
            'DO NOT ENTER'
        )
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_WORST_ENTRY,

            reason:
                entryZone.reason ||
                'Worst-entry / do-not-enter boundary reached',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        upper(
            signalStrength.recommendation
        ) ===
            'NOT RECOMMENDED'
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_NOT_RECOMMENDED,

            reason:
                'Signal strength engine does not recommend the entry',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        diagnostics.contextSetupConflict ===
            true
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_CONTEXT_CONFLICT,

            reason:
                'Higher-timeframe context conflicts with setup',

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        requiredScore !==
            null &&
        score <
            requiredScore
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_WEAK_SCORE,

            reason:
                `Score ${score} is below required ${requiredScore}`,

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    if (
        requiredEdge !==
            null &&
        actualEdge !==
            null &&
        actualEdge <
            requiredEdge
    ) {

        return {

            decision:
                DECISIONS.SKIP,

            reasonCode:
                REASON_CODES.SKIP_WEAK_EDGE,

            reason:
                `Directional edge ${actualEdge} is below required ${requiredEdge}`,

            symbol:
                symbol,

            hardBlock:
                true
        };
    }


    // ==================================================
    // WAIT STATES
    // ==================================================

    if (
        signal !== 'NO SIGNAL' &&
        candleConfirmation.confirmed !== true
    ) {
        return {
            decision: DECISIONS.WAIT,
            reasonCode: REASON_CODES.WAIT_CANDLE,
            reason:
                candleConfirmation.reason ||
                'Waiting for closed 1M / 3M candle confirmation',
            symbol: symbol,
            hardBlock: false
        };
    }

    const entryStatus =
        upper(
            entryEngine.status
        );


    if (
        entryStatus ===
            'WAIT FOR RETEST'
    ) {

        return {

            decision:
                DECISIONS.WAIT,

            reasonCode:
                REASON_CODES.WAIT_RETEST,

            reason:
                entryEngine.reason ||
                'Waiting for structural retest',

            symbol:
                symbol,

            hardBlock:
                false
        };
    }


    if (
        entryStatus ===
            'WAIT FOR CANDLE'
    ) {

        return {

            decision:
                DECISIONS.WAIT,

            reasonCode:
                REASON_CODES.WAIT_CANDLE,

            reason:
                entryEngine.reason ||
                'Waiting for closed-candle confirmation',

            symbol:
                symbol,

            hardBlock:
                false
        };
    }


    if (
        entryStatus ===
            'WAIT FOR CONFIRMATION' ||
        entryStatus ===
            'CAUTION'
    ) {

        return {

            decision:
                DECISIONS.WAIT,

            reasonCode:
                REASON_CODES.WAIT_CONFIRMATION,

            reason:
                entryEngine.reason ||
                'Entry confirmation is not strong enough yet',

            symbol:
                symbol,

            hardBlock:
                false
        };
    }


    if (
        entryZone.available &&
        (
            entryZoneStatus.includes(
                'WAIT'
            ) ||
            entryQuality.includes(
                'WAIT'
            )
        )
    ) {

        return {

            decision:
                DECISIONS.WAIT,

            reasonCode:
                REASON_CODES.WAIT_ENTRY_ZONE,

            reason:
                entryZone.reason ||
                'Waiting for preferred entry zone',

            symbol:
                symbol,

            hardBlock:
                false
        };
    }


    // ==================================================
    // TRADE
    // ==================================================
    //
    // Only explicit entry confirmation reaches TRADE.
    // ==================================================

    if (
        entryStatus ===
            'ENTER NOW'
    ) {

        return {

            decision:
                DECISIONS.TRADE,

            reasonCode:
                REASON_CODES.TRADE_CONFIRMED,

            reason:
                entryEngine.reason ||
                'Signal and entry confirmation passed all final gates',

            symbol:
                symbol,

            hardBlock:
                false
        };
    }


    // Conservative default
    return {

        decision:
            DECISIONS.WAIT,

        reasonCode:
            REASON_CODES.WAIT_CONFIRMATION,

        reason:
            'Setup exists, but final entry confirmation is incomplete',

        symbol:
            symbol,

        hardBlock:
            false
    };
}


module.exports = {
    DECISIONS,
    REASON_CODES,
    makeDecision
};
