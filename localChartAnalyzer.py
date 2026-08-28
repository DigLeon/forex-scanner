import argparse, json, math
from pathlib import Path
import cv2
import numpy as np

WEIGHTS = {'1m': .12, '3m': .14, '5m': .20, '15m': .25, '30m': .29}

def crop(img):
    h, w = img.shape[:2]
    c = img[int(h*.08):int(h*.92), int(w*.04):int(w*.88)]
    return c if c.size else img

def masks(img):
    b,g,r = cv2.split(img)
    green = (g.astype(np.int16) > r.astype(np.int16)+18) & (g.astype(np.int16) > b.astype(np.int16)+8) & (g>65)
    red = (r.astype(np.int16) > g.astype(np.int16)+18) & (r.astype(np.int16) > b.astype(np.int16)+8) & (r>65)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    color = ((green|red) & (hsv[:,:,1]>70) & (hsv[:,:,2]>55)).astype(np.uint8)*255
    color = cv2.morphologyEx(color, cv2.MORPH_OPEN, np.ones((2,2), np.uint8))
    if np.count_nonzero(color)/max(1,color.size) >= .0009:
        return color, green, red, 'COLOR'
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    e = cv2.Canny(gray,70,150)
    e = cv2.subtract(e, cv2.morphologyEx(e, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT,(35,1))))
    e = cv2.subtract(e, cv2.morphologyEx(e, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT,(1,35))))
    return e, green, red, 'EDGE_FALLBACK'

def profile(mask):
    xs=[]; ys=[]
    for x in range(mask.shape[1]):
        rows=np.flatnonzero(mask[:,x]>0)
        if rows.size>=2:
            xs.append(x); ys.append(float(np.median(rows)))
    if len(xs)<max(20,int(mask.shape[1]*.06)): return None
    return np.asarray(xs,float),np.asarray(ys,float)

def analyze(path, tf):
    img=cv2.imread(str(path))
    if img is None: raise RuntimeError(f'Could not read {tf} image')
    img=crop(img); h,w=img.shape[:2]
    mask,green,red,source=masks(img)
    p=profile(mask)
    slope=r2=disp=0.0
    if p is not None:
        xs,ys=p
        a,b=np.polyfit(xs,ys,1); pred=a*xs+b
        ssr=float(np.sum((ys-pred)**2)); sst=float(np.sum((ys-ys.mean())**2))
        r2=max(0,min(1,1-ssr/sst)) if sst>1e-9 else 0
        slope=-float(a)/max(float(h),1)
        n=max(1,len(ys)//3); disp=(float(np.median(ys[:n]))-float(np.median(ys[-n:])))/max(float(h),1)
    gc=int(np.count_nonzero(green)); rc=int(np.count_nonzero(red)); total=gc+rc
    cb=(gc-rc)/total if total else 0.0
    score=.50*np.clip(disp*9,-1,1)+.30*np.clip(slope*220,-1,1)+.20*np.clip(cb,-1,1)
    direction='BULLISH' if score>.16 else 'BEARISH' if score<-.16 else 'NEUTRAL'
    conf=int(round(np.clip(35+abs(disp)*450+r2*25+min(abs(cb),1)*15,25,92)))
    extension='EXTENDED' if abs(disp)>.14 and r2>.28 else 'NORMAL'
    comps=cv2.connectedComponentsWithStats(mask,8)[0]-1
    return {'direction':direction,'confidence':conf,'trendScore':round(float(score),3),
            'displacement':round(float(disp),4),'consistency':round(float(r2),3),
            'colorBias':round(float(cb),3),'componentCount':int(comps),
            'source':source,'extension':extension}

def combine(results,snapshot):
    val={'BULLISH':1,'BEARISH':-1,'NEUTRAL':0}
    weighted=sum(val[r['direction']]*WEIGHTS[tf]*(r['confidence']/100) for tf,r in results.items())
    direction='BULLISH' if weighted>.14 else 'BEARISH' if weighted<-.14 else 'NEUTRAL' if abs(weighted)<.05 else 'MIXED'
    confidence=int(round(sum(r['confidence']*WEIGHTS[tf] for tf,r in results.items())))
    sig=str(snapshot.get('signal') or '').upper(); expected='BULLISH' if sig=='UP' else 'BEARISH' if sig=='DOWN' else None
    alignment='MIXED' if expected is None or direction in ('NEUTRAL','MIXED') else 'AGREES' if direction==expected else 'DISAGREES'
    lower=[results[t]['extension'] for t in ('1m','3m','5m')]
    entry='EXTENDED' if 'EXTENDED' in lower else 'SUPPORTIVE' if alignment=='AGREES' and results['1m']['direction']==expected else 'NEUTRAL' if direction=='NEUTRAL' else 'UNCLEAR'
    warnings=[]
    if any(r['source']=='EDGE_FALLBACK' for r in results.values()): warnings.append('Some screenshots required edge fallback because candle colors were unclear.')
    if alignment=='DISAGREES': warnings.append('Visual geometry conflicts with the numerical scanner direction.')
    if entry=='EXTENDED': warnings.append('Lower-timeframe geometry looks extended; keep numerical entry limits authoritative.')
    tftext={tf:f"{r['direction']} | conf {r['confidence']} | {r['extension']}" for tf,r in results.items()}
    obs=[f"{tf}: {results[tf]['direction']} (confidence {results[tf]['confidence']}, consistency {results[tf]['consistency']})" for tf in ('30m','15m','5m','3m','1m')]
    return {'visualDirection':direction,'confidence':confidence,'alignment':alignment,'entryContext':entry,
            'timeframes':tftext,'observations':obs,'warnings':warnings,
            'summary':f'Local OpenCV review: {direction}, confidence {confidence}/100. Alignment: {alignment}. Entry context: {entry}. Exact entry prices remain from the numerical engine.'}

def main():
    p=argparse.ArgumentParser(); p.add_argument('--symbol',required=True); p.add_argument('--snapshot',required=True)
    for tf in ('1m','3m','5m','15m','30m'): p.add_argument(f'--{tf}',dest='m'+tf[:-1],required=True)
    a=p.parse_args(); snap=json.loads(Path(a.snapshot).read_text(encoding='utf-8'))
    paths={'1m':a.m1,'3m':a.m3,'5m':a.m5,'15m':a.m15,'30m':a.m30}
    results={tf:analyze(Path(fp),tf) for tf,fp in paths.items()}
    print(json.dumps(combine(results,snap),ensure_ascii=False))
if __name__=='__main__': main()
