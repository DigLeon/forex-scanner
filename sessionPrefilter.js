const { aggregateCandles, parseUtcDateTime } = require('./utils');
const { ema, atr } = require('./indicators');
const { SESSION_PREFILTER } = require('./config');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function fullyClosedAggregates(candles, minutes) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const valid = candles
        .map(c => ({ candle: c, date: parseUtcDateTime(c && c.datetime) }))
        .filter(x => x.date)
        .sort((a, b) => b.date.getTime() - a.date.getTime());
    if (!valid.length) return [];

    // Each source candle is already a closed 1M candle. knownThrough is
    // therefore one minute after the newest source candle opened.
    const knownThroughMs = valid[0].date.getTime() + 60 * 1000;
    const bucketMs = minutes * 60 * 1000;

    return aggregateCandles(candles, minutes).filter(c => {
        const start = parseUtcDateTime(c && c.datetime);
        return start && start.getTime() + bucketMs <= knownThroughMs;
    });
}

function closes(candles) {
    return candles.map(c => Number(c.close)).filter(Number.isFinite);
}

function trendComponent(candles, weight, fastPeriod, slowPeriod) {
    const values = closes(candles);
    if (values.length < slowPeriod + 3) return { score: 0, direction: 'NEUTRAL' };
    const fast = ema(values, fastPeriod);
    const slow = ema(values, slowPeriod);
    const last = values[values.length - 1];
    if (![fast, slow, last].every(Number.isFinite) || last === 0) {
        return { score: 0, direction: 'NEUTRAL' };
    }

    const separationPct = Math.abs(fast - slow) / Math.abs(last) * 100;
    const strength = clamp(separationPct / 0.12, 0, 1);
    const direction = fast > slow ? 'BULLISH' : fast < slow ? 'BEARISH' : 'NEUTRAL';
    // A weak but coherent trend still receives half credit; stronger EMA
    // separation earns the rest. This is a ranking aid, not a trade signal.
    return { score: weight * (0.5 + 0.5 * strength), direction };
}

function momentumComponent(candles, weight) {
    const values = closes(candles);
    if (values.length < 22) return { score: 0, direction: 'NEUTRAL' };
    const fast = ema(values, 9);
    const slow = ema(values, 21);
    const last = values[values.length - 1];
    const prior = values[values.length - 4];
    if (![fast, slow, last, prior].every(Number.isFinite) || last === 0 || prior === 0) {
        return { score: 0, direction: 'NEUTRAL' };
    }
    const emaDir = fast > slow ? 1 : fast < slow ? -1 : 0;
    const moveDir = last > prior ? 1 : last < prior ? -1 : 0;
    const aligned = emaDir !== 0 && emaDir === moveDir;
    const movePct = Math.abs(last - prior) / Math.abs(prior) * 100;
    const activity = clamp(movePct / 0.08, 0, 1);
    return {
        score: weight * (aligned ? (0.6 + 0.4 * activity) : (0.25 + 0.25 * activity)),
        direction: emaDir > 0 ? 'BULLISH' : emaDir < 0 ? 'BEARISH' : 'NEUTRAL'
    };
}

function volatilityComponent(candles, weight) {
    if (!Array.isArray(candles) || candles.length < 30) return 0;
    const recent = candles.slice(-80);
    const value = atr(recent, 14);
    const last = Number(recent[recent.length - 1] && recent[recent.length - 1].close);
    if (!Number.isFinite(value) || !Number.isFinite(last) || last === 0) return 0;
    const atrPct = value / Math.abs(last) * 100;
    // Reward usable movement, but do not give extra credit indefinitely to
    // extreme volatility. 0.03%-0.12% per 5M candle maps into the useful band.
    const activity = clamp((atrPct - 0.02) / 0.10, 0, 1);
    return weight * activity;
}

function scorePrefilterPair(symbol, closed1mCandles, sessionScore, maxSessionScore) {
    const weights = SESSION_PREFILTER.weights;
    const c30 = fullyClosedAggregates(closed1mCandles, 30);
    const c15 = fullyClosedAggregates(closed1mCandles, 15);
    const c5 = fullyClosedAggregates(closed1mCandles, 5);

    const context = trendComponent(c30, weights.context30m, 20, 50);
    const setup = trendComponent(c15, weights.setup15m, 9, 21);
    const momentum = momentumComponent(c5, weights.momentum5m);
    const volatility = volatilityComponent(c5, weights.volatility);
    const session = maxSessionScore > 0 ?
        weights.session * clamp(Number(sessionScore || 0) / maxSessionScore, 0, 1) : 0;

    // Small alignment penalty only affects selection priority. It does not
    // block a pair and never changes the main signal score.
    let alignmentPenalty = 0;
    if (context.direction !== 'NEUTRAL' && setup.direction !== 'NEUTRAL' &&
        context.direction !== setup.direction) {
        alignmentPenalty = 8;
    }

    const score = clamp(
        context.score + setup.score + momentum.score + volatility + session - alignmentPenalty,
        0,
        100
    );

    return {
        symbol,
        prefilterScore: Math.round(score),
        components: {
            context30m: Math.round(context.score),
            setup15m: Math.round(setup.score),
            momentum5m: Math.round(momentum.score),
            volatility: Math.round(volatility),
            session: Math.round(session),
            alignmentPenalty
        },
        directions: {
            context30m: context.direction,
            setup15m: setup.direction,
            momentum5m: momentum.direction
        }
    };
}

function selectActivePairs(scored, fallbackSymbols = []) {
    const ranked = [...scored].sort((a, b) =>
        b.prefilterScore - a.prefilterScore || a.symbol.localeCompare(b.symbol)
    );
    const qualified = ranked.filter(x => x.prefilterScore >= SESSION_PREFILTER.minScore);

    // Prefilter is primarily a ranking layer, not a hard gate for the whole scanner.
    // Start with viable pairs, then backfill from the best remaining scored pairs
    // until targetCount is reached. Pairs that failed data/scoring are not in ranked
    // and therefore cannot be backfilled.
    const selected = qualified.slice(0, SESSION_PREFILTER.targetCount);
    if (selected.length < SESSION_PREFILTER.targetCount) {
        const selectedSymbols = new Set(selected.map(x => x.symbol));
        for (const item of ranked) {
            if (selected.length >= SESSION_PREFILTER.targetCount) break;
            if (selectedSymbols.has(item.symbol)) continue;
            selected.push(item);
            selectedSymbols.add(item.symbol);
        }
    }

    // If the prefilter itself could not score anything (for example data failure),
    // preserve availability by falling back to the existing session ranking.
    if (!selected.length && !ranked.length) {
        return {
            selectedSymbols: fallbackSymbols.slice(0, SESSION_PREFILTER.targetCount),
            ranked,
            qualifiedCount: 0,
            fallbackUsed: true
        };
    }

    return {
        selectedSymbols: selected.map(x => x.symbol),
        ranked,
        qualifiedCount: qualified.length,
        fallbackUsed: false
    };
}

module.exports = {
    fullyClosedAggregates,
    scorePrefilterPair,
    selectActivePairs
};
