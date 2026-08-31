'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    aggregateCandles,
    toChronological
} = require('./utils');

const { detectImbalances, makeCanonicalFvgId } = require('./smc');

const STATE_FILE = path.join(__dirname, 'fvg-birth-state.json');
const HISTORY_FILE = path.join(__dirname, 'fvg-birth-history.jsonl');

let state = {};

try {
    if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    }
} catch (error) {
    console.warn('[FVG BIRTH STATE LOAD]', error.message);
    state = {};
}

function normalizeDatetime(value) {
    if (!value) {
        return null;
    }

    return String(value)
        .trim()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 19);
}

function makeZoneId(symbol, direction, timeframe, formationDatetime) {
    const canonicalId = makeCanonicalFvgId(symbol, direction, timeframe, formationDatetime);
    if (canonicalId) return canonicalId;

    const key = [
        String(symbol || '').toUpperCase(),
        String(direction || '').toUpperCase(),
        String(timeframe || '').toUpperCase(),
        normalizeDatetime(formationDatetime) || ''
    ].join('|');
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    return `${String(symbol || '').toUpperCase().replace('/', '')}-${String(direction || '').toUpperCase()}-${String(timeframe || '').toUpperCase()}-${hash}`;
}

function appendHistory(event) {
    try {
        fs.appendFileSync(HISTORY_FILE, JSON.stringify(event) + '\n');
    } catch (error) {
        console.warn('[FVG BIRTH HISTORY WRITE]', error.message);
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
        console.warn('[FVG BIRTH STATE WRITE]', error.message);
    }
}

function normalizeImbalanceDirection(item) {
    const type = String(item && (item.type || item.direction) || '').toUpperCase();

    if (type.includes('BULL') || type === 'UP') {
        return 'UP';
    }

    if (type.includes('BEAR') || type === 'DOWN') {
        return 'DOWN';
    }

    return null;
}

function extractFvgs(candles, timeframe, symbol) {
    if (!Array.isArray(candles) || candles.length < 3) {
        return [];
    }

    let detected = null;

    try {
        detected = detectImbalances(candles, 120, { symbol, timeframe }) || null;
    } catch (error) {
        console.warn('[FVG BIRTH DETECT]', timeframe, error.message);
        return [];
    }

    const imbalances = detected && !Array.isArray(detected) ?
        [
            ...(Array.isArray(detected.bullish) ? detected.bullish : []),
            ...(Array.isArray(detected.bearish) ? detected.bearish : [])
        ] :
        (Array.isArray(detected) ? detected : []);

    return imbalances
        .map(item => {
            const direction = normalizeImbalanceDirection(item);
            const zoneLow = Number(item.zoneLow);
            const zoneHigh = Number(item.zoneHigh);
            const formationDatetime = item.datetime || null;

            if (!direction || !formationDatetime || !Number.isFinite(zoneLow) || !Number.isFinite(zoneHigh)) {
                return null;
            }

            return {
                fvgId: item.fvgId || makeZoneId(
                    symbol,
                    direction,
                    timeframe,
                    formationDatetime
                ),
                direction,
                timeframe,
                formationDatetime: normalizeDatetime(formationDatetime),
                formationIndex: Number.isFinite(Number(item.createdIndex)) ? Number(item.createdIndex) : null,
                zoneLow,
                zoneHigh,
                bestEntryPrice: (zoneLow + zoneHigh) / 2,
                size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
                atrRatio: Number.isFinite(Number(item.atrRatio)) ? Number(item.atrRatio) : null,
                status: item.status || null,
                filled: item.filled === true,
                touchCount: Number.isFinite(Number(item.touchCount)) ? Number(item.touchCount) : 0
            };
        })
        .filter(Boolean);
}

function scanFvgBirths(symbol, oneMinuteCandles) {
    const candles1M = Array.isArray(oneMinuteCandles) ? oneMinuteCandles : [];
    const frames = [
        ['1M', toChronological(candles1M)],
        ['3M', aggregateCandles(candles1M, 3)],
        ['5M', aggregateCandles(candles1M, 5)],
        ['15M', aggregateCandles(candles1M, 15)],
        ['30M', aggregateCandles(candles1M, 30)],
        ['1H', aggregateCandles(candles1M, 60)]
    ];

    const ordered1M = toChronological(candles1M);
    const currentPrice = ordered1M.length ? Number(ordered1M[ordered1M.length - 1].close) : null;
    const now = new Date().toISOString();
    const discovered = [];

    for (const [timeframe, candles] of frames) {
        const fvgs = extractFvgs(candles, timeframe, symbol);

        for (const fvg of fvgs) {
            const zoneId = fvg.fvgId || makeZoneId(
                symbol,
                fvg.direction,
                timeframe,
                fvg.formationDatetime
            );

            if (!state[zoneId]) {
                state[zoneId] = {
                    zoneId,
                    symbol,
                    direction: fvg.direction,
                    timeframe,
                    formationDatetime: fvg.formationDatetime,
                    formationIndex: fvg.formationIndex,
                    zoneLow: fvg.zoneLow,
                    zoneHigh: fvg.zoneHigh,
                    bestEntryPrice: fvg.bestEntryPrice,
                    firstSeenAt: now,
                    firstSeenPrice: currentPrice,
                    detectedAfterFormationSeconds:
                        (() => {
                            const formedMs = Date.parse(
                                String(fvg.formationDatetime).replace(' ', 'T') + 'Z'
                            );
                            const seenMs = Date.parse(now);
                            return Number.isFinite(formedMs) && Number.isFinite(seenMs) ?
                                Math.max(0, Math.round((seenMs - formedMs) / 1000)) :
                                null;
                        })(),
                    lastSeenAt: now,
                    lastSeenPrice: currentPrice,
                    scoreAtFirstAnalysis: null,
                    signalStageAtFirstAnalysis: null,
                    latestScore: null,
                    latestSignalStage: null,
                    latestLifecycleState: null,
                    linkedEntryZoneId: null
                };

                discovered.push(state[zoneId]);

                appendHistory({
                    timestamp: now,
                    event: 'FVG_BORN',
                    ...state[zoneId]
                });
            } else {
                state[zoneId].lastSeenAt = now;
                state[zoneId].lastSeenPrice = currentPrice;
            }
        }
    }

    saveState();
    return discovered;
}

function updateFvgBirthWithAnalysis(symbol, analysis) {
    if (!analysis || !analysis.entryZoneLifecycle) {
        return null;
    }

    const lifecycle = analysis.entryZoneLifecycle;

    if (!lifecycle.direction || !lifecycle.timeframe || !lifecycle.formationDatetime) {
        return null;
    }

    const zoneId = makeZoneId(
        symbol,
        lifecycle.direction,
        lifecycle.timeframe,
        lifecycle.formationDatetime
    );

    const record = state[zoneId];

    if (!record) {
        return null;
    }

    const score = Number(lifecycle.score);
    const normalizedScore = Number.isFinite(score) ? score : null;
    const signalStage = analysis.signalDiagnostics && analysis.signalDiagnostics.signalStage ?
        analysis.signalDiagnostics.signalStage :
        null;
    const lifecycleState = lifecycle.state || null;

    if (record.scoreAtFirstAnalysis === null && normalizedScore !== null) {
        record.scoreAtFirstAnalysis = normalizedScore;
        record.signalStageAtFirstAnalysis = signalStage;
    }

    const changed =
        record.latestScore !== normalizedScore ||
        record.latestSignalStage !== signalStage ||
        record.latestLifecycleState !== lifecycleState;

    record.latestScore = normalizedScore;
    record.latestSignalStage = signalStage;
    record.latestLifecycleState = lifecycleState;
    record.lastAnalysisAt = new Date().toISOString();
    record.lastSeenPrice = lifecycle.currentPrice !== undefined ? lifecycle.currentPrice : record.lastSeenPrice;

    if (analysis.entryZoneHistory && analysis.entryZoneHistory.zoneId) {
        record.linkedEntryZoneId = analysis.entryZoneHistory.zoneId;
    }

    if (changed) {
        appendHistory({
            timestamp: new Date().toISOString(),
            event: 'FVG_ANALYSIS_UPDATE',
            zoneId,
            symbol,
            score: normalizedScore,
            signalStage,
            lifecycleState,
            currentPrice: lifecycle.currentPrice !== undefined ? lifecycle.currentPrice : null,
            linkedEntryZoneId: record.linkedEntryZoneId
        });
    }

    saveState();
    return record;
}

function getFvgBirths({ symbol = null, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));

    return Object.values(state)
        .filter(item => !symbol || item.symbol === symbol)
        .sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)))
        .slice(0, normalizedLimit);
}

function getFvgBirthHistory({ symbol = null, zoneId = null, limit = 100 } = {}) {
    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }

    let lines = [];

    try {
        lines = fs.readFileSync(HISTORY_FILE, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (error) {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (error) {
        console.warn('[FVG BIRTH HISTORY READ]', error.message);
        return [];
    }

    return lines
        .filter(item => !symbol || item.symbol === symbol)
        .filter(item => !zoneId || item.zoneId === zoneId)
        .slice(-Math.max(1, Math.min(Number(limit) || 100, 5000)));
}

function clearFvgBirthHistory() {
    state = {};
    saveState();

    try {
        fs.writeFileSync(HISTORY_FILE, '');
    } catch (error) {
        console.warn('[FVG BIRTH HISTORY CLEAR]', error.message);
    }

    return { status: 'ok' };
}

module.exports = {
    scanFvgBirths,
    updateFvgBirthWithAnalysis,
    getFvgBirths,
    getFvgBirthHistory,
    clearFvgBirthHistory
};
