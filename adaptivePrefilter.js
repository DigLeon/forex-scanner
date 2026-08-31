'use strict';

const {
    aggregateCandles,
    toChronological,
    clamp,
    round
} = require('./utils');

const {
    atr
} = require('./indicators');

function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function average(values) {
    if (!Array.isArray(values) || !values.length) {
        return 0;
    }

    return values.reduce((sum, value) => sum + number(value), 0) / values.length;
}

function getLast(candles, count) {
    const ordered = toChronological(candles || []);
    return ordered.slice(Math.max(0, ordered.length - count));
}

function score30MContext(candles30M) {
    const recent = getLast(candles30M, 8);

    if (recent.length < 5) {
        return {
            score: 0,
            direction: 'NEUTRAL'
        };
    }

    const firstClose = number(recent[0].close);
    const lastClose = number(recent[recent.length - 1].close);
    const avgRange = average(
        recent.map(candle =>
            Math.max(
                0.00000001,
                number(candle.high) - number(candle.low)
            )
        )
    );

    const move = lastClose - firstClose;
    const normalizedMove = Math.abs(move) / Math.max(avgRange, 0.00000001);

    return {
        score: round(clamp(normalizedMove * 8, 0, 30), 1),
        direction: move > 0 ? 'UP' : move < 0 ? 'DOWN' : 'NEUTRAL'
    };
}

function score15MSetupActivity(candles15M) {
    const recent = getLast(candles15M, 6);

    if (recent.length < 4) {
        return 0;
    }

    let bodyRatioSum = 0;
    let directionalPersistence = 0;

    for (const candle of recent) {
        const open = number(candle.open);
        const close = number(candle.close);
        const range = Math.max(
            0.00000001,
            number(candle.high) - number(candle.low)
        );

        bodyRatioSum += Math.abs(close - open) / range;
        directionalPersistence += Math.sign(close - open);
    }

    const bodyScore = clamp(
        (bodyRatioSum / recent.length) * 16,
        0,
        16
    );

    const persistenceScore = clamp(
        (Math.abs(directionalPersistence) / recent.length) * 9,
        0,
        9
    );

    return round(bodyScore + persistenceScore, 1);
}

function score5MMomentum(candles5M) {
    const recent = getLast(candles5M, 8);

    if (recent.length < 5) {
        return 0;
    }

    const firstClose = number(recent[0].close);
    const lastClose = number(recent[recent.length - 1].close);
    const avgRange = average(
        recent.map(candle =>
            Math.max(
                0.00000001,
                number(candle.high) - number(candle.low)
            )
        )
    );

    const normalizedMove = Math.abs(lastClose - firstClose) /
        Math.max(avgRange, 0.00000001);

    return round(clamp(normalizedMove * 4.5, 0, 20), 1);
}

function scoreVolatility(candles5M) {
    const ordered = toChronological(candles5M || []);

    if (ordered.length < 30) {
        return 0;
    }

    const currentAtr = atr(ordered, 14);
    const recent = ordered.slice(-30);
    const baselineRange = average(
        recent.map(candle =>
            Math.max(
                0.00000001,
                number(candle.high) - number(candle.low)
            )
        )
    );

    if (!Number.isFinite(currentAtr) || currentAtr <= 0 || baselineRange <= 0) {
        return 0;
    }

    // Normal/healthy movement ranks best; very low volatility is de-prioritized.
    const ratio = currentAtr / baselineRange;
    return round(clamp((ratio - 0.45) * 18, 0, 15), 1);
}

function detectFreshFvgOpportunity(candles5M, candles15M, currentPrice) {
    const inputs = [
        { timeframe: '5M', candles: toChronological(candles5M || []) },
        { timeframe: '15M', candles: toChronological(candles15M || []) }
    ];

    let best = null;

    for (const item of inputs) {
        const candles = item.candles;
        const start = Math.max(2, candles.length - 20);

        for (let index = start; index < candles.length; index += 1) {
            const first = candles[index - 2];
            const third = candles[index];

            const firstHigh = number(first.high);
            const firstLow = number(first.low);
            const thirdHigh = number(third.high);
            const thirdLow = number(third.low);

            let direction = null;
            let zoneLow = null;
            let zoneHigh = null;

            if (thirdLow > firstHigh) {
                direction = 'UP';
                zoneLow = firstHigh;
                zoneHigh = thirdLow;
            } else if (thirdHigh < firstLow) {
                direction = 'DOWN';
                zoneLow = thirdHigh;
                zoneHigh = firstLow;
            } else {
                continue;
            }

            const width = Math.max(0.00000001, zoneHigh - zoneLow);
            const bestEntryPrice = (zoneLow + zoneHigh) / 2;
            const distanceInZoneWidths = Math.abs(currentPrice - bestEntryPrice) / width;

            // Rank bonus only. It cannot modify the final signal score or decision.
            const proximityBonus = round(
                clamp(8 - distanceInZoneWidths * 2, 0, 8),
                1
            );

            const candidate = {
                timeframe: item.timeframe,
                direction,
                zoneLow,
                zoneHigh,
                bestEntryPrice,
                formationDatetime: third.datetime || null,
                proximityBonus
            };

            if (!best || candidate.proximityBonus > best.proximityBonus) {
                best = candidate;
            }
        }
    }

    return best;
}

function evaluateAdaptivePrefilter({
    symbol,
    oneMinuteCandles,
    sessionScore,
    maxSessionScore
}) {
    const candles1M = Array.isArray(oneMinuteCandles) ? oneMinuteCandles : [];
    const candles5M = aggregateCandles(candles1M, 5);
    const candles15M = aggregateCandles(candles1M, 15);
    const candles30M = aggregateCandles(candles1M, 30);
    const ordered1M = toChronological(candles1M);
    const currentPrice = ordered1M.length ? number(ordered1M[ordered1M.length - 1].close) : 0;

    const context = score30MContext(candles30M);
    const setupActivity = score15MSetupActivity(candles15M);
    const momentum = score5MMomentum(candles5M);
    const volatility = scoreVolatility(candles5M);
    const sessionRelevance = maxSessionScore > 0 ?
        round(clamp((number(sessionScore) / maxSessionScore) * 10, 0, 10), 1) :
        0;

    const prefilterScore = round(
        clamp(
            context.score +
            setupActivity +
            momentum +
            volatility +
            sessionRelevance,
            0,
            100
        ),
        1
    );

    const entryOpportunity = detectFreshFvgOpportunity(
        candles5M,
        candles15M,
        currentPrice
    );

    const opportunityBonus = entryOpportunity ?
        number(entryOpportunity.proximityBonus) :
        0;

    return {
        symbol,
        prefilterScore,
        priorityScore: round(prefilterScore + opportunityBonus, 1),
        opportunityBonus,
        contextDirection: context.direction,
        components: {
            context30M: context.score,
            setup15M: setupActivity,
            momentum5M: momentum,
            volatilityATR: volatility,
            sessionRelevance
        },
        entryOpportunity,
        currentPrice
    };
}

module.exports = {
    evaluateAdaptivePrefilter
};
