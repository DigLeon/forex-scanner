const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'manual-analysis-history.json');
const MAX_VALID_DELTA_SECONDS = Number(process.env.MAX_VALID_TARGET_DELTA_SECONDS) || 90;
const MANUAL_ENTRY_GOOD_DELAY_MS = Number(process.env.MANUAL_ENTRY_GOOD_DELAY_MS) || 1000;
const MANUAL_ENTRY_MAX_CLEAN_DELAY_MS = Number(process.env.MANUAL_ENTRY_MAX_CLEAN_DELAY_MS) || 2000;

function loadHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn('[MANUAL HISTORY] load failed:', error.message);
        return [];
    }
}

function saveHistory(history) {
    const tmp = `${HISTORY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, HISTORY_FILE);
}

function nextMinuteBoundary(nowMs = Date.now()) {
    return Math.floor(Number(nowMs) / 60000) * 60000 + 60000;
}

function candleOpenMs(candle) {
    const raw = candle && (candle.datetime || candle.timestamp || candle.time);
    const parsed = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function candleCloseMs(candle) {
    const parsed = candleOpenMs(candle);
    if (!Number.isFinite(parsed)) return NaN;
    return parsed + 60000;
}

function historicalCloseAtOrAfter(candles, targetMs) {
    if (!Array.isArray(candles) || !Number.isFinite(Number(targetMs))) return null;
    let best = null;
    for (const candle of candles) {
        const closeMs = candleCloseMs(candle);
        const price = Number(candle && candle.close);
        if (!Number.isFinite(closeMs) || !Number.isFinite(price) || closeMs < targetMs) continue;
        if (!best || closeMs < best.closeMs) best = { closeMs, price };
    }
    return best;
}

function classifyDataQuality(source, delayMs) {
    const src = String(source || 'UNKNOWN').toUpperCase();
    const d = Number(delayMs);
    if (!Number.isFinite(d)) return 'UNKNOWN';
    if (d <= MANUAL_ENTRY_GOOD_DELAY_MS) return src.includes('REALTIME') || src.includes('WS') ? 'WS_FRESH' : 'REST_FRESH';
    if (d <= MANUAL_ENTRY_MAX_CLEAN_DELAY_MS) return src.includes('REALTIME') || src.includes('WS') ? 'WS_OK' : 'REST_OK';
    return src.includes('REALTIME') || src.includes('WS') ? 'WS_DELAYED' : 'REST_DELAYED';
}

function classify(direction, entryPrice, finalPrice) {
    if (finalPrice === entryPrice) return 'FLAT';
    if (direction === 'UP') return finalPrice > entryPrice ? 'WIN' : 'LOSS';
    if (direction === 'DOWN') return finalPrice < entryPrice ? 'WIN' : 'LOSS';
    return 'NO_RESULT';
}

function signedMove(direction, entryPrice, price) {
    const e = Number(entryPrice), p = Number(price);
    if (!Number.isFinite(e) || !Number.isFinite(p)) return null;
    return direction === 'DOWN' ? e - p : p - e;
}

function updateExcursionFromPrice(record, price, observedAtMs) {
    if (!record || !Number.isFinite(Number(record.entryPrice)) || !Number.isFinite(Number(price))) return;
    const atMs = Number(observedAtMs);
    if (Number.isFinite(atMs) && atMs < Number(record.scheduledStartAtMs)) return;
    const move = signedMove(record.direction, record.entryPrice, price);
    if (!Number.isFinite(move)) return;
    const favorable = Math.max(0, move);
    const adverse = Math.max(0, -move);
    record.maxFavorableMove = Math.max(Number(record.maxFavorableMove) || 0, favorable);
    record.maxAdverseMove = Math.max(Number(record.maxAdverseMove) || 0, adverse);
}

function finalizeExcursionFromCandles(record, candles) {
    if (!record || !Array.isArray(candles) || !Number.isFinite(Number(record.entryPrice))) return;
    const startMs = Number(record.scheduledStartAtMs);
    const endMs = Number(record.expiryAtMs);
    let best = Number(record.maxFavorableMove) || 0;
    let worst = Number(record.maxAdverseMove) || 0;
    for (const candle of candles) {
        const openMs = candleOpenMs(candle);
        if (!Number.isFinite(openMs) || openMs < startMs || openMs >= endMs) continue;
        const high = Number(candle.high), low = Number(candle.low);
        if (Number.isFinite(high)) {
            const move = signedMove(record.direction, record.entryPrice, high);
            if (Number.isFinite(move)) { best = Math.max(best, Math.max(0, move)); worst = Math.max(worst, Math.max(0, -move)); }
        }
        if (Number.isFinite(low)) {
            const move = signedMove(record.direction, record.entryPrice, low);
            if (Number.isFinite(move)) { best = Math.max(best, Math.max(0, move)); worst = Math.max(worst, Math.max(0, -move)); }
        }
    }
    record.maxFavorableMove = +best.toFixed(8);
    record.maxAdverseMove = +worst.toFixed(8);
}

function logManualAnalysis(input = {}) {
    const direction = String(input.direction || input.signal || '').toUpperCase();
    const expirationMinutes = Number(input.expirationMinutes);
    if (!['UP', 'DOWN'].includes(direction) || ![3, 5, 15].includes(expirationMinutes)) return null;

    const nowMs = Date.now();
    const startAtMs = nextMinuteBoundary(nowMs);
    const history = loadHistory();
    const record = {
        id: `MANUAL-${String(input.symbol || '').replace(/[^A-Z]/gi, '')}-${nowMs}`,
        mode: 'MANUAL_PAPER_ANALYSIS',
        symbol: input.symbol,
        direction,
        predictionDirection: direction,
        score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
        predictionScore: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
        oppositeScore: Number.isFinite(Number(input.oppositeScore)) ? Number(input.oppositeScore) : null,
        upScore: Number.isFinite(Number(input.upScore)) ? Number(input.upScore) : null,
        downScore: Number.isFinite(Number(input.downScore)) ? Number(input.downScore) : null,
        scoreGap: Number.isFinite(Number(input.scoreGap)) ? Number(input.scoreGap) : null,
        predictionConfidence: input.predictionConfidence || null,
        analysisQuality: input.analysisQuality || 'FULL',
        analysisValid: input.analysisValid !== false,
        rawDecision: input.rawDecision || null,
        executionDecision: input.rawDecision || null,
        expirationMinutes,
        scannedAt: new Date(nowMs).toISOString(),
        scannedAtMs: nowMs,
        scanPrice: Number.isFinite(Number(input.scanPrice)) ? Number(input.scanPrice) : null,
        scanPriceSource: input.scanPriceSource || null,
        preflightDataAgeSeconds: Number.isFinite(Number(input.preflightDataAgeSeconds)) ? Number(input.preflightDataAgeSeconds) : null,
        scheduledStartAt: new Date(startAtMs).toISOString(),
        scheduledStartAtMs: startAtMs,
        entryPrice: null,
        entryObservedAt: null,
        entryDeltaSeconds: null,
        entryPriceSource: null,
        entryDataQuality: null,
        cleanSample: null,
        expiryAt: new Date(startAtMs + expirationMinutes * 60000).toISOString(),
        expiryAtMs: startAtMs + expirationMinutes * 60000,
        status: 'WAITING_ENTRY',
        result: null,
        resultPrice: null,
        resultObservedAt: null,
        resultDeltaSeconds: null,
        resultValid: null,
        invalidReason: null,
        resultPriceSource: null,
        maxFavorableMove: 0,
        maxAdverseMove: 0,
        snapshot: input.snapshot || null
    };
    history.push(record);
    saveHistory(history);
    console.log('[MANUAL PAPER]', record.symbol, record.direction, '| start:', record.scheduledStartAt, '| horizon:', `${expirationMinutes}m`);
    return record;
}

function updateManualAnalysisForSymbol(symbol, currentPrice, observedAtMs = Date.now(), options = {}) {
    const price = Number(currentPrice);
    const atMs = Number(observedAtMs);
    if (!Number.isFinite(price) || !Number.isFinite(atMs)) return [];
    const history = loadHistory();
    const updated = [];
    let changed = false;

    for (const record of history) {
        if (record.symbol !== symbol || !['WAITING_ENTRY', 'PENDING', 'WAITING_FOR_PRICE'].includes(record.status)) continue;

        if (record.status === 'WAITING_ENTRY' && atMs >= Number(record.scheduledStartAtMs)) {
            record.entryPrice = price;
            record.entryObservedAt = new Date(atMs).toISOString();
            record.entryDeltaSeconds = +((atMs - Number(record.scheduledStartAtMs)) / 1000).toFixed(3);
            record.entryPriceSource = options.source || 'UNKNOWN';
            record.entryDataQuality = classifyDataQuality(record.entryPriceSource, record.entryDeltaSeconds * 1000);
            record.cleanSample = record.entryDeltaSeconds >= 0 && record.entryDeltaSeconds <= (MANUAL_ENTRY_MAX_CLEAN_DELAY_MS / 1000);
            record.status = 'PENDING';
            record.maxFavorableMove = 0;
            record.maxAdverseMove = 0;
            changed = true;
            updated.push(record);
            console.log('[MANUAL PAPER START]', record.symbol, record.direction, '| entry:', price, '| delta:', record.entryDeltaSeconds, 's');
        }

        if (record.status === 'PENDING' && atMs < Number(record.expiryAtMs)) {
            updateExcursionFromPrice(record, price, atMs);
            changed = true;
        }

        if (!['PENDING','WAITING_FOR_PRICE'].includes(record.status) || atMs < Number(record.expiryAtMs)) continue;
        const exact = historicalCloseAtOrAfter(options.candles, Number(record.expiryAtMs));
        const resultPrice = exact ? exact.price : price;
        const resultAtMs = exact ? exact.closeMs : atMs;
        const deltaSeconds = +((resultAtMs - Number(record.expiryAtMs)) / 1000).toFixed(3);

        updateExcursionFromPrice(record, resultPrice, resultAtMs);
        finalizeExcursionFromCandles(record, options.candles);
        record.resultPrice = resultPrice;
        record.resultObservedAt = new Date(resultAtMs).toISOString();
        record.resultDeltaSeconds = deltaSeconds;
        record.resultPriceSource = exact ? 'CLOSED_1M_AT_OR_AFTER_TARGET' : (options.source || 'UNKNOWN');
        record.result = classify(record.direction, Number(record.entryPrice), resultPrice);
        record.resultValid = resultAtMs >= Number(record.expiryAtMs) && deltaSeconds <= MAX_VALID_DELTA_SECONDS;
        record.invalidReason = record.resultValid ? null : (deltaSeconds < 0 ? 'OBSERVATION_BEFORE_TARGET' : 'OBSERVATION_TOO_LATE');
        record.status = 'COMPLETED';
        changed = true;
        updated.push(record);
        console.log('[MANUAL PAPER RESULT]', record.symbol, record.direction, '|', record.result, '| valid:', record.resultValid, '| MFE:', record.maxFavorableMove, '| MAE:', record.maxAdverseMove);
    }

    if (changed) saveHistory(history);
    return updated;
}

function getManualPendingSymbols() {
    return Array.from(new Set(loadHistory().filter(x => ['WAITING_ENTRY','PENDING','WAITING_FOR_PRICE'].includes(x.status)).map(x => x.symbol).filter(Boolean)));
}

function markManualWaitingForPrice(nowMs = Date.now()) {
    const history = loadHistory(); let changed = false;
    for (const r of history) {
        if (r.status === 'PENDING' && nowMs >= Number(r.expiryAtMs)) { r.status = 'WAITING_FOR_PRICE'; changed = true; }
    }
    if (changed) saveHistory(history);
}

function summarizeRows(rows) {
    const w = rows.filter(x => x.result === 'WIN').length;
    const l = rows.filter(x => x.result === 'LOSS').length;
    const f = rows.filter(x => x.result === 'FLAT').length;
    return {
        total: rows.length,
        wins: w,
        losses: l,
        flat: f,
        winRate: w + l > 0 ? +((w / (w + l)) * 100).toFixed(1) : null,
        avgMfe: rows.length ? +(rows.reduce((sum, x) => sum + (Number(x.maxFavorableMove) || 0), 0) / rows.length).toFixed(8) : null,
        avgMae: rows.length ? +(rows.reduce((sum, x) => sum + (Number(x.maxAdverseMove) || 0), 0) / rows.length).toFixed(8) : null
    };
}

function delayBucket(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return 'UNKNOWN';
    if (value <= 2) return '0-2s';
    if (value <= 10) return '2-10s';
    if (value <= 30) return '10-30s';
    return '30s+';
}

function getManualAnalysisStats() {
    const history = loadHistory();
    const completed = history.filter(x => x.status === 'COMPLETED');
    const validCompleted = completed.filter(x => x.resultValid !== false);
    const summary = summarizeRows(validCompleted);
    const byExpiration = [3, 5, 15].map(minutes => ({ minutes, ...summarizeRows(validCompleted.filter(x => Number(x.expirationMinutes) === minutes)) }));
    const benchmark15 = byExpiration.find(x => x.minutes === 15) || { minutes: 15, total: 0, wins: 0, losses: 0, flat: 0, winRate: null };

    return {
        total: history.length,
        waiting: history.filter(x => x.status === 'WAITING_ENTRY').length,
        pending: history.filter(x => ['PENDING','WAITING_FOR_PRICE'].includes(x.status)).length,
        completed: completed.length,
        validCompleted: validCompleted.length,
        wins: summary.wins,
        losses: summary.losses,
        flat: summary.flat,
        invalid: completed.length - validCompleted.length,
        winRate: summary.winRate,
        cleanCompleted: validCompleted.filter(x => x.cleanSample === true).length,
        delayedCompleted: validCompleted.filter(x => x.cleanSample === false).length,
        benchmark15m: benchmark15,
        byDelayBucket: ['0-2s','2-10s','10-30s','30s+','UNKNOWN'].map(bucket => ({
            bucket,
            ...summarizeRows(validCompleted.filter(x => delayBucket(x.entryDeltaSeconds) === bucket))
        })).filter(x => x.total > 0),
        byDataQuality: ['WS_FRESH','WS_OK','WS_DELAYED','REST_FRESH','REST_OK','REST_DELAYED','UNKNOWN'].map(quality => ({
            quality,
            ...summarizeRows(validCompleted.filter(x => String(x.entryDataQuality || 'UNKNOWN') === quality))
        })).filter(x => x.total > 0),
        byAnalysisQuality: ['FULL','PARTIAL','FALLBACK'].map(quality => ({
            quality,
            ...summarizeRows(validCompleted.filter(x => String(x.analysisQuality || 'FULL') === quality))
        })).filter(x => x.total > 0),
        byExpiration,
        latest: history.slice(-20).reverse()
    };
}

module.exports = { logManualAnalysis, updateManualAnalysisForSymbol, getManualAnalysisStats, getManualPendingSymbols, markManualWaitingForPrice };
