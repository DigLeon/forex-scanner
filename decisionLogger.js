// ======================================================
// decisionLogger.js
// v4.6 — All Scan Decisions Logger
// ======================================================
//
// Logs TRADE / WAIT / SKIP / ERROR as JSONL.
// This is separate from trade-result logging.
// ======================================================

const fs =
    require(
        'fs'
    );


const path =
    require(
        'path'
    );


const DATA_DIR =
    path.join(
        __dirname,
        'data'
    );


const DECISIONS_FILE =
    path.join(
        DATA_DIR,
        'scan-decisions.jsonl'
    );


function ensureDataDir() {

    fs.mkdirSync(
        DATA_DIR,
        {
            recursive:
                true
        }
    );
}


function appendDecision(
    record
) {

    ensureDataDir();


    const normalized = {

        createdAt:
            record.createdAt ||
            new Date()
                .toISOString(),

        analysisId:
            record.analysisId ||
            null,

        candleId:
            record.candleId ||
            null,

        symbol:
            record.symbol ||
            null,

        decision:
            record.decision ||
            'ERROR',

        reasonCode:
            record.reasonCode ||
            null,

        reason:
            record.reason ||
            null,

        signal:
            record.signal ||
            null,

        score:
            Number.isFinite(
                Number(
                    record.score
                )
            )
                ?
                Number(
                    record.score
                )
                :
                null,

        edge:
            Number.isFinite(
                Number(
                    record.edge
                )
            )
                ?
                Number(
                    record.edge
                )
                :
                null,

        entryStatus:
            record.entryStatus ||
            null,

        entryQuality:
            record.entryQuality ||
            null,

        signalStrength:
            record.signalStrength ||
            null,

        expirationMinutes:
            Number.isFinite(
                Number(
                    record.expirationMinutes
                )
            )
                ?
                Number(
                    record.expirationMinutes
                )
                :
                null,

        dataFreshness:
            record.dataFreshness ||
            null,

        source:
            record.source ||
            null,

        metadata:
            record.metadata ||
            null
    };


    fs.appendFileSync(
        DECISIONS_FILE,
        JSON.stringify(
            normalized
        ) +
        '\n',
        'utf8'
    );


    return normalized;
}


function readDecisions({
    limit = 5000
} = {}) {

    ensureDataDir();


    if (
        !fs.existsSync(
            DECISIONS_FILE
        )
    ) {

        return [];
    }


    const lines =
        fs.readFileSync(
            DECISIONS_FILE,
            'utf8'
        )
        .split(
            /\r?\n/
        )
        .filter(
            Boolean
        );


    return lines
        .slice(
            -Math.max(
                1,
                Number(
                    limit
                ) ||
                5000
            )
        )
        .map(
            line => {

                try {

                    return JSON.parse(
                        line
                    );


                } catch (
                    error
                ) {

                    return null;
                }
            }
        )
        .filter(
            Boolean
        );
}


function getDecisionStats() {

    const rows =
        readDecisions();


    const byDecision = {};


    const byReasonCode = {};


    for (
        const row
        of rows
    ) {

        byDecision[
            row.decision
        ] =
            (
                byDecision[
                    row.decision
                ] ||
                0
            ) +
            1;


        if (
            row.reasonCode
        ) {

            byReasonCode[
                row.reasonCode
            ] =
                (
                    byReasonCode[
                        row.reasonCode
                    ] ||
                    0
                ) +
                1;
        }
    }


    return {

        total:
            rows.length,

        byDecision:
            byDecision,

        byReasonCode:
            byReasonCode
    };
}


module.exports = {
    appendDecision,
    readDecisions,
    getDecisionStats,
    DECISIONS_FILE
};
