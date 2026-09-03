# v5.3.4.5 — Research Metadata

Добавлено исследовательское логирование для будущей статистики WAIT/TRADE.

Сохраняются:
- RSI(14): 1m / 5m / 15m
- ATR(14): 1m / 5m / 15m
- ATR %: 1m / 5m / 15m
- MACD 5m: line / signal / histogram
- Distance to Best Entry в ATR
- Entry Status / Entry Quality
- Candle Confirmation
- Signal Age
- Market Regime

Важно:
- Эти параметры НЕ меняют Signal Score.
- НЕ меняют Entry Engine.
- НЕ меняют направление сигнала.
- НЕ меняют expiration.
- НЕ меняют Telegram.
- Они только сохраняются в signal-history.json для последующего анализа.
- Логировать следует только те WAIT/TRADE, которые проходят текущие правила вашего v5.3.4.4 (Score > 50).

Файлы:
1. researchMetadata.js — новый модуль, положить в корень проекта.
2. server.patch.txt — места подключения к server.js.
3. signalLogger.patch.txt — поля для signal-history.json.
