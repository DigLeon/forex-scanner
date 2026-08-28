// ======================================================
// dataProvider.js
// v4.6 — Provider Abstraction
// ======================================================
//
// Scanner depends on this module rather than directly on
// Twelve Data REST or a realtime provider.
// ======================================================

function createDataProvider({
    restProvider,
    realtimeProvider,
    enableRealtime =
        false
}) {

    if (
        !restProvider
    ) {

        throw new Error(
            'restProvider is required'
        );
    }


    async function getCandles(
        symbol,
        options = {}
    ) {

        return restProvider.getTimeSeries(
            symbol,
            options
        );
    }


    async function getPrice(
        symbol
    ) {

        if (
            enableRealtime &&
            realtimeProvider &&
            typeof realtimeProvider.getLivePrice ===
                'function'
        ) {

            const live =
                realtimeProvider.getLivePrice(
                    symbol
                );


            if (
                live &&
                live.fresh &&
                Number.isFinite(
                    Number(
                        live.price
                    )
                )
            ) {

                return {

                    status:
                        'ok',

                    symbol:
                        symbol,

                    price:
                        Number(
                            live.price
                        ),

                    source:
                        'REALTIME',

                    updatedAt:
                        live.updatedAt ||
                        null,

                    ageMs:
                        live.ageMs ??
                        null
                };
            }
        }


        const rest =
            await restProvider.getPrice(
                symbol
            );


        return {

            ...rest,

            source:
                rest.source ||
                'REST'
        };
    }


    function getStatus() {

        const restStatus =
            typeof restProvider.getMarketDataCacheStatus ===
                'function'
                ?
                restProvider
                    .getMarketDataCacheStatus()
                :
                null;


        const realtimeStatus =
            enableRealtime &&
            realtimeProvider &&
            typeof realtimeProvider.getRealtimeStatus ===
                'function'
                ?
                realtimeProvider
                    .getRealtimeStatus()
                :
                {
                    enabled:
                        false
                };


        return {

            realtimeEnabled:
                Boolean(
                    enableRealtime
                ),

            rest:
                restStatus,

            realtime:
                realtimeStatus
        };
    }


    return {
        getCandles,
        getPrice,
        getStatus
    };
}


module.exports = {
    createDataProvider
};
