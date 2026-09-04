const { analyzeTechnical, analyzeVolatility } = require('./indicators');
const { aggregateCandles, toChronological } = require('./utils');

function tech(newestFirst) {
  if (!Array.isArray(newestFirst) || newestFirst.length < 60) return null;
  return analyzeTechnical(toChronological(newestFirst), 5);
}

function biasFromTech(t) {
  if (!t) return 'NEUTRAL';
  if (Number(t.upScore) > Number(t.downScore)) return 'BULLISH';
  if (Number(t.downScore) > Number(t.upScore)) return 'BEARISH';
  return 'NEUTRAL';
}

function buildManualFallbackAnalysis(symbol, closedCandles, livePrice) {
  const one = Array.isArray(closedCandles) ? closedCandles : [];
  const tf5 = aggregateCandles(one, 5);
  const tf15 = aggregateCandles(one, 15);
  const tf30 = aggregateCandles(one, 30);
  const tf60 = aggregateCandles(one, 60);
  const t1 = tech(one), t5 = tech(tf5), t15 = tech(tf15), t30 = tech(tf30), t60 = tech(tf60);
  const available = [t1,t5,t15,t30,t60].filter(Boolean);
  if (!available.length) return null;

  const weights = [[t1,0.30],[t5,0.30],[t15,0.20],[t30,0.10],[t60,0.10]];
  let up = 0, down = 0, usedWeight = 0;
  for (const [t,w] of weights) {
    if (!t) continue;
    up += Number(t.upScore || 0) * w;
    down += Number(t.downScore || 0) * w;
    usedWeight += w;
  }
  if (usedWeight > 0) { up /= usedWeight; down /= usedWeight; }
  up = +up.toFixed(2); down = +down.toFixed(2);

  // Deterministic tie-break based on the most recent measurable momentum, never a hard-coded UP.
  let direction = up > down ? 'UP' : down > up ? 'DOWN' : null;
  if (!direction) {
    const momentum = [t1,t5,t15,t30,t60].find(x => x && Number.isFinite(Number(x.momentum)) && Number(x.momentum) !== 0);
    if (momentum) direction = Number(momentum.momentum) > 0 ? 'UP' : 'DOWN';
  }
  if (!direction) {
    const ordered = toChronological(one);
    const a = Number(ordered[ordered.length - 1]?.close), b = Number(ordered[Math.max(0, ordered.length - 2)]?.close);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) direction = a > b ? 'UP' : 'DOWN';
  }
  if (!direction) return null;

  const quality = t1 && t5 && t15 ? 'PARTIAL' : 'FALLBACK';
  const regime = analyzeVolatility(toChronological(one));
  return {
    symbol,
    signal: direction,
    bestDirection: direction,
    score: direction === 'UP' ? up : down,
    upScore: up,
    downScore: down,
    marketBias: biasFromTech(t30 || t15 || t5 || t1),
    context: biasFromTech(t60 || t30 || t15),
    setup: biasFromTech(t15 || t5 || t1),
    entry: biasFromTech(t1 || t5),
    marketRegime: regime?.regime || 'UNKNOWN',
    currentPrice: Number.isFinite(Number(livePrice)) ? Number(livePrice) : null,
    watchPrice: Number.isFinite(Number(livePrice)) ? Number(livePrice) : null,
    analysisQuality: quality,
    fallbackReason: 'CORE_ANALYSIS_UNAVAILABLE_OR_INCOMPLETE',
    researchMetadata: {
      rsi1m: t1?.rsi ?? null, rsi5m: t5?.rsi ?? null, rsi15m: t15?.rsi ?? null,
      macd5mHistogram: t5?.macdHistogram ?? null,
      fallbackTimeframes: { m1: !!t1, m5: !!t5, m15: !!t15, m30: !!t30, h1: !!t60 }
    }
  };
}

module.exports = { buildManualFallbackAnalysis };
