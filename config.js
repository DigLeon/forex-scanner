const PORT = 3000;


// ======================================================
// TWELVE DATA API
// ======================================================

const API_KEY =
    process.env.TWELVE_DATA_API_KEY ||
    process.env.TWELVE_API_KEY ||
    process.env.API_KEY ||
    '';

const TWELVE_DATA_API_KEY_SOURCE =
    process.env.TWELVE_DATA_API_KEY ? 'TWELVE_DATA_API_KEY' :
    process.env.TWELVE_API_KEY ? 'TWELVE_API_KEY' :
    process.env.API_KEY ? 'API_KEY' :
    null;


// ======================================================
// FOREX PAIRS
// ======================================================

const PAIRS = [
    'GBP/USD',
    'USD/JPY',
    'USD/CAD',
    'EUR/CAD',
    'AUD/CAD',
    'EUR/USD',
    'EUR/GBP',
    'EUR/JPY',
    'GBP/JPY',
    'AUD/USD',
    'GBP/CAD',
    'CAD/JPY',
];


// ======================================================
// DEFAULT SETTINGS
// ======================================================

const DEFAULT_PAIR_SETTINGS = {
    minSignalScore: 52,
    minEdge: 8,
    retestAtrTolerance: 0.23,
    breakoutAtrBuffer: 0.07
};


// ======================================================
// PAIR-SPECIFIC SETTINGS
// ======================================================

function getPairSettings(
    symbol
) {
    const settings = {
        ...DEFAULT_PAIR_SETTINGS
    };


    if (
        [
            'USD/JPY',
            'USD/CAD'
        ].includes(
            symbol
        )
    ) {
        settings.minSignalScore = 54;
        settings.minEdge = 8;
        settings.retestAtrTolerance = 0.22;
        settings.breakoutAtrBuffer = 0.06;
    }


    if (
        typeof symbol === 'string' &&
        symbol.toUpperCase().startsWith('GBP/')
    ) {
        settings.minSignalScore = 55;
        settings.minEdge = 9;
        settings.retestAtrTolerance = 0.25;
        settings.breakoutAtrBuffer = 0.08;
    }


    return settings;
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    PORT,
    API_KEY,
    TWELVE_DATA_API_KEY_SOURCE,
    PAIRS,
    getPairSettings
};