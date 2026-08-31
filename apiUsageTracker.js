'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'api-usage.json');

const DAILY_LIMIT = Math.max(0, Number(process.env.TWELVE_DAILY_REQUEST_LIMIT) || 0);
const WARNING_RATIO = Math.min(
    0.99,
    Math.max(0.50, Number(process.env.TWELVE_DAILY_WARNING_RATIO) || 0.85)
);

function getMontrealDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const get = type => parts.find(p => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function emptyState() {
    return {
        date: getMontrealDateKey(),
        requests: 0,
        byType: {},
        lastRequestAt: null
    };
}

function loadState() {
    try {
        ensureDataDir();

        if (!fs.existsSync(USAGE_FILE)) {
            return emptyState();
        }

        const raw = fs.readFileSync(USAGE_FILE, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : emptyState();
        const today = getMontrealDateKey();

        if (!parsed || parsed.date !== today) {
            return emptyState();
        }

        return {
            date: today,
            requests: Number(parsed.requests) || 0,
            byType: parsed.byType && typeof parsed.byType === 'object'
                ? parsed.byType
                : {},
            lastRequestAt: parsed.lastRequestAt || null
        };
    } catch (error) {
        console.warn('[API USAGE] load error:', error.message);
        return emptyState();
    }
}

function saveState(state) {
    try {
        ensureDataDir();
        fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.warn('[API USAGE] save error:', error.message);
    }
}

function normalizeState() {
    const state = loadState();
    if (state.date !== getMontrealDateKey()) {
        return emptyState();
    }
    return state;
}

function recordApiRequest(type = 'REST') {
    const state = normalizeState();
    const key = String(type || 'REST').toUpperCase();

    state.requests += 1;
    state.byType[key] = (Number(state.byType[key]) || 0) + 1;
    state.lastRequestAt = new Date().toISOString();

    saveState(state);
    return getApiUsageStatus(state);
}

function getApiUsageStatus(existingState = null) {
    const state = existingState || normalizeState();
    const hasLimit = DAILY_LIMIT > 0;
    const remaining = hasLimit
        ? Math.max(0, DAILY_LIMIT - state.requests)
        : null;
    const ratio = hasLimit && DAILY_LIMIT > 0
        ? state.requests / DAILY_LIMIT
        : null;

    let level = 'SAFE';
    if (hasLimit && state.requests >= DAILY_LIMIT) {
        level = 'STOP_REST';
    } else if (hasLimit && ratio >= WARNING_RATIO) {
        level = 'WARNING';
    }

    return {
        date: state.date,
        requests: state.requests,
        byType: state.byType,
        lastRequestAt: state.lastRequestAt,
        dailyLimit: hasLimit ? DAILY_LIMIT : null,
        remaining,
        warningRatio: WARNING_RATIO,
        level,
        hardLimitConfigured: hasLimit
    };
}

function canMakeRestRequest() {
    const status = getApiUsageStatus();
    return !status.hardLimitConfigured || status.requests < status.dailyLimit;
}

function assertRestAllowed() {
    const status = getApiUsageStatus();

    if (!canMakeRestRequest()) {
        const error = new Error(
            `Twelve Data daily REST limit reached (${status.requests}/${status.dailyLimit}).`
        );
        error.code = 'TWELVE_DAILY_LIMIT_REACHED';
        error.status = 429;
        throw error;
    }

    return status;
}

module.exports = {
    recordApiRequest,
    getApiUsageStatus,
    canMakeRestRequest,
    assertRestAllowed
};
