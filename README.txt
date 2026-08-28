LOCAL OPENCV VISUAL REVIEW — NO EXTERNAL API

1. Copy:
   server.js
   visionAnalyzer.js
   localChartAnalyzer.py
   requirements.txt
   public/index.html  (use the included index.html)

2. Install:
   npm install multer
   py -m pip install -r requirements.txt

   If 'py' does not work:
   python -m pip install -r requirements.txt

3. OPENAI_API_KEY is NOT needed for Visual Review.

4. Start:
   node --check server.js
   node --check visionAnalyzer.js
   node server.js

5. In GUI:
   DETAILS -> Visual Chart Review -> choose 1m/3m/5m/15m/30m -> ANALYZE SCREENSHOTS

The local analyzer measures image geometry and common red/green candle colors.
It does not OCR exact prices and cannot override TOO LATE / DO NOT CHASE.
