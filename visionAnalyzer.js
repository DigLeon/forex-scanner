const fetch =
    require(
        'node-fetch'
    );


// ======================================================
// OPENAI VISUAL CHART REVIEW
// ======================================================
//
// Educational / paper-analysis visual review.
//
// This module compares screenshots with the scanner's
// existing numerical analysis. It does NOT replace the
// hard numerical entry limits and does NOT issue a trade
// execution command.
// ======================================================

const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY;


const OPENAI_VISION_MODEL =
    process.env.OPENAI_VISION_MODEL ||
    'gpt-5.6-luna';


function imageToDataUrl(
    file
) {

    if (
        !file ||
        !file.buffer ||
        !file.mimetype
    ) {

        return null;
    }


    return (
        `data:${file.mimetype};base64,` +
        file.buffer.toString(
            'base64'
        )
    );
}


function compactSignalSnapshot(
    signal
) {

    const entryZone =
        signal &&
        signal.entryZone &&
        typeof signal.entryZone ===
            'object'
            ?
            signal.entryZone
            :
            {};


    const entryEngine =
        signal &&
        signal.entryEngine &&
        typeof signal.entryEngine ===
            'object'
            ?
            signal.entryEngine
            :
            {};


    const signalStrength =
        signal &&
        signal.signalStrength &&
        typeof signal.signalStrength ===
            'object'
            ?
            signal.signalStrength
            :
            {};


    const diagnostics =
        signal &&
        signal.signalDiagnostics &&
        typeof signal.signalDiagnostics ===
            'object'
            ?
            signal.signalDiagnostics
            :
            {};


    return {

        symbol:
            signal.symbol ||
            null,

        signal:
            signal.signal ||
            null,

        score:
            Number(
                signal.score
            ) || 0,

        currentPrice:
            Number.isFinite(
                Number(
                    signal.currentPrice
                )
            )
                ?
                Number(
                    signal.currentPrice
                )
                :
                null,

        signalAge:
            signal.signalAge ||
            null,

        signalStage:
            signal.signalStage ||
            diagnostics.signalStage ||
            null,

        marketBias:
            signal.marketBias ||
            diagnostics.marketBias ||
            null,

        contextDirection:
            signal.contextDirection ||
            diagnostics.contextDirection ||
            null,

        setupDirection:
            signal.setupDirection ||
            diagnostics.setupDirection ||
            null,

        entryZone: {

            status:
                entryZone.status ||
                null,

            currentEntryQuality:
                entryZone.currentEntryQuality ||
                null,

            bestEntryPrice:
                entryZone.bestEntryPrice ??
                null,

            bestZoneLow:
                entryZone.bestZoneLow ??
                null,

            bestZoneHigh:
                entryZone.bestZoneHigh ??
                null,

            lastAcceptablePrice:
                entryZone.lastAcceptablePrice ??
                null,

            worstEntryPrice:
                entryZone.worstEntryPrice ??
                null,

            timeframe:
                entryZone.timeframe ||
                null,

            reason:
                entryZone.reason ||
                null
        },

        entryTiming: {

            status:
                entryEngine.status ||
                null,

            color:
                entryEngine.color ||
                null,

            qualityScore:
                entryEngine.qualityScore ??
                null,

            reason:
                entryEngine.reason ||
                null
        },

        signalStrength: {

            score:
                signalStrength.score ??
                null,

            level:
                signalStrength.level ||
                null,

            recommendation:
                signalStrength.recommendation ||
                null,

            warnings:
                Array.isArray(
                    signalStrength.warnings
                )
                    ?
                    signalStrength.warnings
                    :
                    []
        },

        expiration:
            signal.expiration
                ?
                {
                    recommendedMinutes:
                        signal.expiration
                            .recommendedMinutes ??
                        null,

                    strategy:
                        signal.expiration
                            .strategy ||
                        null
                }
                :
                null
    };
}


function buildFusionReview(
    signal,
    visual
) {

    const entryZone =
        signal &&
        signal.entryZone &&
        typeof signal.entryZone ===
            'object'
            ?
            signal.entryZone
            :
            {};


    const entryEngine =
        signal &&
        signal.entryEngine &&
        typeof signal.entryEngine ===
            'object'
            ?
            signal.entryEngine
            :
            {};


    const hardBlock =
        entryZone.status ===
            'TOO LATE' ||
        entryZone.currentEntryQuality ===
            'WORST ENTRY / DO NOT ENTER' ||
        entryEngine.color ===
            'RED';


    let reviewStatus =
        'MIXED';


    if (
        hardBlock
    ) {

        reviewStatus =
            'HARD NUMERICAL BLOCK STILL APPLIES';


    } else if (
        visual.alignment ===
            'AGREES'
    ) {

        reviewStatus =
            'VISUAL AGREEMENT';


    } else if (
        visual.alignment ===
            'DISAGREES'
    ) {

        reviewStatus =
            'VISUAL CONFLICT';


    } else {

        reviewStatus =
            'MIXED / NEEDS REVIEW';
    }


    return {

        reviewStatus:
            reviewStatus,

        hardBlock:
            hardBlock,

        dataSignal:
            signal.signal ||
            null,

        dataScore:
            Number(
                signal.score
            ) || 0,

        visualDirection:
            visual.visualDirection,

        visualConfidence:
            visual.confidence,

        alignment:
            visual.alignment,

        entryContext:
            visual.entryContext,

        // Preserve numerical engine values as authoritative.
        bestEntryPrice:
            entryZone.bestEntryPrice ??
            null,

        lastAcceptablePrice:
            entryZone.lastAcceptablePrice ??
            null,

        doNotChasePrice:
            entryZone.worstEntryPrice ??
            null,

        expirationMinutes:
            signal.expiration &&
            signal.expiration.recommendedMinutes !==
                undefined
                ?
                signal.expiration
                    .recommendedMinutes
                :
                null,

        note:
            hardBlock
                ?
                'Visual review cannot override the scanner hard entry block.'
                :
                'Visual review is an additional paper-analysis confirmation layer; numerical limits remain authoritative.'
    };
}


async function analyzeChartScreenshots({
    symbol,
    signalSnapshot,
    images
}) {

    if (
        !OPENAI_API_KEY
    ) {

        throw new Error(
            'OPENAI_API_KEY is not configured in .env'
        );
    }


    const expectedTimeframes =
        [
            '1m',
            '3m',
            '5m',
            '15m',
            '30m'
        ];


    for (
        const timeframe
        of expectedTimeframes
    ) {

        if (
            !images[
                timeframe
            ]
        ) {

            throw new Error(
                `Missing ${timeframe} screenshot`
            );
        }
    }


    const compactSignal =
        compactSignalSnapshot(
            signalSnapshot
        );


    const content =
        [
            {
                type:
                    'input_text',

                text:
                    [
                        'You are reviewing forex chart screenshots for an educational PAPER ANALYSIS dashboard.',
                        'Compare only what is visibly supported by the screenshots with the existing numerical scanner result.',
                        'Do not issue a trade execution command.',
                        'Do not claim exact prices from the image unless clearly readable.',
                        'Do not override hard numerical limits such as TOO LATE or DO NOT CHASE.',
                        'Assess structure, trend alignment, pullback/retest quality, momentum, extension, rejection, and conflicts across timeframes.',
                        '',
                        `SYMBOL: ${symbol}`,
                        '',
                        'NUMERICAL SCANNER SNAPSHOT:',
                        JSON.stringify(
                            compactSignal,
                            null,
                            2
                        )
                    ]
                    .join(
                        '\n'
                    )
            }
        ];


    for (
        const timeframe
        of expectedTimeframes
    ) {

        const file =
            images[
                timeframe
            ];


        const dataUrl =
            imageToDataUrl(
                file
            );


        content.push(
            {
                type:
                    'input_text',

                text:
                    `Chart screenshot timeframe: ${timeframe}`
            }
        );


        content.push(
            {
                type:
                    'input_image',

                image_url:
                    dataUrl,

                detail:
                    'high'
            }
        );
    }


    const schema = {

        type:
            'object',

        properties: {

            visualDirection: {
                type:
                    'string',

                enum: [
                    'BULLISH',
                    'BEARISH',
                    'NEUTRAL',
                    'MIXED'
                ]
            },

            confidence: {
                type:
                    'integer',

                minimum:
                    0,

                maximum:
                    100
            },

            alignment: {
                type:
                    'string',

                enum: [
                    'AGREES',
                    'MIXED',
                    'DISAGREES'
                ]
            },

            entryContext: {
                type:
                    'string',

                enum: [
                    'SUPPORTIVE',
                    'NEUTRAL',
                    'EXTENDED',
                    'UNCLEAR'
                ]
            },

            timeframes: {

                type:
                    'object',

                properties: {

                    '1m': {
                        type:
                            'string'
                    },

                    '3m': {
                        type:
                            'string'
                    },

                    '5m': {
                        type:
                            'string'
                    },

                    '15m': {
                        type:
                            'string'
                    },

                    '30m': {
                        type:
                            'string'
                    }
                },

                required: [
                    '1m',
                    '3m',
                    '5m',
                    '15m',
                    '30m'
                ],

                additionalProperties:
                    false
            },

            observations: {

                type:
                    'array',

                items: {
                    type:
                        'string'
                }
            },

            warnings: {

                type:
                    'array',

                items: {
                    type:
                        'string'
                }
            },

            summary: {
                type:
                    'string'
            }
        },

        required: [
            'visualDirection',
            'confidence',
            'alignment',
            'entryContext',
            'timeframes',
            'observations',
            'warnings',
            'summary'
        ],

        additionalProperties:
            false
    };


    const controller =
        new AbortController();

    const timeoutMs =
        Math.max(
            5000,
            Number(
                process.env.OPENAI_VISION_TIMEOUT_MS
            ) || 45000
        );

    const timeout =
        setTimeout(
            () => controller.abort(),
            timeoutMs
        );

    let response;
    let payload;

    try {

        response =
            await fetch(
                'https://api.openai.com/v1/responses',
                {

                    method:
                        'POST',

                    headers: {

                        'Authorization':
                            `Bearer ${OPENAI_API_KEY}`,

                        'Content-Type':
                            'application/json'
                    },

                    signal:
                        controller.signal,

                    body:
                        JSON.stringify({

                            model:
                                OPENAI_VISION_MODEL,

                            store:
                                false,

                            input: [
                                {
                                    role:
                                        'user',

                                    content:
                                        content
                                }
                            ],

                            text: {

                                format: {

                                    type:
                                        'json_schema',

                                    name:
                                        'visual_chart_review',

                                    strict:
                                        true,

                                    schema:
                                        schema
                                }
                            }
                        })
                }
            );

        payload =
            await response.json();

    } catch (
        error
    ) {

        if (
            error &&
            error.name ===
            'AbortError'
        ) {

            throw new Error(
                `OpenAI visual analysis timed out after ${timeoutMs} ms`
            );
        }

        throw error;

    } finally {

        clearTimeout(
            timeout
        );
    }


    if (
        !response.ok
    ) {

        const message =
            payload &&
            payload.error &&
            payload.error.message
                ?
                payload.error.message
                :
                `OpenAI HTTP ${response.status}`;


        throw new Error(
            message
        );
    }


    const outputText =
        payload.output_text;


    if (
        !outputText
    ) {

        throw new Error(
            'OpenAI returned no visual analysis text'
        );
    }


    let visual;


    try {

        visual =
            JSON.parse(
                outputText
            );


    } catch (
        error
    ) {

        throw new Error(
            'OpenAI visual analysis was not valid JSON'
        );
    }


    return {

        model:
            payload.model ||
            OPENAI_VISION_MODEL,

        responseId:
            payload.id ||
            null,

        visual:
            visual,

        fusion:
            buildFusionReview(
                signalSnapshot,
                visual
            )
    };
}


module.exports = {
    analyzeChartScreenshots
};
