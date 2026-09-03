'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_FILE = path.join(__dirname, 'analysis-audit-history.json');

const METHOD = 'FOREX_ALGO';
const MARKET_TYPE = 'FOREX';
const RULES_VERSION = process.env.RULES_VERSION || '5.3.4.6';
const ALGORITHM_VERSION = process.env.ALGORITHM_VERSION || '5.3.4.6';
const DATA_SCHEMA_VERSION = process.env.DATA_SCHEMA_VERSION || '2.0.0';
const TIMEZONE = process.env.ANALYSIS_TIMEZONE || 'America/Toronto';

const FIXED_HORIZONS_MINUTES = [3, 5, 10, 15, 20, 22, 25, 30];
const OUTCOME_FLAT_BPS = Math.max(0, Number(process.env.OUTCOME_FLAT_BPS) || 0.5);

// Minute-candle result can be considered exact enough only if the first
// available close AFTER target is not too far away.
// Keep configurable, but do not silently accept stale pre-target candles.
const MAX_VALID_TARGET_DELTA_SECONDS =
    Math.max(0, Number(process.env.MAX_VALID_TARGET_DELTA_SECONDS) || 90);

function safeNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeBool(value) {
    return value === true ? true : value === false ? false : null;
}

function upper(value, fallback = null) {
    const s = value === undefined || value === null ? '' : String(value).trim().toUpperCase();
    return s || fallback;
}

function normalizeDecision(result) {
    const raw = upper(result && (result.decision || result.action || result.signal), 'WAIT');
    if (raw === 'UP' || raw === 'DOWN') return raw;
    if (raw === 'TRADE') {
        const signal = upper(result && result.signal);
        return signal === 'UP' || signal === 'DOWN' ? signal : 'WAIT';
    }
    if (raw === 'WAIT') return 'WAIT';
    // SKIP / NO SETUP / CANDIDATE / INVALID / etc. are research NO_TRADE.
    return 'WAIT';
}

function normalizeNoTradeReason(result) {
    const rawDecision = upper(result && (result.decision || result.action));
    if (rawDecision === 'WAIT') {
        return upper(
            result && (
                result.noTradeReason ||
                result.waitReason ||
                (result.diagnostics && result.diagnostics.blockers &&
                    result.diagnostics.blockers.join('; '))
            )
        );
    }
    if (rawDecision && rawDecision !== 'TRADE' && rawDecision !== 'UP' && rawDecision !== 'DOWN') {
        return upper(
            result && (
                result.noTradeReason ||
                result.skipReason ||
                (result.diagnostics && result.diagnostics.blockers &&
                    result.diagnostics.blockers.join('; '))
            ),
            rawDecision
        );
    }
    return null;
}

function normalizeMarketBias(value) {
    const v = upper(value, 'NEUTRAL');
    if (v === 'BULLISH') return 'UP';
    if (v === 'BEARISH') return 'DOWN';
    if (v === 'UP' || v === 'DOWN') return v;
    return 'NEUTRAL';
}

function normalizeMarketRegime(value) {
    const v = upper(value, 'TRANSITION');
    if (v.includes('TREND')) return 'TREND';
    if (v.includes('RANGE')) return 'RANGE';
    return 'TRANSITION';
}

function normalizeSignalStage(value, result) {
    const v = upper(value, '');
    if (v.includes('INVALID') || v.includes('NO SETUP') || v.includes('SKIP')) return 'INVALID';
    if (v.includes('LATE')) return 'LATE';
    if (v.includes('CONFIRM')) return 'CONFIRMED';
    if (v.includes('FORM') || v.includes('EARLY') || v.includes('SETUP')) return 'FORMING';
    if (v.includes('WATCH') || upper(result && result.decision) === 'WAIT') return 'WATCH';
    return 'WATCH';
}

function extractLayers(result) {
    return result && result.multiTimeframe && result.multiTimeframe.layers
        ? result.multiTimeframe.layers
        : {};
}

function normalizeTfAlignment(result) {
    const layers = extractLayers(result);
    const context = upper(layers.context && layers.context.direction);
    const setup = upper(layers.setup && layers.setup.direction);
    const entry = upper(layers.entry && layers.entry.direction);

    if (result && result.diagnostics && typeof result.diagnostics.contextSetupAligned === 'boolean') {
        return result.diagnostics.contextSetupAligned ? 'ALIGNED' : 'CONFLICT';
    }
    const vals = [context, setup, entry].filter(v => v && v !== 'NEUTRAL');
    if (vals.length < 2) return 'PARTIAL';
    return vals.every(v => v === vals[0]) ? 'ALIGNED' : 'CONFLICT';
}

function normalizeVolatilityState(result) {
    return upper(
        result && (
            result.volatilityState ||
            (result.volatility && (result.volatility.state || result.volatility.status)) ||
            (result.marketRegime && result.marketRegime.volatilityState)
        ),
        'UNKNOWN'
    );
}

function normalizeSupportResistanceState(result) {
    return upper(
        result && (
            result.supportResistanceState ||
            (result.supportResistance && (
                result.supportResistance.state ||
                result.supportResistance.status ||
                result.supportResistance.nearestType
            ))
        ),
        'UNKNOWN'
    );
}

function deriveEntryTrigger(result) {
    return upper(
        result && (
            result.entryTrigger ||
            (result.candleConfirmation && result.candleConfirmation.type) ||
            (result.entryZone && result.entryZone.trigger) ||
            (result.entryEngine && result.entryEngine.trigger)
        )
    );
}

function deriveConfidence(result) {
    // Deliberately separate from signalStrength.
    const candidates = [
        result && result.confidence,
        result && result.primaryStrategy && result.primaryStrategy.confidence,
        result && result.strategyConfidence,
        result && result.diagnostics && result.diagnostics.confidence
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveSignalStrength(result) {
    const candidates = [
        result && result.signalStrength && result.signalStrength.score,
        result && result.signalStrength,
        result && result.strengthScore
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveDistanceToOptimalEntryAtr(result) {
    const ez = result && result.entryZone ? result.entryZone : {};
    const candidates = [
        result && result.distanceToOptimalEntryAtr,
        ez.distanceToBestAtr,
        ez.distanceToOptimalEntryAtr,
        ez.distanceToLastAcceptableAtr
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveLateEntryRisk(result) {
    const raw = result && (
        result.lateEntryRisk ||
        (result.entryZone && result.entryZone.lateEntryRisk) ||
        (result.signalAge && result.signalAge.status)
    );
    const v = upper(raw, 'UNKNOWN');
    if (v === 'STALE' || v === 'LATE' || v.includes('TOO LATE')) return 'HIGH';
    if (v === 'ACTIVE') return 'MEDIUM';
    if (v === 'FRESH') return 'LOW';
    if (['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'].includes(v)) return v;
    return 'UNKNOWN';
}

function deriveInvalidationLevel(result) {
    const candidates = [
        result && result.invalidationLevel,
        result && result.entryZone && result.entryZone.invalidationLevel,
        result && result.stopLevel,
        result && result.structure && result.structure.invalidationLevel
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveMarketDataTimestamp(result, meta) {
    const raw =
        (meta && meta.marketDataTimestamp) ||
        (result && result.marketDataTimestamp) ||
        (result && result.signalAge && result.signalAge.marketDataTimestamp) ||
        (result && result.latestCandleTimestamp) ||
        null;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function deriveWatchPrice(result) {
    const candidates = [
        result && result.watchPrice,
        result && result.referencePrice,
        result && result.currentPrice,
        result && result.price
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveEntryPrice(result) {
    const candidates = [
        result && result.entryPrice,
        result && result.currentPrice,
        result && result.price,
        result && result.watchPrice,
        result && result.referencePrice
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null) return n;
    }
    return null;
}

function deriveExpirationMinutes(result) {
    const candidates = [
        result && result.recommendedExpiration,
        result && result.expirationMinutes
    ];
    for (const v of candidates) {
        const n = safeNum(v);
        if (n !== null && n > 0) return n;
    }
    return null;
}

function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((acc, key) => {
        const v = value[key];
        if (v !== undefined) acc[key] = stableObject(v);
        return acc;
    }, {});
}

function sha256Json(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(stableObject(value)))
        .digest('hex');
}

function createAnalysisId(symbol, createdAtMs, batchId) {
    const normalized = String(symbol || 'UNKNOWN').replace('/', '');
    return `${normalized}-${batchId || 'BATCH'}-${createdAtMs}-${crypto.randomBytes(4).toString('hex')}`;
}

function loadAuditHistory() {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return [];
        const text = fs.readFileSync(AUDIT_FILE, 'utf8');
        if (!text.trim()) return [];
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error('[ANALYSIS AUDIT] Load error:', error.message);
        return [];
    }
}

function saveAuditHistory(history) {
    try {
        const tmp = `${AUDIT_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
        fs.renameSync(tmp, AUDIT_FILE);
        return true;
    } catch (error) {
        console.error('[ANALYSIS AUDIT] Save error:', error.message);
        return false;
    }
}

function buildLockedPrediction(result, meta = {}) {
    const now = Date.now();
    const createdAtMs = safeNum(meta.analysisCreatedAtMs) || now;
    const batchId = meta.batchId || result.batchId || `BATCH-${new Date(createdAtMs).toISOString()}`;

    const upScore = safeNum(result.upScore) || 0;
    const downScore = safeNum(result.downScore) || 0;
    const decision = normalizeDecision(result);
    const rawDecision = upper(result.decision || result.action, null);
    const expirationMinutes = deriveExpirationMinutes(result);
    const suppliedExpiryAt = result.expirationAt || meta.expiryTargetAt || null;
    const suppliedExpiryAtMs = safeNum(result.expirationAtMs);
    let expiryTargetAt = null;

    if (suppliedExpiryAtMs !== null) {
        expiryTargetAt = new Date(suppliedExpiryAtMs).toISOString();
    } else if (suppliedExpiryAt) {
        const parsed = Date.parse(suppliedExpiryAt);
        expiryTargetAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    } else if (expirationMinutes !== null) {
        expiryTargetAt = new Date(createdAtMs + expirationMinutes * 60 * 1000).toISOString();
    }

    const fvgPresent = Boolean(
        result.fvgPresent ||
        (result.entryZone && (result.entryZone.fvgId || result.entryZone.timeframe)) ||
        result.fvg
    );

    const snapshot = {
        analysisId: result.analysisId || createAnalysisId(result.symbol, createdAtMs, batchId),
        batchId,
        method: METHOD,
        marketType: MARKET_TYPE,
        rulesVersion: meta.rulesVersion || result.rulesVersion || RULES_VERSION,
        algorithmVersion: meta.algorithmVersion || result.algorithmVersion || ALGORITHM_VERSION,
        dataSchemaVersion: meta.dataSchemaVersion || DATA_SCHEMA_VERSION,

        symbol: result.symbol || null,

        // Standardized prediction snapshot.
        decision,
        rawDecision,
        marketBias: normalizeMarketBias(result.marketBias),
        marketRegime: normalizeMarketRegime(
            result.marketRegime && typeof result.marketRegime === 'object'
                ? result.marketRegime.regime
                : result.marketRegime
        ),
        signalStage: normalizeSignalStage(result.signalStage, result),
        upScore,
        downScore,
        directionMargin: Math.abs(upScore - downScore),
        signalStrength: deriveSignalStrength(result),
        confidence: deriveConfidence(result),
        tfAlignment: normalizeTfAlignment(result),
        strategy:
            (result.primaryStrategy && result.primaryStrategy.name) ||
            result.strategy ||
            null,
        entryScore:
            safeNum(result.entryZone && result.entryZone.currentEntryScore) ??
            safeNum(result.entryScore),
        entryQuality:
            upper(
                result.entryZone && (
                    result.entryZone.currentEntryQuality ||
                    result.entryZone.status
                ) || result.entryQuality
            ),
        entryTrigger: deriveEntryTrigger(result),
        candleConfirmed:
            result.candleConfirmation
                ? safeBool(result.candleConfirmation.confirmed)
                : safeBool(result.candleConfirmed),
        contextSetupAligned:
            result.diagnostics && typeof result.diagnostics.contextSetupAligned === 'boolean'
                ? result.diagnostics.contextSetupAligned
                : null,
        volatilityState: normalizeVolatilityState(result),
        distanceToOptimalEntryAtr: deriveDistanceToOptimalEntryAtr(result),
        invalidationLevel: deriveInvalidationLevel(result),
        noTradeReason: normalizeNoTradeReason(result),
        fvgPresent,
        fvgTimeframe:
            upper(
                result.fvgTimeframe ||
                (result.entryZone && result.entryZone.timeframe) ||
                (result.fvg && result.fvg.timeframe)
            ),
        supportResistanceState: normalizeSupportResistanceState(result),
        lateEntryRisk: deriveLateEntryRisk(result),
        sessionStatus:
            upper(
                result.sessionStatus ||
                (result.pairSession && result.pairSession.status)
            ),

        analysisCreatedAt: new Date(createdAtMs).toISOString(),
        marketDataTimestamp: deriveMarketDataTimestamp(result, meta),
        dataAgeSeconds:
            safeNum(result.dataAgeSeconds) ??
            safeNum(result.signalAge && result.signalAge.seconds),
        timezone: meta.timezone || result.timezone || TIMEZONE,
        entryPrice: deriveEntryPrice(result),
        watchPrice: deriveWatchPrice(result),
        expirationMinutes,
        expiryTargetAt,

        predictionLocked: true,
        predictionLockedAt: new Date(now).toISOString(),

        // Result data is appended later, never used to rewrite the prediction.
        results: {},

        // Keep a compact immutable provenance fingerprint.
        inputDataId: meta.inputDataId || result.inputDataId || null,
        snapshotHash: null,
        originalFeatureSnapshot: meta.featureSnapshot || result.featureSnapshot || null
    };

    // Hash excludes mutable results and the hash field itself.
    const hashable = { ...snapshot, results: {}, snapshotHash: null };
    snapshot.snapshotHash = sha256Json(hashable);

    return snapshot;
}

function logCheckedAnalysis(result, meta = {}) {
    if (!result || !result.symbol) return null;

    const history = loadAuditHistory();
    const record = buildLockedPrediction(result, meta);

    // analysisId must be unique and immutable.
    if (history.some(x => x.analysisId === record.analysisId)) {
        return history.find(x => x.analysisId === record.analysisId);
    }

    history.push(record);
    if (!saveAuditHistory(history)) return null;

    console.log(
        '[ANALYSIS AUDIT]',
        'Locked',
        record.analysisId,
        record.symbol,
        record.decision,
        '| score',
        record.upScore,
        '/',
        record.downScore,
        '| batch',
        record.batchId
    );
    return record;
}

function parseCandleOpenMs(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
        ? raw
        : raw.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// IMPORTANT: never choose a candle that closed BEFORE targetTime.
// For 1m candles we use the first known candle close AT OR AFTER target.
function historicalCloseAtOrAfter(candles, targetMs) {
    if (!Array.isArray(candles) || !Number.isFinite(Number(targetMs))) return null;

    let best = null;
    for (const candle of candles) {
        const openMs = parseCandleOpenMs(candle && candle.datetime);
        const close = safeNum(candle && candle.close);
        if (!Number.isFinite(openMs) || close === null) continue;

        const closeMs = openMs + 60 * 1000;
        if (closeMs < targetMs) continue;

        if (!best || closeMs < best.closeMs) {
            best = {
                price: close,
                closeMs,
                datetime: candle.datetime
            };
        }
    }
    return best;
}

function classifyOutcome(direction, startPrice, observedPrice) {
    const start = safeNum(startPrice);
    const current = safeNum(observedPrice);
    if (start === null || current === null || start <= 0) return 'INCOMPLETE';
    const rawBps = ((current - start) / start) * 10000;
    if (Math.abs(rawBps) <= OUTCOME_FLAT_BPS) return 'FLAT';
    if (direction === 'UP') return rawBps > 0 ? 'WIN' : 'LOSS';
    if (direction === 'DOWN') return rawBps < 0 ? 'WIN' : 'LOSS';
    return 'NOT_APPLICABLE';
}

function buildResultSlot(record, minutes, pricePoint, liveFallback, liveObservedAtMs, tracking = {}) {
    const createdAtMs = Date.parse(record.analysisCreatedAt);
    const targetMs = createdAtMs + Number(minutes) * 60 * 1000;

    let observedPrice = null;
    let observedMs = null;
    let priceSource = null;
    let approximate = false;
    let invalidReason = null;

    if (pricePoint) {
        observedPrice = safeNum(pricePoint.price);
        observedMs = safeNum(pricePoint.closeMs);
        priceSource = 'CLOSED_1M_AT_OR_AFTER_TARGET';
    } else if (
        safeNum(liveFallback) !== null &&
        safeNum(liveObservedAtMs) !== null &&
        Number(liveObservedAtMs) >= targetMs
    ) {
        observedPrice = Number(liveFallback);
        observedMs = Number(liveObservedAtMs);
        priceSource = 'LIVE_SAMPLE_AT_OR_AFTER_TARGET';
        approximate = true;
    } else {
        invalidReason = 'NO_PRICE_AT_OR_AFTER_TARGET';
    }

    const targetDeltaSeconds =
        observedMs === null ? null : Number(((observedMs - targetMs) / 1000).toFixed(3));

    if (targetDeltaSeconds !== null && targetDeltaSeconds > 0) {
        approximate = true;
    }

    let resultValid = observedPrice !== null && observedMs !== null;

    if (targetDeltaSeconds !== null && targetDeltaSeconds < 0) {
        // Defensive invariant: this should never happen after the selector change.
        approximate = true;
        resultValid = false;
        invalidReason = 'OBSERVED_BEFORE_TARGET';
    } else if (
        targetDeltaSeconds !== null &&
        targetDeltaSeconds > MAX_VALID_TARGET_DELTA_SECONDS
    ) {
        resultValid = false;
        invalidReason = `OBSERVATION_TOO_LATE_GT_${MAX_VALID_TARGET_DELTA_SECONDS}S`;
    }

    const direction = record.decision === 'UP' || record.decision === 'DOWN'
        ? record.decision
        : null;

    const startPrice = safeNum(record.entryPrice) ?? safeNum(record.watchPrice);
    const rawBps =
        startPrice !== null && observedPrice !== null && startPrice > 0
            ? ((observedPrice - startPrice) / startPrice) * 10000
            : null;

    const signedBps =
        rawBps === null || !direction
            ? null
            : direction === 'UP' ? rawBps : -rawBps;

    return {
        minutes: Number(minutes),
        targetTime: new Date(targetMs).toISOString(),
        observedTime: observedMs === null ? null : new Date(observedMs).toISOString(),
        targetDeltaSeconds,
        observedPrice,
        outcome:
            resultValid && direction
                ? classifyOutcome(direction, startPrice, observedPrice)
                : direction ? 'INVALID' : 'NOT_APPLICABLE',
        moveBps: rawBps === null ? null : Number(Math.abs(rawBps).toFixed(3)),
        signedMoveBps: signedBps === null ? null : Number(signedBps.toFixed(3)),
        mfeBps: safeNum(tracking.mfeBps),
        maeBps: safeNum(tracking.maeBps),
        samplesCount: safeNum(tracking.samples) || 0,
        priceSource,
        approximate,
        resultValid,
        invalidReason
    };
}

function updateAuditOutcomesForSymbol(
    symbol,
    currentPrice,
    observedAtMs = Date.now(),
    options = {}
) {
    const price = safeNum(currentPrice);
    const nowMs = safeNum(observedAtMs);
    if (!symbol || nowMs === null) return [];

    const history = loadAuditHistory();
    const changed = [];

    for (const record of history) {
        if (record.symbol !== symbol) continue;
        if (!record.predictionLocked) continue;

        const createdAtMs = Date.parse(record.analysisCreatedAt);
        if (!Number.isFinite(createdAtMs)) continue;

        for (const minutes of FIXED_HORIZONS_MINUTES) {
            const key = `${minutes}m`;
            if (record.results && record.results[key]) continue;

            const targetMs = createdAtMs + minutes * 60 * 1000;
            if (nowMs < targetMs) continue;

            record.results = record.results || {};

            // First close AT or AFTER target; never a close before target.
            const exactOrAfter = historicalCloseAtOrAfter(options.candles, targetMs);

            record.results[key] = buildResultSlot(
                record,
                minutes,
                exactOrAfter,
                price,
                nowMs,
                options.outcomeTracking || {}
            );

            changed.push(record);
        }
    }

    if (changed.length) saveAuditHistory(history);
    return changed;
}

function getAuditHistory() {
    return loadAuditHistory();
}

function getPendingAuditSymbols() {
    const now = Date.now();
    return Array.from(new Set(
        loadAuditHistory()
            .filter(record => {
                const createdAtMs = Date.parse(record.analysisCreatedAt);
                if (!Number.isFinite(createdAtMs)) return false;
                return FIXED_HORIZONS_MINUTES.some(minutes => {
                    const key = `${minutes}m`;
                    return !record.results || !record.results[key] ||
                        (createdAtMs + minutes * 60 * 1000 > now);
                });
            })
            .map(record => record.symbol)
            .filter(Boolean)
    ));
}

module.exports = {
    FIXED_HORIZONS_MINUTES,
    MAX_VALID_TARGET_DELTA_SECONDS,
    buildLockedPrediction,
    logCheckedAnalysis,
    updateAuditOutcomesForSymbol,
    getAuditHistory,
    getPendingAuditSymbols,
    historicalCloseAtOrAfter,
    classifyOutcome
};
