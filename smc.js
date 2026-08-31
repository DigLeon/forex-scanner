const crypto = require('crypto');
const {
    num,
    clamp,
    candleStats
} = require('./utils');

const {
    atr
} = require('./indicators');


// ======================================================
// STRUCTURE SETTINGS
// ======================================================

const STRUCTURE_SENSITIVITY_POINTS = 15;


// ======================================================
// POINT SIZE
// ======================================================

function getStructurePointSize(
    candles
) {
    if (!Array.isArray(candles) ||
        !candles.length
    ) {
        return 0.00001;
    }

    const price =
        Math.abs(
            num(
                candles[
                    candles.length - 1
                ].close
            )
        );

    /*
        Для JPY-пар котировки обычно имеют
        другой размер минимального price point.

        Например:
        EUR/USD -> 0.00001
        EUR/JPY -> 0.001
    */

    return price >= 20 ?
        0.001 :
        0.00001;
}


// ======================================================
// LOCAL SWINGS
//
// ВАЖНО:
//
// swing на свече i нельзя использовать сразу.
//
// При:
// left = 2
// right = 2
//
// swing становится известен только после
// закрытия свечи i + 2.
//
// confirmedIndex защищает нас от look-ahead.
// ======================================================

function findSwings(
    candles,
    left = 2,
    right = 2
) {
    const highs = [];
    const lows = [];

    if (!Array.isArray(candles) ||
        candles.length <
        left + right + 1
    ) {
        return {
            highs,
            lows
        };
    }


    for (
        let i = left; i < candles.length - right; i++
    ) {
        const high =
            num(
                candles[i].high
            );

        const low =
            num(
                candles[i].low
            );


        let isHigh = true;
        let isLow = true;


        for (
            let j = i - left; j <= i + right; j++
        ) {
            if (
                j === i
            ) {
                continue;
            }


            if (
                num(
                    candles[j].high
                ) >= high
            ) {
                isHigh = false;
            }


            if (
                num(
                    candles[j].low
                ) <= low
            ) {
                isLow = false;
            }
        }


        if (
            isHigh
        ) {
            highs.push({
                type: 'HIGH',

                index: i,

                confirmedIndex: i + right,

                price: high,

                datetime: candles[i]
                    .datetime,

                confirmedDatetime: candles[
                        i + right
                    ] ?
                    candles[
                        i + right
                    ].datetime :
                    null
            });
        }


        if (
            isLow
        ) {
            lows.push({
                type: 'LOW',

                index: i,

                confirmedIndex: i + right,

                price: low,

                datetime: candles[i]
                    .datetime,

                confirmedDatetime: candles[
                        i + right
                    ] ?
                    candles[
                        i + right
                    ].datetime :
                    null
            });
        }
    }


    return {
        highs,
        lows
    };
}


// ======================================================
// MERGE SWINGS
//
// Объединяем HIGH и LOW в одну временную
// последовательность.
// ======================================================

function mergeSwings(
    swings
) {
    const highs =
        swings &&
        Array.isArray(
            swings.highs
        ) ?
        swings.highs :
        [];


    const lows =
        swings &&
        Array.isArray(
            swings.lows
        ) ?
        swings.lows :
        [];


    return [
            ...highs.map(
                item => ({
                    ...item,
                    type: 'HIGH'
                })
            ),

            ...lows.map(
                item => ({
                    ...item,
                    type: 'LOW'
                })
            )
        ]
        .sort(
            (
                a,
                b
            ) => {
                if (
                    a.confirmedIndex !==
                    b.confirmedIndex
                ) {
                    return (
                        a.confirmedIndex -
                        b.confirmedIndex
                    );
                }

                return (
                    a.index -
                    b.index
                );
            }
        );
}


// ======================================================
// STRUCTURAL SWINGS
//
// Аналог structural_swings.py.
//
// Основная идея:
//
// HIGH -> HIGH
// оставляем более высокий HIGH.
//
// LOW -> LOW
// оставляем более низкий LOW.
//
// HIGH -> LOW
// или LOW -> HIGH
//
// движение должно превышать sensitivity.
//
// Это убирает мелкий рыночный шум.
// ======================================================

function buildStructuralSwings(
    swings,
    sensitivityPoints =
    STRUCTURE_SENSITIVITY_POINTS,
    pointSize =
    0.00001
) {
    const local =
        Array.isArray(
            swings
        ) ?
        swings
        .slice()
        .sort(
            (
                a,
                b
            ) =>
            (
                a.confirmedIndex -
                b.confirmedIndex
            ) ||
            (
                a.index -
                b.index
            )
        ) :
        mergeSwings(
            swings
        );


    const sensitivity =
        Math.max(
            0,
            Number(
                sensitivityPoints
            ) || 0
        ) *
        Math.max(
            0,
            Number(
                pointSize
            ) || 0
        );


    const structural = [];

    let pending = null;


    for (
        const point
        of local
    ) {

        // ==============================================
        // FIRST POINT
        // ==============================================

        if (!pending) {
            pending = {
                ...point
            };

            continue;
        }


        // ==============================================
        // SAME TYPE
        // ==============================================

        if (
            point.type ===
            pending.type
        ) {

            // HIGH -> HIGH
            if (
                point.type ===
                'HIGH' &&
                point.price >
                pending.price
            ) {
                pending = {
                    ...point
                };
            }


            // LOW -> LOW
            if (
                point.type ===
                'LOW' &&
                point.price <
                pending.price
            ) {
                pending = {
                    ...point
                };
            }


            continue;
        }


        // ==============================================
        // OPPOSITE TYPE
        // ==============================================

        const movement =
            Math.abs(
                point.price -
                pending.price
            );


        /*
            Если движение маленькое —
            считаем его шумом.
        */

        if (
            movement <
            sensitivity
        ) {
            continue;
        }


        /*
            Важная защита от look-ahead.

            pending structural point становится
            окончательно структурным только тогда,
            когда подтверждён противоположный swing.
        */

        structural.push({
            ...pending,

            structuralConfirmedIndex: Math.max(
                Number(
                    pending
                    .confirmedIndex
                ) || 0,

                Number(
                    point
                    .confirmedIndex
                ) || 0
            ),

            structuralConfirmedDatetime: point
                .confirmedDatetime ||
                null
        });


        pending = {
            ...point
        };
    }


    return {
        structural,

        pending,

        sensitivity,

        sensitivityPoints,

        pointSize
    };
}


// ======================================================
// CLASSIFY STRUCTURE
//
// HIGH:
// previous high < current -> HH
// previous high > current -> LH
//
// LOW:
// previous low < current -> HL
// previous low > current -> LL
//
// Это перенос classify_structure.py.
// ======================================================

function classifyStructure(
    structuralSwings
) {
    const items =
        Array.isArray(
            structuralSwings
        ) ?
        structuralSwings :
        (
            structuralSwings &&
            Array.isArray(
                structuralSwings
                .structural
            ) ?
            structuralSwings
            .structural :
            []
        );


    const classified = [];


    let previousHigh =
        null;

    let previousLow =
        null;


    for (
        const point
        of items
    ) {
        let structure =
            'INITIAL';


        // ==============================================
        // HIGH
        // ==============================================

        if (
            point.type ===
            'HIGH'
        ) {
            if (
                previousHigh !==
                null
            ) {
                structure =
                    point.price >
                    previousHigh ?
                    'HH' :
                    'LH';
            }


            previousHigh =
                point.price;
        }


        // ==============================================
        // LOW
        // ==============================================
        else if (
            point.type ===
            'LOW'
        ) {
            if (
                previousLow !==
                null
            ) {
                structure =
                    point.price >
                    previousLow ?
                    'HL' :
                    'LL';
            }


            previousLow =
                point.price;
        }


        classified.push({
            ...point,

            structure
        });
    }


    return classified;
}


// ======================================================
// PROTECTED LEVELS
//
// Идея из structure_levels.py +
// structure_points.py.
//
// ВАЖНО:
//
// HL не становится protected сразу.
//
// Только:
//
// HL
// ↓
// новый HH
// ↓
// HL = Protected Low
//
//
// Аналогично:
//
// LH
// ↓
// новый LL
// ↓
// LH = Protected High
// ======================================================

function getStructureLevels(
    classifiedSwings
) {
    let protectedHigh =
        null;

    let protectedLow =
        null;


    let candidateHL =
        null;

    let candidateLH =
        null;


    const points =
        Array.isArray(
            classifiedSwings
        ) ?
        classifiedSwings :
        [];


    for (
        const point
        of points
    ) {

        // ==============================================
        // CANDIDATE HL
        // ==============================================

        if (
            point.structure ===
            'HL'
        ) {
            candidateHL = {
                ...point
            };
        }


        // ==============================================
        // HH CONFIRMS PROTECTED LOW
        // ==============================================
        else if (
            point.structure ===
            'HH'
        ) {
            if (
                candidateHL &&
                candidateHL.index <
                point.index
            ) {
                protectedLow = {
                    ...candidateHL
                };


                candidateHL =
                    null;
            }
        }


        // ==============================================
        // CANDIDATE LH
        // ==============================================
        else if (
            point.structure ===
            'LH'
        ) {
            candidateLH = {
                ...point
            };
        }


        // ==============================================
        // LL CONFIRMS PROTECTED HIGH
        // ==============================================
        else if (
            point.structure ===
            'LL'
        ) {
            if (
                candidateLH &&
                candidateLH.index <
                point.index
            ) {
                protectedHigh = {
                    ...candidateLH
                };


                candidateLH =
                    null;
            }
        }
    }


    return {
        protectedHigh,

        protectedLow,

        candidateHL,

        candidateLH
    };
}


// ======================================================
// MARKET STRUCTURE STATE MACHINE
//
// Полный pipeline:
//
// Local Swings
//      ↓
// confirmedIndex
//      ↓
// Structural Swing Filter
//      ↓
// HH / HL / LH / LL
//      ↓
// Protected Levels
//      ↓
// State Machine
//      ↓
// BOS / CHoCH
//
//
// BULLISH:
//
// Protected Low
//       ↓
//
// close < Protected Low
//
//       ↓
//
// CHoCH DOWN
//       ↓
// BEARISH
//
//
// BEARISH:
//
// Protected High
//       ↓
//
// close > Protected High
//
//       ↓
//
// CHoCH UP
//       ↓
// BULLISH
//
//
// BOS не меняет state.
// BOS подтверждает продолжение.
// ======================================================

function detectStructure(
    candles
) {

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!Array.isArray(
            candles
        ) ||
        candles.length <
        20
    ) {
        return {
            trend: 'UNKNOWN',

            state: 'UNKNOWN',

            bos: false,

            bosDirection: null,

            choch: false,

            chochDirection: null,

            swingHigh: null,

            swingLow: null,

            protectedHigh: null,

            protectedLow: null,

            continuationHigh: null,

            continuationLow: null,

            lastSwingHigh: null,

            lastSwingLow: null,

            lastStructureEvent: null,

            recentStructureEvents: [],

            structureEventCount: 0,

            structuralSwings: [],

            classifiedSwings: [],

            pendingStructuralSwing: null,

            sensitivityPoints: STRUCTURE_SENSITIVITY_POINTS,

            pointSize: getStructurePointSize(
                candles
            ),

            sensitivity: null,

            antiLookAhead: {
                localSwingUsesConfirmedIndex: true,

                structuralSwingRequiresOppositeConfirmation: true,

                protectedLevelsUseStructuralConfirmation: true
            }
        };
    }


    // ==================================================
    // LOCAL SWINGS
    // ==================================================

    const localSwings =
        findSwings(
            candles,
            2,
            2
        );


    const mergedLocal =
        mergeSwings(
            localSwings
        );


    // ==================================================
    // SENSITIVITY
    // ==================================================

    const pointSize =
        getStructurePointSize(
            candles
        );


    const sensitivity =
        STRUCTURE_SENSITIVITY_POINTS *
        pointSize;


    // ==================================================
    // STATE
    // ==================================================

    let state =
        'RANGE';


    // ==================================================
    // PROTECTED LEVELS
    // ==================================================

    let protectedHigh =
        null;

    let protectedLow =
        null;


    // ==================================================
    // CANDIDATE PROTECTED LEVELS
    // ==================================================

    let candidateHL =
        null;

    let candidateLH =
        null;


    // ==================================================
    // BOS REFERENCES
    // ==================================================

    let continuationHigh =
        null;

    let continuationLow =
        null;


    // ==================================================
    // LAST STRUCTURAL SWINGS
    // ==================================================

    let latestSwingHigh =
        null;

    let latestSwingLow =
        null;


    // ==================================================
    // PREVIOUS STRUCTURAL HIGH / LOW
    // ==================================================

    let previousStructuralHigh =
        null;

    let previousStructuralLow =
        null;


    // ==================================================
    // PENDING STRUCTURAL SWING
    // ==================================================

    let pendingStructuralSwing =
        null;


    // ==================================================
    // HISTORY
    // ==================================================

    const structuralSwings = [];

    const classifiedSwings = [];

    const structureEvents = [];


    let localPointer =
        0;


    // ==================================================
    // ADD STRUCTURAL POINT
    // ==================================================

    function addStructuralPoint(
        point,
        structuralConfirmedIndex,
        structuralConfirmedDatetime
    ) {
        const structuralPoint = {
            ...point,

            structuralConfirmedIndex,

            structuralConfirmedDatetime
        };


        // ==============================================
        // CLASSIFICATION
        // ==============================================

        let structure =
            'INITIAL';


        // ==============================================
        // HIGH
        // ==============================================

        if (
            structuralPoint.type ===
            'HIGH'
        ) {
            if (
                previousStructuralHigh
            ) {
                structure =
                    structuralPoint.price >
                    previousStructuralHigh
                    .price

                    ?
                    'HH' :
                    'LH';
            }


            previousStructuralHigh = {
                ...structuralPoint
            };
        }


        // ==============================================
        // LOW
        // ==============================================
        else if (
            structuralPoint.type ===
            'LOW'
        ) {
            if (
                previousStructuralLow
            ) {
                structure =
                    structuralPoint.price >
                    previousStructuralLow
                    .price

                    ?
                    'HL' :
                    'LL';
            }


            previousStructuralLow = {
                ...structuralPoint
            };
        }


        const classifiedPoint = {
            ...structuralPoint,

            structure
        };


        // ==============================================
        // SAVE
        // ==============================================

        structuralSwings.push({
            ...structuralPoint
        });


        classifiedSwings.push({
            ...classifiedPoint
        });


        // ==============================================
        // UPDATE LATEST HIGH / LOW
        // ==============================================

        if (
            classifiedPoint.type ===
            'HIGH'
        ) {
            latestSwingHigh = {
                ...classifiedPoint
            };
        }


        if (
            classifiedPoint.type ===
            'LOW'
        ) {
            latestSwingLow = {
                ...classifiedPoint
            };
        }


        // ==============================================
        // HL CANDIDATE
        // ==============================================

        if (
            structure ===
            'HL'
        ) {
            candidateHL = {
                ...classifiedPoint
            };
        }


        // ==============================================
        // LH CANDIDATE
        // ==============================================

        if (
            structure ===
            'LH'
        ) {
            candidateLH = {
                ...classifiedPoint
            };
        }


        // ==============================================
        // HH CONFIRMS PROTECTED LOW
        // ==============================================

        if (
            structure ===
            'HH' &&
            candidateHL &&
            candidateHL.index <
            classifiedPoint.index
        ) {
            protectedLow = {
                ...candidateHL
            };


            candidateHL =
                null;
        }


        // ==============================================
        // LL CONFIRMS PROTECTED HIGH
        // ==============================================

        if (
            structure ===
            'LL' &&
            candidateLH &&
            candidateLH.index <
            classifiedPoint.index
        ) {
            protectedHigh = {
                ...candidateLH
            };


            candidateLH =
                null;
        }


        // ==============================================
        // INITIAL MARKET STATE
        // ==============================================

        if (
            state ===
            'RANGE'
        ) {

            // ==========================================
            // INITIAL BULLISH
            // ==========================================

            if (
                structure ===
                'HH'
            ) {
                state =
                    'BULLISH';


                continuationHigh = {
                    ...classifiedPoint
                };


                continuationLow =
                    null;


                structureEvents.push({
                    type: 'INITIAL_STRUCTURE',

                    direction: 'UP',

                    state: 'BULLISH',

                    candleIndex: structuralConfirmedIndex,

                    datetime: structuralConfirmedDatetime,

                    sourceStructure: structure,

                    sourcePrice: classifiedPoint
                        .price
                });
            }


            // ==========================================
            // INITIAL BEARISH
            // ==========================================
            else if (
                structure ===
                'LL'
            ) {
                state =
                    'BEARISH';


                continuationLow = {
                    ...classifiedPoint
                };


                continuationHigh =
                    null;


                structureEvents.push({
                    type: 'INITIAL_STRUCTURE',

                    direction: 'DOWN',

                    state: 'BEARISH',

                    candleIndex: structuralConfirmedIndex,

                    datetime: structuralConfirmedDatetime,

                    sourceStructure: structure,

                    sourcePrice: classifiedPoint
                        .price
                });
            }
        }


        // ==============================================
        // BULLISH CONTINUATION HIGH
        // ==============================================

        if (
            state ===
            'BULLISH' &&
            classifiedPoint.type ===
            'HIGH'
        ) {
            continuationHigh = {
                ...classifiedPoint
            };
        }


        // ==============================================
        // BEARISH CONTINUATION LOW
        // ==============================================

        if (
            state ===
            'BEARISH' &&
            classifiedPoint.type ===
            'LOW'
        ) {
            continuationLow = {
                ...classifiedPoint
            };
        }
    }
    // ==================================================
    // PROCESS LOCAL SWING ONLINE
    //
    // Structural point becomes usable only after
    // a significant opposite swing is confirmed.
    // ==================================================

    function processLocalSwing(
        point,
        candleIndex
    ) {
        if (!pendingStructuralSwing) {
            pendingStructuralSwing = {
                ...point
            };

            return;
        }


        // ==============================================
        // SAME TYPE
        //
        // HIGH + HIGH -> keep higher HIGH
        // LOW  + LOW  -> keep lower LOW
        // ==============================================

        if (
            point.type ===
            pendingStructuralSwing.type
        ) {
            if (
                point.type ===
                'HIGH' &&
                point.price >
                pendingStructuralSwing
                .price
            ) {
                pendingStructuralSwing = {
                    ...point
                };
            }


            if (
                point.type ===
                'LOW' &&
                point.price <
                pendingStructuralSwing
                .price
            ) {
                pendingStructuralSwing = {
                    ...point
                };
            }


            return;
        }


        // ==============================================
        // OPPOSITE SWING
        // ==============================================

        const movement =
            Math.abs(
                point.price -
                pendingStructuralSwing
                .price
            );


        // ==============================================
        // MARKET NOISE FILTER
        // ==============================================

        if (
            movement <
            sensitivity
        ) {
            return;
        }


        /*
            pendingStructuralSwing becomes
            structural only now.

            This protects the backtest from
            using future information.
        */

        addStructuralPoint(
            pendingStructuralSwing,
            candleIndex,
            candles[
                candleIndex
            ] ?
            candles[
                candleIndex
            ].datetime :
            null
        );


        pendingStructuralSwing = {
            ...point
        };
    }


    // ==================================================
    // PROCESS MARKET CHRONOLOGICALLY
    // ==================================================

    for (
        let candleIndex = 0; candleIndex <
        candles.length; candleIndex++
    ) {

        // ==============================================
        // ACTIVATE CONFIRMED LOCAL SWINGS
        // ==============================================

        while (
            localPointer <
            mergedLocal.length &&
            mergedLocal[
                localPointer
            ].confirmedIndex <=
            candleIndex
        ) {
            processLocalSwing(
                mergedLocal[
                    localPointer
                ],
                candleIndex
            );

            localPointer++;
        }


        // ==============================================
        // NO STRUCTURE YET
        // ==============================================

        if (
            state ===
            'RANGE'
        ) {
            continue;
        }


        const close =
            num(
                candles[
                    candleIndex
                ].close
            );


        // ==================================================
        // BULLISH STATE
        // ==================================================

        if (
            state ===
            'BULLISH'
        ) {

            // ==============================================
            // CHoCH DOWN
            //
            // Bullish structure changes only when
            // CLOSE breaks the Protected Low.
            // ==============================================

            if (
                protectedLow &&
                candleIndex >
                protectedLow
                .structuralConfirmedIndex &&
                close <
                protectedLow.price
            ) {
                const brokenLevel = {
                    ...protectedLow
                };


                structureEvents.push({
                    type: 'CHOCH',

                    direction: 'DOWN',

                    fromState: 'BULLISH',

                    toState: 'BEARISH',

                    candleIndex,

                    datetime: candles[
                        candleIndex
                    ].datetime,

                    close,

                    brokenLevel: brokenLevel.price,

                    brokenSwingIndex: brokenLevel.index,

                    brokenStructure: brokenLevel.structure
                });


                state =
                    'BEARISH';


                /*
                    After bearish CHoCH,
                    the last structural HIGH becomes
                    the new bearish protected high.
                */

                protectedHigh =
                    latestSwingHigh ?
                    {
                        ...latestSwingHigh
                    } :
                    protectedHigh;


                protectedLow =
                    null;


                candidateHL =
                    null;


                continuationHigh =
                    null;


                /*
                    Last structural LOW becomes
                    the next possible continuation level.
                */

                continuationLow =
                    latestSwingLow ?
                    {
                        ...latestSwingLow
                    } :
                    null;


                continue;
            }


            // ==============================================
            // BOS UP
            //
            // BOS confirms continuation.
            // It does NOT change the state.
            // ==============================================

            if (
                continuationHigh &&
                candleIndex >
                continuationHigh
                .structuralConfirmedIndex &&
                close >
                continuationHigh.price
            ) {
                const brokenLevel = {
                    ...continuationHigh
                };


                structureEvents.push({
                    type: 'BOS',

                    direction: 'UP',

                    state: 'BULLISH',

                    candleIndex,

                    datetime: candles[
                        candleIndex
                    ].datetime,

                    close,

                    brokenLevel: brokenLevel.price,

                    brokenSwingIndex: brokenLevel.index,

                    brokenStructure: brokenLevel.structure
                });


                /*
                    If a confirmed HL exists before BOS,
                    this HL becomes the new Protected Low.
                */

                if (
                    candidateHL &&
                    candidateHL.index <
                    candleIndex
                ) {
                    protectedLow = {
                        ...candidateHL
                    };


                    candidateHL =
                        null;
                }


                /*
                    The level is already broken.
                    Do not generate BOS repeatedly.
                */

                continuationHigh =
                    null;


                continue;
            }
        }


        // ==================================================
        // BEARISH STATE
        // ==================================================

        if (
            state ===
            'BEARISH'
        ) {

            // ==============================================
            // CHoCH UP
            //
            // Bearish structure changes only when
            // CLOSE breaks the Protected High.
            // ==============================================

            if (
                protectedHigh &&
                candleIndex >
                protectedHigh
                .structuralConfirmedIndex &&
                close >
                protectedHigh.price
            ) {
                const brokenLevel = {
                    ...protectedHigh
                };


                structureEvents.push({
                    type: 'CHOCH',

                    direction: 'UP',

                    fromState: 'BEARISH',

                    toState: 'BULLISH',

                    candleIndex,

                    datetime: candles[
                        candleIndex
                    ].datetime,

                    close,

                    brokenLevel: brokenLevel.price,

                    brokenSwingIndex: brokenLevel.index,

                    brokenStructure: brokenLevel.structure
                });


                state =
                    'BULLISH';


                /*
                    Last structural LOW becomes
                    protection of the new bullish state.
                */

                protectedLow =
                    latestSwingLow ?
                    {
                        ...latestSwingLow
                    } :
                    protectedLow;


                protectedHigh =
                    null;


                candidateLH =
                    null;


                continuationLow =
                    null;


                /*
                    Last structural HIGH may become
                    the next BOS UP level.
                */

                continuationHigh =
                    latestSwingHigh ?
                    {
                        ...latestSwingHigh
                    } :
                    null;


                continue;
            }


            // ==============================================
            // BOS DOWN
            //
            // Bearish continuation.
            // ==============================================

            if (
                continuationLow &&
                candleIndex >
                continuationLow
                .structuralConfirmedIndex &&
                close <
                continuationLow.price
            ) {
                const brokenLevel = {
                    ...continuationLow
                };


                structureEvents.push({
                    type: 'BOS',

                    direction: 'DOWN',

                    state: 'BEARISH',

                    candleIndex,

                    datetime: candles[
                        candleIndex
                    ].datetime,

                    close,

                    brokenLevel: brokenLevel.price,

                    brokenSwingIndex: brokenLevel.index,

                    brokenStructure: brokenLevel.structure
                });


                /*
                    LH before continuation becomes
                    the new Protected High.
                */

                if (
                    candidateLH &&
                    candidateLH.index <
                    candleIndex
                ) {
                    protectedHigh = {
                        ...candidateLH
                    };


                    candidateLH =
                        null;
                }


                /*
                    This LOW is already broken.
                */

                continuationLow =
                    null;


                continue;
            }
        }
    }


    // ==================================================
    // LAST EVENT
    // ==================================================

    const latestIndex =
        candles.length - 1;


    const lastStructureEvent =
        structureEvents.length ?
        structureEvents[
            structureEvents.length - 1
        ] :
        null;


    // ==================================================
    // CURRENT BOS
    //
    // Important:
    // an old BOS must not keep adding score forever.
    // ==================================================

    const currentBosEvent =
        lastStructureEvent &&
        lastStructureEvent.type ===
        'BOS' &&
        lastStructureEvent.candleIndex ===
        latestIndex ?
        lastStructureEvent :
        null;


    // ==================================================
    // CURRENT CHoCH
    // ==================================================

    const currentChochEvent =
        lastStructureEvent &&
        lastStructureEvent.type ===
        'CHOCH' &&
        lastStructureEvent.candleIndex ===
        latestIndex ?
        lastStructureEvent :
        null;


    // ==================================================
    // DEBUG STRUCTURAL SWINGS
    // ==================================================

    const debugStructural =
        structuralSwings
        .slice(-12)
        .map(
            point => ({
                index: point.index,

                confirmedIndex: point.confirmedIndex,

                structuralConfirmedIndex: point
                    .structuralConfirmedIndex,

                datetime: point.datetime,

                type: point.type,

                price: point.price
            })
        );


    // ==================================================
    // DEBUG CLASSIFIED SWINGS
    // ==================================================

    const debugClassified =
        classifiedSwings
        .slice(-12)
        .map(
            point => ({
                datetime: point.datetime,

                type: point.type,

                price: point.price,

                structure: point.structure,

                index: point.index,

                confirmedIndex: point.confirmedIndex,

                structuralConfirmedIndex: point
                    .structuralConfirmedIndex
            })
        );


    // ==================================================
    // RETURN
    // ==================================================

    return {

        // ==============================================
        // BACKWARD COMPATIBILITY
        // ==============================================

        trend: state,

        state,


        bos: Boolean(
            currentBosEvent
        ),

        bosDirection: currentBosEvent ?
            currentBosEvent
            .direction :
            null,


        choch: Boolean(
            currentChochEvent
        ),

        chochDirection: currentChochEvent ?
            currentChochEvent
            .direction :
            null,


        swingHigh: latestSwingHigh ?
            latestSwingHigh
            .price :
            null,

        swingLow: latestSwingLow ?
            latestSwingLow
            .price :
            null,


        // ==============================================
        // PROTECTED HIGH
        // ==============================================

        protectedHigh: protectedHigh ?
            {
                price: protectedHigh
                    .price,

                index: protectedHigh
                    .index,

                datetime: protectedHigh
                    .datetime,

                confirmedIndex: protectedHigh
                    .confirmedIndex,

                confirmedDatetime: protectedHigh
                    .confirmedDatetime,

                structuralConfirmedIndex: protectedHigh
                    .structuralConfirmedIndex,

                structuralConfirmedDatetime: protectedHigh
                    .structuralConfirmedDatetime,

                structure: protectedHigh
                    .structure
            } :
            null,


        // ==============================================
        // PROTECTED LOW
        // ==============================================

        protectedLow: protectedLow ?
            {
                price: protectedLow
                    .price,

                index: protectedLow
                    .index,

                datetime: protectedLow
                    .datetime,

                confirmedIndex: protectedLow
                    .confirmedIndex,

                confirmedDatetime: protectedLow
                    .confirmedDatetime,

                structuralConfirmedIndex: protectedLow
                    .structuralConfirmedIndex,

                structuralConfirmedDatetime: protectedLow
                    .structuralConfirmedDatetime,

                structure: protectedLow
                    .structure
            } :
            null,


        // ==============================================
        // NEXT BOS LEVELS
        // ==============================================

        continuationHigh: continuationHigh ?
            {
                price: continuationHigh
                    .price,

                index: continuationHigh
                    .index,

                datetime: continuationHigh
                    .datetime,

                structure: continuationHigh
                    .structure,

                structuralConfirmedIndex: continuationHigh
                    .structuralConfirmedIndex
            } :
            null,


        continuationLow: continuationLow ?
            {
                price: continuationLow
                    .price,

                index: continuationLow
                    .index,

                datetime: continuationLow
                    .datetime,

                structure: continuationLow
                    .structure,

                structuralConfirmedIndex: continuationLow
                    .structuralConfirmedIndex
            } :
            null,


        // ==============================================
        // LAST STRUCTURAL SWINGS
        // ==============================================

        lastSwingHigh: latestSwingHigh ?
            {
                ...latestSwingHigh
            } :
            null,


        lastSwingLow: latestSwingLow ?
            {
                ...latestSwingLow
            } :
            null,


        // ==============================================
        // STRUCTURE EVENTS
        // ==============================================

        lastStructureEvent,

        recentStructureEvents: structureEvents
            .slice(-10),

        structureEventCount: structureEvents.length,


        // ==============================================
        // STRUCTURAL DEBUG
        // ==============================================

        structuralSwings: debugStructural,

        classifiedSwings: debugClassified,


        // ==============================================
        // CURRENT UNCONFIRMED STRUCTURAL SWING
        // ==============================================

        pendingStructuralSwing: pendingStructuralSwing ?
            {
                type: pendingStructuralSwing
                    .type,

                price: pendingStructuralSwing
                    .price,

                index: pendingStructuralSwing
                    .index,

                confirmedIndex: pendingStructuralSwing
                    .confirmedIndex,

                datetime: pendingStructuralSwing
                    .datetime,

                confirmedDatetime: pendingStructuralSwing
                    .confirmedDatetime
            } :
            null,


        // ==============================================
        // SETTINGS
        // ==============================================

        sensitivityPoints: STRUCTURE_SENSITIVITY_POINTS,

        pointSize,

        sensitivity,


        // ==============================================
        // LOOK-AHEAD AUDIT
        // ==============================================

        antiLookAhead: {
            localSwingUsesConfirmedIndex: true,

            structuralSwingRequiresOppositeConfirmation: true,

            protectedLevelsUseStructuralConfirmation: true
        }
    };
}
// ======================================================
// ADVANCED IMBALANCE / FVG
// ======================================================

function detectImbalances(
    candles,
    lookback = 120,
    metadata = {}
) {
    if (!Array.isArray(candles) ||
        candles.length < 5
    ) {
        return {
            bullish: [],
            bearish: [],
            activeBullish: [],
            activeBearish: [],
            nearestBullish: null,
            nearestBearish: null,
            currentInsideBullish: false,
            currentInsideBearish: false
        };
    }


    const start =
        Math.max(
            2,
            candles.length -
            lookback
        );


    const zones = [];


    const atrValue =
        atr(
            candles,
            14
        ) || 0;


    for (
        let i = start; i < candles.length; i++
    ) {
        const candle1 =
            candles[
                i - 2
            ];

        const candle3 =
            candles[i];


        const high1 =
            num(
                candle1.high
            );

        const low1 =
            num(
                candle1.low
            );

        const high3 =
            num(
                candle3.high
            );

        const low3 =
            num(
                candle3.low
            );


        // ==================================================
        // BULLISH FVG
        //
        // candle3.low > candle1.high
        // ==================================================

        if (
            low3 >
            high1
        ) {
            const zoneLow =
                high1;

            const zoneHigh =
                low3;

            const size =
                zoneHigh -
                zoneLow;


            zones.push({
                type: 'BULLISH',

                fvgId: makeCanonicalFvgId(
                    metadata.symbol,
                    'UP',
                    metadata.timeframe,
                    candle3.datetime
                ),

                createdIndex: i,

                datetime: candle3.datetime,

                zoneLow,

                zoneHigh,

                size,

                atrRatio: atrValue ?
                    size /
                    atrValue :
                    0
            });
        }


        // ==================================================
        // BEARISH FVG
        //
        // candle3.high < candle1.low
        // ==================================================

        if (
            high3 <
            low1
        ) {
            const zoneLow =
                high3;

            const zoneHigh =
                low1;

            const size =
                zoneHigh -
                zoneLow;


            zones.push({
                type: 'BEARISH',

                fvgId: makeCanonicalFvgId(
                    metadata.symbol,
                    'DOWN',
                    metadata.timeframe,
                    candle3.datetime
                ),

                createdIndex: i,

                datetime: candle3.datetime,

                zoneLow,

                zoneHigh,

                size,

                atrRatio: atrValue ?
                    size /
                    atrValue :
                    0
            });
        }
    }


    // ==================================================
    // MITIGATION / FILL
    // ==================================================

    for (
        const zone
        of zones
    ) {
        zone.status =
            'UNTOUCHED';

        zone.mitigated =
            false;

        zone.filled =
            false;

        zone.firstTouchIndex =
            null;

        zone.touchCount =
            0;


        for (
            let i =
                zone.createdIndex + 1; i < candles.length; i++
        ) {
            const candle =
                candles[i];


            const high =
                num(
                    candle.high
                );

            const low =
                num(
                    candle.low
                );


            // ==============================================
            // BULLISH FVG
            // ==============================================

            if (
                zone.type ===
                'BULLISH'
            ) {
                const touched =
                    low <=
                    zone.zoneHigh;


                if (
                    touched
                ) {
                    zone.touchCount++;


                    if (
                        zone.firstTouchIndex ===
                        null
                    ) {
                        zone.firstTouchIndex =
                            i;
                    }
                }


                if (
                    low <=
                    zone.zoneLow
                ) {
                    zone.filled =
                        true;

                    zone.mitigated =
                        true;

                    zone.status =
                        'FILLED';

                    break;
                }


                if (
                    touched
                ) {
                    zone.mitigated =
                        true;

                    zone.status =
                        'MITIGATED';
                }
            }


            // ==============================================
            // BEARISH FVG
            // ==============================================

            if (
                zone.type ===
                'BEARISH'
            ) {
                const touched =
                    high >=
                    zone.zoneLow;


                if (
                    touched
                ) {
                    zone.touchCount++;


                    if (
                        zone.firstTouchIndex ===
                        null
                    ) {
                        zone.firstTouchIndex =
                            i;
                    }
                }


                if (
                    high >=
                    zone.zoneHigh
                ) {
                    zone.filled =
                        true;

                    zone.mitigated =
                        true;

                    zone.status =
                        'FILLED';

                    break;
                }


                if (
                    touched
                ) {
                    zone.mitigated =
                        true;

                    zone.status =
                        'MITIGATED';
                }
            }
        }
    }


    // ==================================================
    // GROUP ZONES
    // ==================================================

    const bullish =
        zones.filter(
            zone =>
            zone.type ===
            'BULLISH'
        );


    const bearish =
        zones.filter(
            zone =>
            zone.type ===
            'BEARISH'
        );


    const activeBullish =
        bullish.filter(
            zone =>
            !zone.filled
        );


    const activeBearish =
        bearish.filter(
            zone =>
            !zone.filled
        );


    // ==================================================
    // CURRENT PRICE
    // ==================================================

    const latest =
        candles[
            candles.length - 1
        ];


    const currentPrice =
        num(
            latest.close
        );


    // ==================================================
    // DISTANCE TO ZONE
    // ==================================================

    function distanceToZone(
        zone
    ) {
        if (
            currentPrice >=
            zone.zoneLow &&
            currentPrice <=
            zone.zoneHigh
        ) {
            return 0;
        }


        if (
            currentPrice <
            zone.zoneLow
        ) {
            return (
                zone.zoneLow -
                currentPrice
            );
        }


        return (
            currentPrice -
            zone.zoneHigh
        );
    }


    // ==================================================
    // NEAREST ACTIVE ZONES
    // ==================================================

    const nearestBullish =
        activeBullish
        .slice()
        .sort(
            (
                a,
                b
            ) =>
            distanceToZone(a) -
            distanceToZone(b)
        )[0] ||
        null;


    const nearestBearish =
        activeBearish
        .slice()
        .sort(
            (
                a,
                b
            ) =>
            distanceToZone(a) -
            distanceToZone(b)
        )[0] ||
        null;


    const currentInsideBullish =
        activeBullish.some(
            zone =>
            currentPrice >=
            zone.zoneLow &&
            currentPrice <=
            zone.zoneHigh
        );


    const currentInsideBearish =
        activeBearish.some(
            zone =>
            currentPrice >=
            zone.zoneLow &&
            currentPrice <=
            zone.zoneHigh
        );


    return {
        bullish,

        bearish,

        activeBullish,

        activeBearish,

        nearestBullish,

        nearestBearish,

        currentInsideBullish,

        currentInsideBearish
    };
}


// ======================================================
// FVG COMPATIBILITY
// ======================================================

function detectFVG(
    candles
) {
    const imbalance =
        detectImbalances(
            candles
        );


    return {
        bullish: imbalance
            .activeBullish
            .length >
            0,

        bearish: imbalance
            .activeBearish
            .length >
            0,


        bullishZone: imbalance
            .nearestBullish ?
            {
                from: imbalance
                    .nearestBullish
                    .zoneLow,

                to: imbalance
                    .nearestBullish
                    .zoneHigh,

                status: imbalance
                    .nearestBullish
                    .status,

                touchCount: imbalance
                    .nearestBullish
                    .touchCount
            } :
            null,


        bearishZone: imbalance
            .nearestBearish ?
            {
                from: imbalance
                    .nearestBearish
                    .zoneLow,

                to: imbalance
                    .nearestBearish
                    .zoneHigh,

                status: imbalance
                    .nearestBearish
                    .status,

                touchCount: imbalance
                    .nearestBearish
                    .touchCount
            } :
            null
    };
}


// ======================================================
// EQUAL HIGHS / LOWS
// ======================================================

function detectEqualLevels(
    candles
) {
    if (!Array.isArray(candles) ||
        candles.length <
        20
    ) {
        return {
            equalHighs: false,

            equalLows: false
        };
    }


    const recent =
        candles.slice(-30);


    const atrValue =
        atr(
            recent,
            14
        );


    const tolerance =
        atrValue ?
        atrValue *
        0.15 :
        Math.abs(
            num(
                recent[
                    recent.length - 1
                ].close
            )
        ) *
        0.00015;


    const swings =
        findSwings(
            recent,
            2,
            2
        );


    const highs =
        swings
        .highs
        .slice(-3);


    const lows =
        swings
        .lows
        .slice(-3);


    return {
        equalHighs: highs.length >=
            2 &&
            Math.abs(
                highs[
                    highs.length - 1
                ].price -
                highs[
                    highs.length - 2
                ].price
            ) <=
            tolerance,


        equalLows: lows.length >=
            2 &&
            Math.abs(
                lows[
                    lows.length - 1
                ].price -
                lows[
                    lows.length - 2
                ].price
            ) <=
            tolerance
    };
}


// ======================================================
// LIQUIDITY SWEEP
// ======================================================

function detectLiquiditySweep(
    candles
) {
    if (!Array.isArray(candles) ||
        candles.length <
        20
    ) {
        return {
            bullishSweep: false,

            bearishSweep: false,

            sweptHigh: null,

            sweptLow: null
        };
    }


    const previous =
        candles.slice(-20, -1);


    const latest =
        candles[
            candles.length - 1
        ];


    const previousHigh =
        Math.max(
            ...previous.map(
                candle =>
                num(
                    candle.high
                )
            )
        );


    const previousLow =
        Math.min(
            ...previous.map(
                candle =>
                num(
                    candle.low
                )
            )
        );


    return {
        /*
            Sell-side liquidity sweep.

            Цена проколола previousLow,
            но закрылась обратно выше.
        */

        bullishSweep: num(
                latest.low
            ) <
            previousLow &&
            num(
                latest.close
            ) >
            previousLow,


        /*
            Buy-side liquidity sweep.

            Цена проколола previousHigh,
            но закрылась обратно ниже.
        */

        bearishSweep: num(
                latest.high
            ) >
            previousHigh &&
            num(
                latest.close
            ) <
            previousHigh,


        sweptHigh: previousHigh,

        sweptLow: previousLow
    };
}


// ======================================================
// DISPLACEMENT
// ======================================================

function detectDisplacement(
    candles
) {
    if (!Array.isArray(candles) ||
        candles.length <
        20
    ) {
        return {
            bullish: false,

            bearish: false,

            ratio: 0
        };
    }


    const latest =
        candles[
            candles.length - 1
        ];


    const atrValue =
        atr(
            candles,
            14
        );


    if (!atrValue) {
        return {
            bullish: false,

            bearish: false,

            ratio: 0
        };
    }


    const stats =
        candleStats(
            latest
        );


    const ratio =
        (
            num(
                latest.high
            ) -
            num(
                latest.low
            )
        ) /
        atrValue;


    return {
        bullish: stats.bullish &&
            stats.bodyRatio >=
            0.65 &&
            ratio >=
            1.3,


        bearish: stats.bearish &&
            stats.bodyRatio >=
            0.65 &&
            ratio >=
            1.3,


        ratio
    };
}


// ======================================================
// ORDER BLOCK
// ======================================================

function detectOrderBlock(
    candles
) {
    if (!Array.isArray(candles) ||
        candles.length <
        10
    ) {
        return {
            bullish: null,

            bearish: null
        };
    }


    const recent =
        candles.slice(-10);


    const displacement =
        detectDisplacement(
            recent
        );


    let bullish =
        null;

    let bearish =
        null;


    // ==================================================
    // BULLISH ORDER BLOCK
    //
    // Последняя bearish candle перед bullish displacement.
    // ==================================================

    if (
        displacement.bullish
    ) {
        for (
            let i =
                recent.length - 2; i >= 0; i--
        ) {
            if (
                num(
                    recent[i].close
                ) <
                num(
                    recent[i].open
                )
            ) {
                bullish = {
                    from: num(
                        recent[i].low
                    ),

                    to: num(
                        recent[i].high
                    ),

                    datetime: recent[i]
                        .datetime
                };


                break;
            }
        }
    }


    // ==================================================
    // BEARISH ORDER BLOCK
    //
    // Последняя bullish candle перед bearish displacement.
    // ==================================================

    if (
        displacement.bearish
    ) {
        for (
            let i =
                recent.length - 2; i >= 0; i--
        ) {
            if (
                num(
                    recent[i].close
                ) >
                num(
                    recent[i].open
                )
            ) {
                bearish = {
                    from: num(
                        recent[i].low
                    ),

                    to: num(
                        recent[i].high
                    ),

                    datetime: recent[i]
                        .datetime
                };


                break;
            }
        }
    }


    return {
        bullish,

        bearish
    };
}


// ======================================================
// PREMIUM / DISCOUNT
// ======================================================

function premiumDiscount(
    candles
) {
    if (!Array.isArray(candles) ||
        candles.length <
        20
    ) {
        return {
            zone: 'UNKNOWN',

            equilibrium: null,

            rangeHigh: null,

            rangeLow: null
        };
    }


    const recent =
        candles.slice(-50);


    const high =
        Math.max(
            ...recent.map(
                candle =>
                num(
                    candle.high
                )
            )
        );


    const low =
        Math.min(
            ...recent.map(
                candle =>
                num(
                    candle.low
                )
            )
        );


    const equilibrium =
        (
            high +
            low
        ) /
        2;


    const price =
        num(
            recent[
                recent.length - 1
            ].close
        );


    let zone =
        'EQUILIBRIUM';


    if (
        price >
        equilibrium
    ) {
        zone =
            'PREMIUM';
    }


    if (
        price <
        equilibrium
    ) {
        zone =
            'DISCOUNT';
    }


    return {
        zone,

        equilibrium,

        rangeHigh: high,

        rangeLow: low
    };
}


// ======================================================
// COMPLETE SMC ANALYSIS
// ======================================================

function analyzeSMC(
    candles,
    metadata = {}
) {
    const structure =
        detectStructure(
            candles
        );


    const imbalances =
        detectImbalances(
            candles,
            120,
            metadata
        );


    const fvg =
        detectFVG(
            candles
        );


    const liquiditySweep =
        detectLiquiditySweep(
            candles
        );


    const equalLevels =
        detectEqualLevels(
            candles
        );


    const displacement =
        detectDisplacement(
            candles
        );


    const orderBlock =
        detectOrderBlock(
            candles
        );


    const premium =
        premiumDiscount(
            candles
        );


    let up =
        0;

    let down =
        0;


    const reasons = [];


    // ==================================================
    // MARKET STRUCTURE
    // ==================================================

    if (
        structure.trend ===
        'BULLISH'
    ) {
        up +=
            20;


        reasons.push(
            'Bullish structure'
        );
    }


    if (
        structure.trend ===
        'BEARISH'
    ) {
        down +=
            20;


        reasons.push(
            'Bearish structure'
        );
    }


    // ==================================================
    // BOS
    //
    // Only current-candle BOS is exposed by
    // detectStructure(), so old BOS cannot keep
    // adding points forever.
    // ==================================================

    if (
        structure.bosDirection ===
        'UP'
    ) {
        up +=
            20;


        reasons.push(
            'BOS UP'
        );
    }


    if (
        structure.bosDirection ===
        'DOWN'
    ) {
        down +=
            20;


        reasons.push(
            'BOS DOWN'
        );
    }


    // ==================================================
    // CHoCH
    // ==================================================

    if (
        structure.chochDirection ===
        'UP'
    ) {
        up +=
            20;


        reasons.push(
            'CHoCH UP'
        );
    }


    if (
        structure.chochDirection ===
        'DOWN'
    ) {
        down +=
            20;


        reasons.push(
            'CHoCH DOWN'
        );
    }


    // ==================================================
    // FVG
    // ==================================================

    if (
        fvg.bullish
    ) {
        up +=
            10;


        reasons.push(
            'Bullish FVG'
        );
    }


    if (
        fvg.bearish
    ) {
        down +=
            10;


        reasons.push(
            'Bearish FVG'
        );
    }


    // ==================================================
    // LIQUIDITY SWEEP
    // ==================================================

    if (
        liquiditySweep
        .bullishSweep
    ) {
        up +=
            15;


        reasons.push(
            'Sell-side liquidity sweep'
        );
    }


    if (
        liquiditySweep
        .bearishSweep
    ) {
        down +=
            15;


        reasons.push(
            'Buy-side liquidity sweep'
        );
    }


    // ==================================================
    // DISPLACEMENT
    // ==================================================

    if (
        displacement.bullish
    ) {
        up +=
            10;


        reasons.push(
            'Bullish displacement'
        );
    }


    if (
        displacement.bearish
    ) {
        down +=
            10;


        reasons.push(
            'Bearish displacement'
        );
    }


    // ==================================================
    // ORDER BLOCK
    // ==================================================

    if (
        orderBlock.bullish
    ) {
        up +=
            10;


        reasons.push(
            'Bullish order block'
        );
    }


    if (
        orderBlock.bearish
    ) {
        down +=
            10;


        reasons.push(
            'Bearish order block'
        );
    }


    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    return {
        scoreUp: clamp(
            up,
            0,
            100
        ),


        scoreDown: clamp(
            down,
            0,
            100
        ),


        structure,

        imbalances,

        fvg,

        liquiditySweep,

        equalLevels,

        displacement,

        orderBlock,

        premiumDiscount: premium,

        reasons
    };
}


// ======================================================
// EXPORTS
// ======================================================


function normalizeFvgDatetime(value) {
    if (!value) return null;
    return String(value).trim().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function makeCanonicalFvgId(symbol, direction, timeframe, formationDatetime) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const normalizedDirection = String(direction || '').toUpperCase();
    const normalizedTimeframe = String(timeframe || '').toUpperCase();
    const formed = normalizeFvgDatetime(formationDatetime);
    if (!normalizedSymbol || !normalizedDirection || !normalizedTimeframe || !formed) return null;
    const seed = [normalizedSymbol, normalizedDirection, normalizedTimeframe, formed].join('|');
    const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
    return `${normalizedSymbol.replace('/', '')}-${normalizedDirection}-${normalizedTimeframe}-${hash}`;
}

module.exports = {
    makeCanonicalFvgId,
    findSwings,

    mergeSwings,

    buildStructuralSwings,

    classifyStructure,

    getStructureLevels,

    detectStructure,

    detectImbalances,

    detectFVG,

    detectEqualLevels,

    detectLiquiditySweep,

    detectDisplacement,

    detectOrderBlock,

    premiumDiscount,

    analyzeSMC
};