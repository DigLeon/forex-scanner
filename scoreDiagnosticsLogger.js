const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'score-diagnostics-history.jsonl');
const MAX_ROWS = 5000;

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function buildDiagnosticRecord(symbol, analysis) {
    const a = analysis && typeof analysis === 'object' ? analysis : {};
    const d = a.signalDiagnostics && typeof a.signalDiagnostics === 'object'
        ? a.signalDiagnostics
        : {};
    const b = a.scoreBreakdown && typeof a.scoreBreakdown === 'object'
        ? a.scoreBreakdown
        : {};
    const z = a.entryZone && typeof a.entryZone === 'object'
        ? a.entryZone
        : {};
    const s = a.signalStrength && typeof a.signalStrength === 'object'
        ? a.signalStrength
        : {};
    const c = a.candleConfirmation && typeof a.candleConfirmation === 'object'
        ? a.candleConfirmation
        : {};

    return {
        timestamp: new Date().toISOString(),
        symbol: symbol || a.symbol || null,
        price: safeNumber(a.currentPrice),

        signal: a.signal || 'NO SIGNAL',
        signalStage: a.signalStage || d.signalStage || null,
        candidateOnly: a.candidateOnly === true || d.candidateOnly === true,

        contextDirection: d.contextDirection || null,
        setupDirection: d.setupDirection || null,
        contextSetupAligned: d.contextSetupAligned === true,
        contextSetupConflict: d.contextSetupConflict === true,

        bestDirection: d.bestDirection || null,
        finalUpScore: safeNumber(a.upScore),
        finalDownScore: safeNumber(a.downScore),
        bestDirectionScore: safeNumber(d.bestDirectionScore),
        oppositeScore: safeNumber(d.oppositeScore),
        edge: safeNumber(d.actualEdge),
        requiredEdge: safeNumber(d.requiredEdge),
        requiredScore: safeNumber(d.effectiveMinScore ?? d.requiredScore),

        components: {
            selected: {
                context: safeNumber(b.context),
                setup: safeNumber(b.setup),
                entry: safeNumber(b.entry),
                strategy: safeNumber(b.strategy),
                session: safeNumber(b.session)
            },
            bullish: b.bullish || null,
            bearish: b.bearish || null
        },

        rawScore: b.rawDirectionalScores || null,
        qualityAdjustment: safeNumber(b.qualityAdjustment),
        regimePenalty: safeNumber(b.regimePenalty),

        entryZone: {
            available: z.available === true,
            status: z.status || null,
            quality: z.currentEntryQuality || null,
            bestEntryPrice: safeNumber(z.bestEntryPrice),
            lastAcceptablePrice: safeNumber(z.lastAcceptablePrice),
            worstEntryPrice: safeNumber(z.worstEntryPrice),
            distanceToBestAtr: safeNumber(z.distanceToBestAtr),
            timeframe: z.timeframe || null,
            source: z.source || null
        },

        entryZoneLifecycle:
            a.entryZoneLifecycle &&
            typeof a.entryZoneLifecycle === 'object'
                ? {
                    active: a.entryZoneLifecycle.active === true,
                    state: a.entryZoneLifecycle.state || null,
                    direction: a.entryZoneLifecycle.direction || null,
                    score: safeNumber(a.entryZoneLifecycle.score),
                    requiredScore: safeNumber(a.entryZoneLifecycle.requiredScore),
                    currentPrice: safeNumber(a.entryZoneLifecycle.currentPrice),
                    bestEntryPrice: safeNumber(a.entryZoneLifecycle.bestEntryPrice),
                    lastAcceptablePrice: safeNumber(a.entryZoneLifecycle.lastAcceptablePrice),
                    worstEntryPrice: safeNumber(a.entryZoneLifecycle.worstEntryPrice),
                    distanceToBestAtr: safeNumber(a.entryZoneLifecycle.distanceToBestAtr),
                    distanceToLastAcceptableAtr: safeNumber(a.entryZoneLifecycle.distanceToLastAcceptableAtr),
                    distanceToWorstAtr: safeNumber(a.entryZoneLifecycle.distanceToWorstAtr),
                    zoneStatus: a.entryZoneLifecycle.zoneStatus || null,
                    reason: a.entryZoneLifecycle.reason || null
                }
                : null,

        preEntryOpportunityWatch:
            a.preEntryOpportunityWatch &&
            typeof a.preEntryOpportunityWatch === 'object'
                ? {
                    active: a.preEntryOpportunityWatch.active === true,
                    direction: a.preEntryOpportunityWatch.direction || null,
                    floor: safeNumber(a.preEntryOpportunityWatch.floor),
                    ceiling: safeNumber(a.preEntryOpportunityWatch.ceiling),
                    score: safeNumber(a.preEntryOpportunityWatch.score),
                    requiredScore: safeNumber(a.preEntryOpportunityWatch.requiredScore),
                    reason: a.preEntryOpportunityWatch.reason || null,
                    entryZone: a.preEntryOpportunityWatch.entryZone || null
                }
                : null,

        entryOpportunityWatch:
            a.entryOpportunityWatch &&
            typeof a.entryOpportunityWatch === 'object'
                ? {
                    active: a.entryOpportunityWatch.active === true,
                    direction: a.entryOpportunityWatch.direction || null,
                    floor: safeNumber(a.entryOpportunityWatch.floor),
                    score: safeNumber(a.entryOpportunityWatch.score),
                    requiredScore: safeNumber(a.entryOpportunityWatch.requiredScore),
                    reason: a.entryOpportunityWatch.reason || null,
                    entryZone: a.entryOpportunityWatch.entryZone || null
                }
                : null,

        signalStrength: {
            score: safeNumber(s.score),
            level: s.level || null,
            recommendation: s.recommendation || null
        },

        candleConfirmation: {
            status: c.status || null,
            confirmed: c.confirmed === true,
            score: safeNumber(c.score),
            oppositeScore: safeNumber(c.oppositeScore)
        },

        blockers: Array.isArray(d.blockers) ? d.blockers : []
    };
}

function trimHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return;

    const text = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
    if (!text) return;

    const lines = text.split(/\r?\n/);
    if (lines.length <= MAX_ROWS) return;

    fs.writeFileSync(
        HISTORY_FILE,
        lines.slice(-MAX_ROWS).join('\n') + '\n',
        'utf8'
    );
}

function logScoreDiagnostic(symbol, analysis) {
    const record = buildDiagnosticRecord(symbol, analysis);

    fs.appendFileSync(
        HISTORY_FILE,
        JSON.stringify(record) + '\n',
        'utf8'
    );

    trimHistory();

    const selected = record.components.selected;
    const raw = record.rawScore || {};

    console.log(
        '[SCORE TRACE]',
        record.symbol,
        '| Price:', record.price,
        '| Ctx:', selected.context,
        '| Setup:', selected.setup,
        '| Entry:', selected.entry,
        '| Strat:', selected.strategy,
        '| Session:', selected.session,
        '| Raw U/D:', raw.up, '/', raw.down,
        '| Adj:', record.qualityAdjustment,
        '| Final U/D:', record.finalUpScore, '/', record.finalDownScore,
        '| Edge:', record.edge,
        '| Stage:', record.signalStage,
        '| Zone:', record.entryZone.status
    );

    return record;
}

function getScoreDiagnosticHistory(limit = 100, symbol = null) {
    if (!fs.existsSync(HISTORY_FILE)) return [];

    const text = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
    if (!text) return [];

    let rows = text
        .split(/\r?\n/)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);

    if (symbol) {
        const wanted = String(symbol).toUpperCase();
        rows = rows.filter(row => String(row.symbol || '').toUpperCase() === wanted);
    }

    return rows.slice(-Math.max(1, Math.min(Number(limit) || 100, 1000))).reverse();
}

function clearScoreDiagnosticHistory() {
    fs.writeFileSync(HISTORY_FILE, '', 'utf8');
    return { status: 'ok', cleared: true };
}

module.exports = {
    HISTORY_FILE,
    logScoreDiagnostic,
    getScoreDiagnosticHistory,
    clearScoreDiagnosticHistory
};
