const { num, clamp } = require('./utils');

function stats(c) {
    const open=num(c&&c.open), high=num(c&&c.high), low=num(c&&c.low), close=num(c&&c.close);
    const range=Math.max(high-low,0), body=Math.abs(close-open);
    return {
        open,high,low,close,
        bullish:close>open, bearish:close<open,
        bodyRatio:range?body/range:0,
        upperWickRatio:range?Math.max(0,high-Math.max(open,close))/range:0,
        lowerWickRatio:range?Math.max(0,Math.min(open,close)-low)/range:0
    };
}

function analyzeTf(candles,direction,timeframe) {
    if (!Array.isArray(candles)||candles.length<4) return {
        timeframe,available:false,confirmed:false,opposite:false,
        expectedScore:0,oppositeScore:0,reasons:['Not enough closed candles'],oppositeReasons:[]
    };
    const a=stats(candles[candles.length-3]);
    const b=stats(candles[candles.length-2]);
    const c=stats(candles[candles.length-1]);
    let up=0,down=0; const ur=[],dr=[];
    if(b.bearish&&c.bullish&&c.open<=b.close&&c.close>=b.open){up+=40;ur.push('Bullish engulfing');}
    if(b.bullish&&c.bearish&&c.open>=b.close&&c.close<=b.open){down+=40;dr.push('Bearish engulfing');}
    if(c.lowerWickRatio>=.50&&c.bodyRatio<=.40){up+=30;ur.push('Bullish rejection wick');}
    if(c.upperWickRatio>=.50&&c.bodyRatio<=.40){down+=30;dr.push('Bearish rejection wick');}
    if(c.bullish&&c.bodyRatio>=.55){up+=25;ur.push('Strong bullish close');}
    if(c.bearish&&c.bodyRatio>=.55){down+=25;dr.push('Strong bearish close');}
    if(b.bullish&&c.bullish&&c.close>b.close){up+=20;ur.push('Two-candle bullish follow-through');}
    if(b.bearish&&c.bearish&&c.close<b.close){down+=20;dr.push('Two-candle bearish follow-through');}
    if(a.close<b.close&&b.close<c.close){up+=15;ur.push('Three-candle rising closes');}
    if(a.close>b.close&&b.close>c.close){down+=15;dr.push('Three-candle falling closes');}
    up=clamp(up,0,100); down=clamp(down,0,100);
    const es=direction==='UP'?up:down, os=direction==='UP'?down:up;
    return {
        timeframe,available:true,expectedScore:es,oppositeScore:os,
        confirmed:es>=25&&es>os, opposite:os>=40&&os>es,
        reasons:direction==='UP'?ur:dr, oppositeReasons:direction==='UP'?dr:ur
    };
}

function analyzeCandleConfirmation({signal,m1,m3,m5}) {
    if(signal!=='UP'&&signal!=='DOWN') return {
        status:'NOT APPLICABLE',confirmed:false,hardOpposite:false,direction:signal||'NO SIGNAL',
        score:0,oppositeScore:0,reason:'No directional market signal',usesClosedCandles:true
    };
    const one=analyzeTf(m1,signal,'1M'), three=analyzeTf(m3,signal,'3M'), five=analyzeTf(m5,signal,'5M');
    const score=Math.round(one.expectedScore*.40+three.expectedScore*.60);
    const oppositeScore=Math.round(one.oppositeScore*.40+three.oppositeScore*.60);
    const hardOpposite=three.opposite===true&&oppositeScore>=40;
    const confirmed=!hardOpposite&&(three.confirmed===true||(one.confirmed===true&&three.opposite!==true&&score>=25));
    return {
        status:hardOpposite?'OPPOSITE CANDLE':confirmed?'CONFIRMED':'WAIT FOR CANDLE',
        confirmed,hardOpposite,direction:signal,score:clamp(score,0,100),
        oppositeScore:clamp(oppositeScore,0,100),
        reason:hardOpposite?`Closed 3M candle action confirms the opposite direction (${oppositeScore}/100)`:
            confirmed?`Closed-candle confirmation supports ${signal} (${score}/100)`:
            `Waiting for ${signal==='UP'?'bullish':'bearish'} closed-candle confirmation on 1M / 3M`,
        timeframes:{m1:one,m3:three,m5:five},
        alternative5m:{
            observational:true,
            confirmed:five.confirmed===true,
            opposite:five.opposite===true,
            score:five.expectedScore,
            oppositeScore:five.oppositeScore,
            reasons:five.reasons,
            note:'Diagnostic only: 5M does not change the final decision gate'
        },
        usesClosedCandles:true
    };
}
module.exports={analyzeCandleConfirmation};
