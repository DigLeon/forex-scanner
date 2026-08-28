// ======================================================
// v46Integration.js
// v4.6 convenience bootstrap
// ======================================================

const marketData =
    require(
        './marketData'
    );


let realtimeProvider =
    null;


try {

    realtimeProvider =
        require(
            './realtimeMarketData'
        );


} catch (
    error
) {

    realtimeProvider =
        null;
}


const {
    createDataProvider
} = require(
    './dataProvider'
);


const {
    CandleAnalysisDeduper
} = require(
    './candleIdentity'
);


const {
    getDecisionStats
} = require(
    './decisionLogger'
);


const ENABLE_TWELVE_WS =
    String(
        process.env.ENABLE_TWELVE_WS ||
        'false'
    )
    .toLowerCase() ===
    'true';


const dataProvider =
    createDataProvider({

        restProvider:
            marketData,

        realtimeProvider:
            realtimeProvider,

        enableRealtime:
            ENABLE_TWELVE_WS
    });


const candleDeduper =
    new CandleAnalysisDeduper({
        ttlMs:
            10 *
            60 *
            1000
    });


module.exports = {
    dataProvider,
    candleDeduper,
    getDecisionStats,
    ENABLE_TWELVE_WS
};
