# TEMPORARY TEST BUILD — SIGNAL SCORE 40

Changed for one-time Telegram testing:

1. config.js
   - default minSignalScore = 40
   - USD/JPY / USD/CAD minSignalScore = 40
   - GBP/* minSignalScore = 40

2. server.js
   - 40 added to allowedMinScores
   - default userMinScore changed from 50 to 40

3. public/index.html
   - hidden minScoreFilter now selects 40
   - getMinimumDisplayScore accepts 40 and falls back to 40
   - visible Signal Score Filter default changed to 40

Result:
pairSafetyMinScore = 40
userMinScore = 40
effectiveMinScore = 40

Important:
Score >= 40 can now create a directional signal, but all other blockers remain active.
Context/setup conflict, insufficient edge, invalid entry, TOO LATE, stale data, news, etc.
can still prevent a final TRADE and therefore prevent a Telegram alert.
