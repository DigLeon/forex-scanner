'use strict';

// v5.0 Smart candle-driven Auto Scan gate.
// It does NOT change scoring, entry, confirmation or expiration logic.
// It only ensures that one full scan is requested per newly closed 1M candle,
// regardless of how many symbols report that candle over WebSocket.

function parseUtcCandleOpenMs(datetime) {
    if (!datetime) return null;

    const raw = String(datetime).trim();
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
        ? raw
        : raw.replace(' ', 'T') + 'Z';

    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

function getDirtyTimeframes(candleDatetime) {
    const openMs = parseUtcCandleOpenMs(candleDatetime);

    if (!Number.isFinite(openMs)) {
        return {
            m1: true,
            m3: false,
            m5: false,
            m15: false,
            m30: false,
            h1: false
        };
    }

    // datetime is the 1M candle OPEN time.
    // We care about the time at which that candle just CLOSED.
    const close = new Date(openMs + 60 * 1000);
    const minute = close.getUTCMinutes();

    return {
        m1: true,
        m3: minute % 3 === 0,
        m5: minute % 5 === 0,
        m15: minute % 15 === 0,
        m30: minute % 30 === 0,
        h1: minute === 0
    };
}

function createSmartAutoScanGate(options = {}) {
    const settleMs = Math.max(250, Number(options.settleMs) || 1800);

    let lastRequestedMinute = null;
    let pendingMinute = null;
    let timer = null;
    let lastEventAt = null;
    let lastScanAt = null;
    let lastDirty = null;
    const symbolsSeen = new Set();

    function clearTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function status() {
        return {
            lastRequestedMinute,
            pendingMinute,
            lastEventAt,
            lastScanAt,
            symbolsSeen: Array.from(symbolsSeen),
            lastDirty,
            settleMs
        };
    }

    function onClosed1m({ symbol, candle, enabled, scanInProgress, requestScan }) {
        if (!enabled || typeof requestScan !== 'function') {
            return { requested: false, reason: 'DISABLED', ...status() };
        }

        const datetime = candle && candle.datetime
            ? String(candle.datetime)
            : null;

        if (!datetime) {
            return { requested: false, reason: 'NO_CANDLE_TIME', ...status() };
        }

        lastEventAt = new Date().toISOString();

        if (datetime === lastRequestedMinute) {
            return { requested: false, reason: 'ALREADY_SCANNED_MINUTE', ...status() };
        }

        if (pendingMinute !== datetime) {
            clearTimer();
            pendingMinute = datetime;
            symbolsSeen.clear();
        }

        if (symbol) symbolsSeen.add(String(symbol));
        lastDirty = getDirtyTimeframes(datetime);

        clearTimer();

        timer = setTimeout(() => {
            timer = null;

            if (pendingMinute !== datetime) return;

            if (typeof scanInProgress === 'function' && scanInProgress()) {
                // Do not queue overlapping scans. The next closed 1M candle
                // will give us another deterministic opportunity.
                console.log('[SMART AUTO SCAN] skip | scan already in progress | candle:', datetime);
                pendingMinute = null;
                return;
            }

            lastRequestedMinute = datetime;
            pendingMinute = null;
            lastScanAt = new Date().toISOString();

            console.log(
                '[SMART AUTO SCAN] closed 1M:',
                datetime,
                '| symbols:',
                Array.from(symbolsSeen).join(', '),
                '| dirty:',
                lastDirty
            );

            Promise.resolve(
                requestScan({
                    candleDatetime: datetime,
                    dirty: lastDirty,
                    symbolsSeen: Array.from(symbolsSeen)
                })
            ).catch(error => {
                console.warn('[SMART AUTO SCAN ERROR]', error.message);
            });
        }, settleMs);

        return { requested: false, reason: 'SETTLING', ...status() };
    }

    return {
        onClosed1m,
        getStatus: status,
        getDirtyTimeframes
    };
}

module.exports = {
    createSmartAutoScanGate,
    getDirtyTimeframes
};
