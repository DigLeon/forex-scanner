// ======================================================
// candleIdentity.js
// v4.6 — Candle ID / Analysis ID / Dedupe
// ======================================================

const crypto =
    require(
        'crypto'
    );


function normalizeCandleTimestamp(
    value
) {

    if (
        !value
    ) {

        return null;
    }


    let text =
        String(
            value
        )
        .trim();


    if (
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
        .test(
            text
        )
    ) {

        text =
            text.replace(
                ' ',
                'T'
            ) +
            'Z';
    }


    const date =
        new Date(
            text
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return null;
    }


    return date.toISOString();
}


function createCandleId(
    symbol,
    newestClosedCandleTime
) {

    const timestamp =
        normalizeCandleTimestamp(
            newestClosedCandleTime
        );


    if (
        !symbol ||
        !timestamp
    ) {

        return null;
    }


    return (
        String(
            symbol
        )
        .toUpperCase() +
        '|' +
        timestamp
    );
}


function createAnalysisId({
    symbol,
    candleId,
    decision,
    generatedAt = new Date()
        .toISOString()
}) {

    const raw =
        [
            symbol ||
                '',
            candleId ||
                '',
            decision ||
                '',
            generatedAt
        ]
        .join(
            '|'
        );


    return crypto
        .createHash(
            'sha256'
        )
        .update(
            raw
        )
        .digest(
            'hex'
        )
        .slice(
            0,
            20
        );
}


class CandleAnalysisDeduper {

    constructor({
        ttlMs = 10 * 60 * 1000
    } = {}) {

        this.ttlMs =
            ttlMs;


        this.items =
            new Map();
    }


    cleanup() {

        const now =
            Date.now();


        for (
            const [
                key,
                createdAt
            ]
            of this.items
        ) {

            if (
                now -
                createdAt >
                this.ttlMs
            ) {

                this.items.delete(
                    key
                );
            }
        }
    }


    has(
        key
    ) {

        this.cleanup();


        return this.items.has(
            key
        );
    }


    mark(
        key
    ) {

        if (
            !key
        ) {

            return;
        }


        this.cleanup();


        this.items.set(
            key,
            Date.now()
        );
    }


    shouldProcess(
        key
    ) {

        if (
            !key
        ) {

            return true;
        }


        if (
            this.has(
                key
            )
        ) {

            return false;
        }


        this.mark(
            key
        );


        return true;
    }
}


module.exports = {
    normalizeCandleTimestamp,
    createCandleId,
    createAnalysisId,
    CandleAnalysisDeduper
};
