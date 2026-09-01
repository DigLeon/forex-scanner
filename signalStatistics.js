'use strict';

const { getSignalHistory } = require('./signalLogger');

function normalizeOutcome(value) {
    const result = String(value || '').toUpperCase();
    if (result === 'FLAT') return 'DRAW';
    if (result === 'WIN' || result === 'LOSS' || result === 'DRAW') return result;
    return null;
}

function summarize(records, resultGetter = item => item.result) {
    let wins = 0;
    let losses = 0;
    let draws = 0;

    for (const record of records) {
        const result = normalizeOutcome(resultGetter(record));
        if (result === 'WIN') wins++;
        else if (result === 'LOSS') losses++;
        else if (result === 'DRAW') draws++;
    }

    const decided = wins + losses;

    return {
        total: wins + losses + draws,
        wins,
        losses,
        draws,
        winRate: decided
            ? Number((wins / decided * 100).toFixed(1))
            : 0
    };
}

function group(records, keyFn) {
    const map = new Map();

    for (const record of records) {
        const key = String(keyFn(record) ?? 'UNKNOWN');
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(record);
    }

    return Object.fromEntries(
        Array.from(map.entries()).map(([key, rows]) => [key, summarize(rows)])
    );
}

function scoreBand(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 'UNKNOWN';
    if (n < 52) return '<52';
    if (n <= 59) return '52-59';
    if (n <= 69) return '60-69';
    if (n <= 79) return '70-79';
    if (n <= 89) return '80-89';
    return '90+';
}

function confirmationType(record) {
    if (record.confirmationType) return record.confirmationType;
    if (record.candleConfirmed === true && record.fvgId) return 'CANDLE+FVG';
    if (record.candleConfirmed === true) return 'CANDLE';
    if (record.fvgId) return 'FVG';
    return 'UNKNOWN';
}

function buildHorizonStats(records) {
    const buckets = new Map();

    for (const record of records) {
        const rr = record.researchResults || {};

        for (const [key, value] of Object.entries(rr)) {
            const outcome = normalizeOutcome(value && (value.outcome || value.result));
            if (!outcome) continue;

            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push({ result: outcome });
        }
    }

    return Object.fromEntries(
        Array.from(buckets.entries()).map(([key, rows]) => [
            key,
            summarize(rows)
        ])
    );
}

function getSignalPerformanceStatistics(limit = 10000) {
    const history = getSignalHistory(limit);
    const trades = history.filter(item =>
        String(item.decision || 'TRADE').toUpperCase() === 'TRADE'
    );
    const waitAtOrAbove50 = history.filter(item =>
        String(item.decision || '').toUpperCase() === 'WAIT' && Number(item.score) >= 50
    );
    const waitAbove60 = history.filter(item =>
        String(item.decision || '').toUpperCase() === 'WAIT' && Number(item.score) > 60
    );

    const completed = trades.filter(item => normalizeOutcome(item.result));
    const waitCompleted = waitAtOrAbove50.filter(item => normalizeOutcome(item.result));
    const waitPending = waitAtOrAbove50.filter(item =>
        String(item.status || '').toUpperCase() === 'PENDING'
    ).length;
    const pending = trades.filter(item =>
        String(item.status || '').toUpperCase() === 'PENDING'
    ).length;

    return {
        generatedAt: new Date().toISOString(),
        sampleTarget: {
            minimum: 100,
            preferred: 200,
            currentCompleted: completed.length,
            remainingTo100: Math.max(0, 100 - completed.length),
            remainingTo200: Math.max(0, 200 - completed.length)
        },
        overall: {
            ...summarize(completed),
            pending,
            loggedTrades: trades.length
        },
        byPair: group(completed, item => item.symbol || item.pair),
        byScore: group(completed, item => scoreBand(item.score)),
        byConfirmation: group(completed, confirmationType),
        byStrategy: group(completed, item => item.strategy || 'UNKNOWN'),
        bySession: group(
            completed,
            item => item.sessionStatus || item.sessionQuality || 'UNKNOWN'
        ),
        byRecommendedExpiration: group(
            completed,
            item => Number.isFinite(Number(item.expirationMinutes))
                ? `${Number(item.expirationMinutes)}m`
                : 'UNKNOWN'
        ),
        byResearchHorizon: buildHorizonStats(trades),
        waitAtOrAbove50: {
            thresholdRule: 'score >= 50',
            ...summarize(waitCompleted),
            pending: waitPending,
            loggedWaits: waitAtOrAbove50.length,
            byPair: group(waitCompleted, item => item.symbol || item.pair),
            byScore: group(waitCompleted, item => scoreBand(item.score)),
            byConfirmation: group(waitCompleted, confirmationType),
            byRecommendedExpiration: group(
                waitCompleted,
                item => Number.isFinite(Number(item.expirationMinutes))
                    ? `${Number(item.expirationMinutes)}m`
                    : 'UNKNOWN'
            ),
            byResearchHorizon: buildHorizonStats(waitAtOrAbove50)
        },
        waitAbove60: {
            thresholdRule: 'score > 60',
            ...summarize(waitAbove60.filter(item => normalizeOutcome(item.result))),
            loggedWaits: waitAbove60.length,
            byResearchHorizon: buildHorizonStats(waitAbove60)
        }
    };
}

module.exports = {
    getSignalPerformanceStatistics,
    normalizeOutcome
};
