const fs =
    require('fs');

const path =
    require('path');


const HISTORY_FILE =
    path.join(
        __dirname,
        'signal-history.json'
    );


// v4.17 Outcome Engine: fixed research checkpoints used for comparable statistics.
const OUTCOME_HORIZONS_MINUTES = [3, 5, 10, 15, 20, 22, 25, 30];
const EXPIRATION_GENERATION_PRICE_HORIZONS_MINUTES = [5, 10, 15, 20, 30];
const WAIT_RESEARCH_MIN_SCORE = 50;
const OUTCOME_FLAT_BPS = Math.max(0, Number(process.env.OUTCOME_FLAT_BPS) || 0.5);

function classifyOutcome(direction, startPrice, price) {
    const start = Number(startPrice);
    const current = Number(price);
    if (!Number.isFinite(start) || !Number.isFinite(current) || start <= 0) return 'INCOMPLETE';
    const moveBps = ((current - start) / start) * 10000;
    if (Math.abs(moveBps) <= OUTCOME_FLAT_BPS) return 'FLAT';
    if (direction === 'UP') return moveBps > 0 ? 'WIN' : 'LOSS';
    if (direction === 'DOWN') return moveBps < 0 ? 'WIN' : 'LOSS';
    return 'INCOMPLETE';
}


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

function getSignalLogSkipReason(
    result
) {

    if (!result) {
        return 'NO_RESULT';
    }

    if (
        result.signal !== 'UP' &&
        result.signal !== 'DOWN'
    ) {
        return 'INVALID_DIRECTION';
    }

    const decision = String(result.decision || result.action || '').toUpperCase();

    // v5.3.4.4 research rule:
    // persist only GUI WAIT/TRADE decisions with score strictly above 50.
    if (decision !== 'WAIT' && decision !== 'TRADE') {
        return 'UNSUPPORTED_DECISION';
    }

    const score = Number(result.score);
    if (!Number.isFinite(score) || score <= 50) {
        return 'SCORE_NOT_ABOVE_50';
    }

    const expirationMinutes = Number(
        result.recommendedExpiration !== undefined &&
        result.recommendedExpiration !== null
            ? result.recommendedExpiration
            : result.expirationMinutes
    );

    if (
        !Number.isFinite(expirationMinutes) ||
        expirationMinutes <= 0
    ) {
        return 'NO_VALID_EXPIRATION';
    }

    const watchPrice = Number(
        result.watchPrice !== undefined &&
        result.watchPrice !== null
            ? result.watchPrice
            : (
                result.referencePrice !== undefined &&
                result.referencePrice !== null
                    ? result.referencePrice
                    : (
                        result.currentPrice !== undefined &&
                        result.currentPrice !== null
                            ? result.currentPrice
                            : result.price
                    )
            )
    );

    if (!Number.isFinite(watchPrice)) {
        return 'NO_VALID_PRICE';
    }

    // Data freshness is kept as metadata for later analysis, but it no longer
    // blocks research logging. If a WAIT/TRADE is visible in the GUI and its
    // score is > 50, we want it in the end-of-day sample.
    return null;
}

function logSignalSkipDiagnostic(result, reason, extra = null) {
    const symbol = result && result.symbol ? result.symbol : 'UNKNOWN';
    const signal = result && result.signal ? result.signal : 'UNKNOWN';
    const decision = String(
        (result && (result.decision || result.action)) || 'TRADE'
    ).toUpperCase();
    const score = Number(result && result.score);
    const expirationMinutes = Number(
        result && result.recommendedExpiration !== undefined &&
        result.recommendedExpiration !== null
            ? result.recommendedExpiration
            : result && result.expirationMinutes
    );
    const dataAgeStatus = getDataAgeStatus(result);

    console.log(
        '[SIGNAL LOGGER SKIP]',
        `${symbol} ${signal} ${decision}`,
        '| Reason:', reason,
        '| Score:', Number.isFinite(score) ? score : 'N/A',
        '| Exp:', Number.isFinite(expirationMinutes) ? expirationMinutes : 'N/A',
        '| Data:', dataAgeStatus,
        extra ? `| ${extra}` : ''
    );
}

function shouldLogSignal(
    result
) {
    return getSignalLogSkipReason(result) === null;
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

    // Keep TRADE and WAIT research samples independent. A high-score WAIT
    // must never block a later real TRADE for the same pair/direction.
    const resultDecision = String(result.decision || result.action || 'TRADE').toUpperCase();
    const resultSetupId = result.setupId ? String(result.setupId) : null;

    return history.some(
        item => {

            if (item.symbol !== result.symbol) {
                return false;
            }

            if (item.signal !== result.signal) {
                return false;
            }

            const itemDecision = String(item.decision || 'TRADE').toUpperCase();
            if (itemDecision !== resultDecision) {
                return false;
            }

            // If lifecycle setupId is available, log only one research record
            // per setup + decision, even after its first horizon resolves.
            if (resultSetupId && item.setupId && String(item.setupId) === resultSetupId) {
                return true;
            }

            // Fallback for older/no-setupId records: only prevent overlapping
            // pending samples of the same decision type.
            return item.status === 'PENDING';
        }
    );
}


// ======================================================
// LOG SIGNAL
// ======================================================

function logSignal(
    result
) {

    const skipReason = getSignalLogSkipReason(result);

    if (skipReason) {
        logSignalSkipDiagnostic(result, skipReason);
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
        logSignalSkipDiagnostic(result, 'RECENT_DUPLICATE');
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


    const suppliedExpirationGeneratedAtMs = Number(result.expirationGeneratedAtMs);
    const suppliedExpirationGeneratedAt = result.expirationGeneratedAt
        ? Date.parse(result.expirationGeneratedAt)
        : NaN;
    const expirationGeneratedAtMs = Number.isFinite(suppliedExpirationGeneratedAtMs)
        ? suppliedExpirationGeneratedAtMs
        : (Number.isFinite(suppliedExpirationGeneratedAt) ? suppliedExpirationGeneratedAt : now);

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


    const researchMetadata =
        result.researchMetadata &&
        typeof result.researchMetadata === 'object'
            ? result.researchMetadata
            : null;


    const researchHorizons =
        Array.from(new Set([
            ...OUTCOME_HORIZONS_MINUTES,
            ...getResearchHorizons(dataAgeStatus),
            Number(expirationMinutes)
        ].filter(v => Number.isFinite(Number(v)) && Number(v) > 0)))
        .map(Number)
        .sort((a, b) => a - b);


    const record = {

        // ==================================================
        // IDENTITY
        // ==================================================

        id: createSignalId(
            result.symbol,
            result.signal,
            now
        ),

        setupId: result.setupId || createSignalId(result.symbol, result.signal, now),

        symbol: result.symbol,


        signal: result.signal,


        marketBias: result.marketBias ||
            null,


        signalStage: result.signalStage ||
            null,

        // Decision-quality snapshot for historical effectiveness analysis
        decision: result.decision || result.action || 'TRADE',
        entryStatus: result.entryZone ? (result.entryZone.status || null) : null,
        entryQuality: result.entryZone ? (result.entryZone.currentEntryQuality || result.entryQuality || null) : (result.entryQuality || null),
        entryScore: result.entryZone ? Number(result.entryZone.currentEntryScore ?? result.entryScore) : Number(result.entryScore),
        strengthScore: result.signalStrength ? Number(result.signalStrength.score) : null,
        strengthLevel: result.signalStrength ? (result.signalStrength.level || null) : null,
        strengthRecommendation: result.signalStrength ? (result.signalStrength.recommendation || null) : null,
        candleConfirmed: result.candleConfirmation ? result.candleConfirmation.confirmed === true : null,
        fvgId: result.entryZone ? (result.entryZone.fvgId || null) : null,
        fvgTimeframe: result.entryZone ? (result.entryZone.timeframe || null) : null,
        requiredScore: result.diagnostics ? Number(result.diagnostics.requiredScore ?? result.diagnostics.effectiveMinScore) : null,
        actualEdge: result.diagnostics ? Number(result.diagnostics.actualEdge) : null,
        contextSetupAligned: result.diagnostics ? result.diagnostics.contextSetupAligned === true : null,


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
        // RESEARCH METADATA SNAPSHOT
        // Diagnostic only; never feeds back into the signal.
        // ==================================================

        researchMetadata,

        rsi1m: researchMetadata ? researchMetadata.rsi1m : null,
        rsi5m: researchMetadata ? researchMetadata.rsi5m : null,
        rsi15m: researchMetadata ? researchMetadata.rsi15m : null,

        atr1m: researchMetadata ? researchMetadata.atr1m : null,
        atr1mPct: researchMetadata ? researchMetadata.atr1mPct : null,
        atr5m: researchMetadata ? researchMetadata.atr5m : null,
        atr5mPct: researchMetadata ? researchMetadata.atr5mPct : null,
        atr15m: researchMetadata ? researchMetadata.atr15m : null,
        atr15mPct: researchMetadata ? researchMetadata.atr15mPct : null,

        macd5mLine: researchMetadata ? researchMetadata.macd5mLine : null,
        macd5mSignal: researchMetadata ? researchMetadata.macd5mSignal : null,
        macd5mHistogram: researchMetadata ? researchMetadata.macd5mHistogram : null,

        distanceToBestEntryAtr: researchMetadata ? researchMetadata.distanceToBestEntryAtr : null,


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
        // EXPIRATION-GENERATION RESEARCH CLOCK
        // Dedicated market-price checkpoints measured from the
        // exact moment the expiration timestamp was generated.
        // Tracked for WAIT and TRADE records alike.
        // ==================================================
        expirationGeneratedAt: new Date(expirationGeneratedAtMs).toISOString(),
        expirationGeneratedAtMs: expirationGeneratedAtMs,

        priceAfter5MinutesTargetAt: new Date(expirationGeneratedAtMs + 5 * 60 * 1000).toISOString(),
        priceAfter5MinutesTargetAtMs: expirationGeneratedAtMs + 5 * 60 * 1000,
        priceAfter5Minutes: null,
        priceAfter5MinutesObservedAt: null,
        priceAfter5MinutesStatus: 'PENDING',
        priceAfter5MinutesApproximate: null,
        priceAfter5MinutesSource: null,

        priceAfter10MinutesTargetAt: new Date(expirationGeneratedAtMs + 10 * 60 * 1000).toISOString(),
        priceAfter10MinutesTargetAtMs: expirationGeneratedAtMs + 10 * 60 * 1000,
        priceAfter10Minutes: null,
        priceAfter10MinutesObservedAt: null,
        priceAfter10MinutesStatus: 'PENDING',
        priceAfter10MinutesApproximate: null,
        priceAfter10MinutesSource: null,

        priceAfter15MinutesTargetAt: new Date(expirationGeneratedAtMs + 15 * 60 * 1000).toISOString(),
        priceAfter15MinutesTargetAtMs: expirationGeneratedAtMs + 15 * 60 * 1000,
        priceAfter15Minutes: null,
        priceAfter15MinutesObservedAt: null,
        priceAfter15MinutesStatus: 'PENDING',
        priceAfter15MinutesApproximate: null,
        priceAfter15MinutesSource: null,

        priceAfter20MinutesTargetAt: new Date(expirationGeneratedAtMs + 20 * 60 * 1000).toISOString(),
        priceAfter20MinutesTargetAtMs: expirationGeneratedAtMs + 20 * 60 * 1000,
        priceAfter20Minutes: null,
        priceAfter20MinutesObservedAt: null,
        priceAfter20MinutesStatus: 'PENDING',
        priceAfter20MinutesApproximate: null,
        priceAfter20MinutesSource: null,

        priceAfter30MinutesTargetAt: new Date(expirationGeneratedAtMs + 30 * 60 * 1000).toISOString(),
        priceAfter30MinutesTargetAtMs: expirationGeneratedAtMs + 30 * 60 * 1000,
        priceAfter30Minutes: null,
        priceAfter30MinutesObservedAt: null,
        priceAfter30MinutesStatus: 'PENDING',
        priceAfter30MinutesApproximate: null,
        priceAfter30MinutesSource: null,

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

        researchResults: {},

        // v4.17 sampled path statistics. These are PAPER observations only.
        outcomeTracking: {
            samples: 0,
            lastObservedAt: null,
            lastObservedPrice: null,
            mfePrice: null,
            maePrice: null,
            mfeBps: 0,
            maeBps: 0,
            samplingApproximate: true
        }
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


function parseOutcomeCandleTime(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
        ? raw
        : raw.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function historicalCloseAtOrAfter(candles, targetMs) {
    if (!Array.isArray(candles) || !Number.isFinite(Number(targetMs))) return null;
    let best = null;
    for (const candle of candles) {
        const openMs = parseOutcomeCandleTime(candle && candle.datetime);
        const close = Number(candle && candle.close);
        if (!Number.isFinite(openMs) || !Number.isFinite(close)) continue;
        const closeMs = openMs + 60 * 1000;
        if (closeMs >= targetMs && (!best || closeMs < best.closeMs)) {
            best = { price: close, closeMs, datetime: candle.datetime };
        }
    }
    return best;
}

// ======================================================
// v5.0 OUTCOME OBSERVATION
//
// Samples all pending PAPER signals for a symbol, updates
// MFE/MAE and closes 3/5/10/15-minute research horizons.
// It intentionally does not create a trading decision.
// ======================================================

function observePendingSignals(symbol, currentPrice, observedAtMs = Date.now(), options = {}) {
    const price = Number(currentPrice);
    const atMs = Number(observedAtMs);
    if (!symbol || !Number.isFinite(price) || !Number.isFinite(atMs)) return [];

    const history = loadHistory();
    let changed = false;
    const updated = [];

    for (const record of history) {
        if (record.symbol !== symbol) continue;

        const start = Number(record.entryPrice);
        if (!Number.isFinite(start) || start <= 0) continue;

        // Dedicated research checkpoints: capture the market price at
        // +5m / +10m / +15m / +20m / +30m from the exact moment the
        // expiration timestamp was GENERATED. This remains active even
        // after the main signal has already been completed.
        for (const minutes of EXPIRATION_GENERATION_PRICE_HORIZONS_MINUTES) {
            const prefix = `priceAfter${minutes}Minutes`;
            const statusKey = `${prefix}Status`;
            const targetKey = `${prefix}TargetAtMs`;
            const targetIsoKey = `${prefix}TargetAt`;
            const observedAtKey = `${prefix}ObservedAt`;
            const approximateKey = `${prefix}Approximate`;
            const sourceKey = `${prefix}Source`;

            // Backward compatibility for older records that already have
            // expirationGeneratedAtMs but not the newly added checkpoints.
            if (!record[statusKey] && Number.isFinite(Number(record.expirationGeneratedAtMs))) {
                const targetMs = Number(record.expirationGeneratedAtMs) + minutes * 60 * 1000;
                record[targetKey] = targetMs;
                record[targetIsoKey] = new Date(targetMs).toISOString();
                record[prefix] = null;
                record[observedAtKey] = null;
                record[statusKey] = 'PENDING';
                record[approximateKey] = null;
                record[sourceKey] = null;
                changed = true;
            }

            if (String(record[statusKey] || '').toUpperCase() !== 'PENDING') continue;

            const targetMs = Number(record[targetKey]);
            if (!Number.isFinite(targetMs) || atMs < targetMs) continue;

            const exact = historicalCloseAtOrAfter(options.candles, targetMs);
            const observedPrice = exact ? exact.price : price;
            const observedAt = exact ? exact.closeMs : atMs;

            record[prefix] = observedPrice;
            record[observedAtKey] = new Date(observedAt).toISOString();
            record[statusKey] = 'COMPLETED';
            record[approximateKey] = !exact;
            record[sourceKey] = exact
                ? 'CLOSED_1M_AT_OR_AFTER_TARGET'
                : 'LIVE_SAMPLE';

            changed = true;
            updated.push(record);
            console.log(`[PRICE +${minutes}M]`, record.symbol, record.signal, '| decision:', record.decision, '| price:', observedPrice);
        }

        if (record.status !== 'PENDING') continue;

        if (!record.outcomeTracking || typeof record.outcomeTracking !== 'object') {
            record.outcomeTracking = { samples: 0, lastObservedAt: null, lastObservedPrice: null, mfePrice: null, maePrice: null, mfeBps: 0, maeBps: 0, samplingApproximate: true };
        }
        const t = record.outcomeTracking;
        const rawBps = ((price - start) / start) * 10000;
        const favorableBps = record.signal === 'UP' ? rawBps : -rawBps;
        const adverseBps = -favorableBps;
        t.samples = Number(t.samples || 0) + 1;
        t.lastObservedAt = new Date(atMs).toISOString();
        t.lastObservedPrice = price;
        if (t.mfePrice === null || favorableBps > Number(t.mfeBps || 0)) { t.mfePrice = price; t.mfeBps = Math.max(0, favorableBps); }
        if (t.maePrice === null || adverseBps > Number(t.maeBps || 0)) { t.maePrice = price; t.maeBps = Math.max(0, adverseBps); }

        record.researchResults = record.researchResults || {};
        const horizons = Array.isArray(record.researchHorizons) ? record.researchHorizons : OUTCOME_HORIZONS_MINUTES;
        const elapsedMs = atMs - Number(record.createdAtMs || 0);
        for (const minutes of horizons) {
            const key = `${Number(minutes)}m`;
            const targetMs = Number(record.createdAtMs || 0) + Number(minutes) * 60 * 1000;
            if (record.researchResults[key] || atMs < targetMs) continue;
            const exact = historicalCloseAtOrAfter(options.candles, targetMs);
            const outcomePrice = exact ? exact.price : price;
            const outcomeAtMs = exact ? exact.closeMs : atMs;
            const outcomeRawBps = ((outcomePrice - start) / start) * 10000;
            const outcome = classifyOutcome(record.signal, start, outcomePrice);
            record.researchResults[key] = {
                minutes: Number(minutes), targetAt: new Date(targetMs).toISOString(),
                observedAt: new Date(outcomeAtMs).toISOString(), price: outcomePrice,
                outcome, moveBps: +Math.abs(outcomeRawBps).toFixed(3),
                signedMoveBps: +(record.signal === 'UP' ? outcomeRawBps : -outcomeRawBps).toFixed(3),
                mfeBps: +Number(t.mfeBps || 0).toFixed(3), maeBps: +Number(t.maeBps || 0).toFixed(3),
                approximate: !exact,
                priceSource: exact ? 'CLOSED_1M_AT_OR_AFTER_TARGET' : 'LIVE_SAMPLE',
                targetDeltaMs: exact ? exact.closeMs - targetMs : atMs - targetMs,
                targetTime: new Date(targetMs).toISOString(),
                observedTime: new Date(outcomeAtMs).toISOString(),
                targetDeltaSeconds: +((outcomeAtMs - targetMs) / 1000).toFixed(3),
                observedPrice: outcomePrice,
                samplesCount: Number(t.samples || 0),
                resultValid: Boolean(exact) && outcomeAtMs >= targetMs && ((outcomeAtMs - targetMs) / 1000) <= (Number(process.env.MAX_VALID_TARGET_DELTA_SECONDS) || 90),
                invalidReason: !exact ? 'LIVE_SAMPLE_APPROXIMATE' : (((outcomeAtMs - targetMs) / 1000) > (Number(process.env.MAX_VALID_TARGET_DELTA_SECONDS) || 90) ? 'OBSERVATION_TOO_LATE' : null)
            };
            console.log('[OUTCOME]', record.symbol, record.signal, '|', key, outcome, '| MFE:', Number(t.mfeBps || 0).toFixed(2), 'bps | MAE:', Number(t.maeBps || 0).toFixed(2), 'bps');
        }
        changed = true;
        updated.push(record);
    }

    if (changed) saveHistory(history);
    return updated;
}

function hasPendingExpirationGenerationPriceCheckpoint(record) {
    if (!record || !record.symbol) return false;
    return EXPIRATION_GENERATION_PRICE_HORIZONS_MINUTES.some(minutes => {
        const status = record[`priceAfter${minutes}MinutesStatus`];
        // Older records may not yet contain all checkpoint fields. If they
        // have an expiration-generation clock, keep them eligible until
        // observePendingSignals lazily initializes the missing checkpoints.
        if (!status && Number.isFinite(Number(record.expirationGeneratedAtMs))) return true;
        return String(status || '').toUpperCase() === 'PENDING';
    });
}

function getPendingSignalSymbols() {
    return Array.from(new Set(
        loadHistory()
            .filter(x => x.symbol && (x.status === 'PENDING' || hasPendingExpirationGenerationPriceCheckpoint(x)))
            .map(x => x.symbol)
    ));
}

// ======================================================
// RESOLVE RESULT
// ======================================================

function resolveSignal(
    id,
    currentPrice,
    options = {}
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


    const exactExpiry = historicalCloseAtOrAfter(options.candles, Number(record.expiryAtMs));
    const price = Number(exactExpiry ? exactExpiry.price : currentPrice);


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


    const outcome = classifyOutcome(record.signal, startPrice, price);


    record.resultPrice =
        price;


    record.priceDifference =
        difference;


    record.result =
        outcome;


    record.status =
        'COMPLETED';


    record.checkedAt = new Date().toISOString();
    record.resultTargetAt = Number.isFinite(Number(record.expiryAtMs))
        ? new Date(Number(record.expiryAtMs)).toISOString()
        : null;
    record.resultObservedAt = exactExpiry
        ? new Date(exactExpiry.closeMs).toISOString()
        : record.checkedAt;
    record.resultPriceSource = exactExpiry ? 'CLOSED_1M_AT_OR_AFTER_EXPIRY' : 'LIVE_SAMPLE';
    record.resultApproximate = !exactExpiry;
    record.resultTargetDeltaMs = exactExpiry && Number.isFinite(Number(record.expiryAtMs))
        ? exactExpiry.closeMs - Number(record.expiryAtMs)
        : null;
    record.resultTargetDeltaSeconds = exactExpiry && Number.isFinite(Number(record.expiryAtMs))
        ? +((exactExpiry.closeMs - Number(record.expiryAtMs)) / 1000).toFixed(3)
        : null;
    record.resultValid = Boolean(exactExpiry) && record.resultTargetDeltaSeconds >= 0 && record.resultTargetDeltaSeconds <= (Number(process.env.MAX_VALID_TARGET_DELTA_SECONDS) || 90);
    record.resultInvalidReason = !exactExpiry ? 'LIVE_SAMPLE_APPROXIMATE' : (record.resultValid ? null : 'OBSERVATION_TOO_LATE');


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

function summarizeSignalSubset(records) {
    const completed = records.filter(item => item.status === 'COMPLETED');
    const wins = completed.filter(item => item.result === 'WIN').length;
    const losses = completed.filter(item => item.result === 'LOSS').length;
    const draws = completed.filter(item => item.result === 'FLAT').length;
    const decided = wins + losses;
    const pending = records.filter(item => item.status === 'PENDING').length;

    const horizonStats = {};
    for (const item of records) {
        const rr = item.researchResults || {};
        for (const [key, value] of Object.entries(rr)) {
            if (!value || !value.outcome) continue;
            if (!horizonStats[key]) {
                horizonStats[key] = { total: 0, wins: 0, losses: 0, flat: 0, winRate: 0 };
            }
            const h = horizonStats[key];
            h.total++;
            if (value.outcome === 'WIN') h.wins++;
            else if (value.outcome === 'LOSS') h.losses++;
            else if (value.outcome === 'FLAT') h.flat++;
        }
    }
    Object.values(horizonStats).forEach(h => {
        const horizonDecided = h.wins + h.losses;
        h.winRate = horizonDecided ? Number((h.wins / horizonDecided * 100).toFixed(1)) : 0;
    });

    const expirationGroups = {};
    for (const item of completed) {
        const minutes = Number(item.expirationMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        const key = String(minutes);
        if (!expirationGroups[key]) {
            expirationGroups[key] = { minutes, total: 0, wins: 0, losses: 0, flat: 0, winRate: 0 };
        }
        const group = expirationGroups[key];
        group.total++;
        if (item.result === 'WIN') group.wins++;
        else if (item.result === 'LOSS') group.losses++;
        else if (item.result === 'FLAT') group.flat++;
    }

    const byExpiration = Object.values(expirationGroups)
        .sort((a, b) => a.minutes - b.minutes)
        .map(group => {
            const decided = group.wins + group.losses;
            return {
                ...group,
                winRate: decided ? Number((group.wins / decided * 100).toFixed(1)) : 0
            };
        });

    const tracked = records.filter(x => x.outcomeTracking && Number(x.outcomeTracking.samples) > 0);
    const avgMfeBps = tracked.length
        ? Number((tracked.reduce((a, x) => a + Number(x.outcomeTracking.mfeBps || 0), 0) / tracked.length).toFixed(2))
        : 0;
    const avgMaeBps = tracked.length
        ? Number((tracked.reduce((a, x) => a + Number(x.outcomeTracking.maeBps || 0), 0) / tracked.length).toFixed(2))
        : 0;

    return {
        total: records.length,
        completed: completed.length,
        pending,
        wins,
        losses,
        draws,
        winRate: decided ? Number((wins / decided * 100).toFixed(1)) : 0,
        byExpiration,
        horizonStats,
        outcomeTracking: {
            tracked: tracked.length,
            avgMfeBps,
            avgMaeBps,
            flatThresholdBps: OUTCOME_FLAT_BPS
        }
    };
}

function getSignalStats() {

    const history = loadHistory();

    // Existing dashboard semantics remain TRADE-only. WAIT research is exposed
    // separately so it cannot contaminate the real trade win-rate sample.
    const trades = history.filter(item =>
        String(item.decision || 'TRADE').toUpperCase() === 'TRADE'
    );

    const waitAtOrAbove50 = history.filter(item =>
        String(item.decision || '').toUpperCase() === 'WAIT' &&
        Number(item.score) >= WAIT_RESEARCH_MIN_SCORE
    );
    const waitAbove60 = history.filter(item =>
        String(item.decision || '').toUpperCase() === 'WAIT' &&
        Number(item.score) > 60
    );

    const tradeStats = summarizeSignalSubset(trades);
    const waitStats = summarizeSignalSubset(waitAtOrAbove50);
    const legacyWaitAbove60Stats = summarizeSignalSubset(waitAbove60);

    // Keep freshness compatible with the previous TRADE statistics response.
    const freshness = {};
    trades.filter(item => item.status === 'COMPLETED').forEach(item => {
        const key = item.dataAgeStatus || 'UNKNOWN';
        if (!freshness[key]) {
            freshness[key] = { total: 0, wins: 0, losses: 0, draws: 0, winRate: 0 };
        }
        const group = freshness[key];
        group.total++;
        if (item.result === 'WIN') group.wins++;
        else if (item.result === 'LOSS') group.losses++;
        else if (item.result === 'FLAT') group.draws++;
    });
    Object.values(freshness).forEach(group => {
        const decided = group.wins + group.losses;
        group.winRate = decided ? Number((group.wins / decided * 100).toFixed(1)) : 0;
    });

    return {
        // Legacy fields stay TRADE-only.
        ...tradeStats,
        freshness,

        // Explicit split for v5 research.
        trade: tradeStats,
        waitAtOrAbove50: {
            thresholdRule: `score >= ${WAIT_RESEARCH_MIN_SCORE}`,
            ...waitStats
        },
        // Backward-compatible legacy slice.
        waitAbove60: {
            thresholdRule: 'score > 60',
            ...legacyWaitAbove60Stats
        },
        allLoggedRecords: history.length
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
    getSignalStats,
    observePendingSignals,
    getPendingSignalSymbols,
    classifyOutcome
};