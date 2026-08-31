const https = require('https');

const TELEGRAM_ALERTS = String(process.env.TELEGRAM_ALERTS || '').toLowerCase() === 'true';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_IDS =
    String(
        process.env.TELEGRAM_CHAT_IDS ||
        process.env.TELEGRAM_CHAT_ID ||
        ''
    )
    .split(',')
    .map(
        id =>
            id.trim()
    )
    .filter(
        Boolean
    );

const sentSignalKeys = new Set();
const sentEarlyKeys = new Set();

function isTelegramConfigured() {
    return Boolean(TELEGRAM_ALERTS && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS.length > 0);
}

function buildSignalKey(signal) {
    return [
        signal?.symbol || 'UNKNOWN',
        signal?.signal || 'UNKNOWN',
        signal?.candleId || 'NO_CANDLE',
        signal?.analysisId || 'NO_ANALYSIS'
    ].join('|');
}

function formatMontrealTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString('ru-RU', {
        timeZone: 'America/Toronto',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    if (Math.abs(n) >= 100) return n.toFixed(3);
    if (Math.abs(n) >= 1) return n.toFixed(5);
    return n.toFixed(6);
}

function hasConcreteExpiration(signal) {
    const minutes = Number(signal?.expirationMinutes ?? signal?.expiration?.recommendedMinutes);
    const at = signal?.expirationAt;
    if (!Number.isFinite(minutes) || minutes <= 0 || !at) return false;
    const atMs = new Date(at).getTime();
    return Number.isFinite(atMs) && atMs > Date.now();
}

function buildTradeMessage(signal) {
    const entryZone = signal?.entryZone && typeof signal.entryZone === 'object' ? signal.entryZone : {};
    const strategy = signal?.primaryStrategy?.name || signal?.strategyName || signal?.strategy || '-';
    const icon = signal?.signal === 'UP' ? '⬆️' : signal?.signal === 'DOWN' ? '⬇️' : '➡️';

    return [
        `📈 ${signal?.symbol || 'НЕИЗВЕСТНО'} — ${signal?.signal === 'UP' ? 'ВВЕРХ' : signal?.signal === 'DOWN' ? 'ВНИЗ' : 'НЕТ СИГНАЛА'} ${icon}`,
        '',
        '✅ СИГНАЛ ПОДТВЕРЖДЁН',
        '',
        `Оценка: ${Number(signal?.score) || 0}`,
        `Текущая цена: ${formatNumber(signal?.currentPrice)}`,
        `Качество входа: ${entryZone.currentEntryQuality || signal?.entryQuality || '-'}`,
        `Лучший вход: ${formatNumber(entryZone.bestEntryPrice)}`,
        `Не входить после: ${formatNumber(entryZone.worstEntryPrice)}`,
        '',
        `Стратегия: ${strategy}`,
        `Экспирация: ${formatMontrealTime(signal?.expirationAt)} (Монреаль)`,
        `Решение: ${signal?.decision === 'TRADE' ? 'ПОДТВЕРЖДЁН' : (signal?.decision || 'ПОДТВЕРЖДЁН')}`
    ].join('\n');
}

function telegramRequest(method, payload) {
    return new Promise((resolve, reject) => {
        if (!TELEGRAM_BOT_TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN is missing'));

        const body = JSON.stringify(payload);

        const request = https.request({
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 10000
        }, response => {
            let data = '';
            response.on('data', chunk => data += chunk.toString());
            response.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); }
                catch { parsed = { ok:false, description:data || 'Invalid Telegram response' }; }

                if (response.statusCode >= 200 && response.statusCode < 300 && parsed?.ok) {
                    return resolve(parsed);
                }

                reject(new Error(parsed?.description || `Telegram HTTP ${response.statusCode}`));
            });
        });

        request.on('timeout', () => request.destroy(new Error('Telegram request timed out')));
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

async function sendTelegramMessage(text) {
    if (!TELEGRAM_CHAT_IDS.length) {
        throw new Error('TELEGRAM_CHAT_IDS is missing');
    }

    const deliveries = [];

    for (const chatId of TELEGRAM_CHAT_IDS) {
        try {
            const response =
                await telegramRequest(
                    'sendMessage',
                    {
                        chat_id: chatId,
                        text,
                        disable_web_page_preview: true
                    }
                );

            deliveries.push({
                chatId,
                sent: true,
                messageId:
                    response?.result?.message_id ||
                    null
            });

        } catch (error) {
            console.error(
                '[TELEGRAM USER ERROR]',
                chatId,
                error.message
            );

            deliveries.push({
                chatId,
                sent: false,
                error: error.message
            });
        }
    }

    const sentCount =
        deliveries.filter(
            item =>
                item.sent
        ).length;

    if (sentCount === 0) {
        const details =
            deliveries
                .map(
                    item =>
                        `${item.chatId}: ${item.error || 'send failed'}`
                )
                .join('; ');

        throw new Error(
            `Telegram delivery failed for all recipients. ${details}`
        );
    }

    return {
        ok: true,
        sentCount,
        failedCount:
            deliveries.length -
            sentCount,
        deliveries
    };
}


function buildEarlyMessage(signal) {
    const ez = signal?.entryZone || {};
    const ss = signal?.signalStrength || {};
    const cc = signal?.candleConfirmation || {};
    const icon = signal?.signal === 'UP' ? '⬆️' : '⬇️';
    return [
        `🔔 PAPER — ПРИГОТОВИТЬСЯ — ${signal?.symbol || 'НЕИЗВЕСТНО'} ${signal?.signal === 'UP' ? 'ВВЕРХ' : signal?.signal === 'DOWN' ? 'ВНИЗ' : ''} ${icon}`,
        `Оценка: ${Number(signal?.score) || 0}/${Number(signal?.requiredScore) || '-'}`,
        `Сила сигнала: ${Number(ss.score) || 0} (${ss.recommendation || ss.level || '-'})`,
        `Вход: ${ez.status || ez.currentEntryQuality || '-'}`,
        `Цена: ${formatNumber(signal?.currentPrice)}`,
        `Лучший вход: ${formatNumber(ez.bestEntryPrice)}`,
        `Свечное подтверждение: ${cc.confirmed ? 'ПОДТВЕРЖДЕНО' : 'ОЖИДАНИЕ'}`,
        `Экспирация: ${formatMontrealTime(signal?.expirationAt)} (Монреаль)`,
        '',
        'PAPER-уведомление отправлено после расчёта времени экспирации.'
    ].join('\n');
}

async function sendEarlyAlert(signal) {
    if (!isTelegramConfigured()) return {sent:false, reason:'TELEGRAM_DISABLED_OR_NOT_CONFIGURED'};
    if (!signal || signal.stage !== 'GET_READY') return {sent:false, reason:'NOT_GET_READY'};
    if (!hasConcreteExpiration(signal)) return {sent:false, reason:'EXPIRATION_NOT_READY'};
    const key = [signal.symbol, signal.signal, signal.entryZone?.fvgId || 'NO_FVG'].join('|');
    if (sentEarlyKeys.has(key)) return {sent:false, reason:'DUPLICATE_EARLY', key};
    const response = await sendTelegramMessage(buildEarlyMessage(signal));
    sentEarlyKeys.add(key);
    return {sent:true,key,sentCount:response.sentCount,failedCount:response.failedCount,deliveries:response.deliveries};
}

async function sendTradeAlert(signal) {
    if (!isTelegramConfigured()) {
        return { sent:false, reason:'TELEGRAM_DISABLED_OR_NOT_CONFIGURED' };
    }

    if (!signal || signal.decision !== 'TRADE') {
        return { sent:false, reason:'NOT_A_TRADE' };
    }

    if (!hasConcreteExpiration(signal)) {
        return { sent:false, reason:'EXPIRATION_NOT_READY' };
    }

    const key = buildSignalKey(signal);

    if (sentSignalKeys.has(key)) {
        return { sent:false, reason:'DUPLICATE_SIGNAL', key };
    }

    const response =
        await sendTelegramMessage(
            buildTradeMessage(signal)
        );

    sentSignalKeys.add(key);

    return {
        sent: true,
        key,
        sentCount:
            response.sentCount,
        failedCount:
            response.failedCount,
        deliveries:
            response.deliveries
    };
}

async function sendTestAlert() {
    if (!isTelegramConfigured()) {
        throw new Error('Telegram alerts are disabled or TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is missing');
    }

    const now = new Date();

    return sendTelegramMessage([
        '🧪 Тест Telegram — Forex Scanner',
        '',
        'Соединение: OK',
        `Время сервера: ${formatMontrealTime(now.toISOString())} (Монреаль)`,
        '',
        'Telegram-уведомления работают.'
    ].join('\n'));
}

module.exports = {
    isTelegramConfigured,
    sendTradeAlert,
    sendEarlyAlert,
    sendTestAlert
};
