# Historical Markets

Open Markets and import a UTF-8 CSV using an uppercase symbol. Data and the latest simulation are saved locally in the Electron user-data markets store. Imports replace the entire dataset for that symbol and clear its previous simulation. Watchlists reference imported symbols; removing a watch does not remove data.

CSV format is deliberately strict: exactly `date,close`, followed by 3–20,000 ascending daily ISO dates and positive finite closes. Duplicate dates, future dates, malformed dates, missing values and unordered rows are rejected. Maximum file size is 2 MB; at most 50 datasets are retained. Supply consistently adjusted prices in one currency. Goga does not verify a provider or adjust corporate actions.

Example:

```csv
date,close
2020-01-01,10
2020-01-02,12
2020-01-03,14
2020-01-04,8
2020-01-05,7
2020-01-06,9
2020-01-07,10
2020-01-08,12
2020-01-09,14
2020-01-10,8
2020-01-11,7
2020-01-12,9
```

For this fixture choose lookback 2, evaluation start 2020-01-07, cash 100, quantity 2, and zero costs. Both periods end at equity 86, return -14%, and maximum drawdown 14%.

The single deterministic strategy compares the previous close with the mean of the previous N closes, including that close. It buys the configured share quantity when above the mean, sells the full position when at or below, and fills at the next recorded close. Slippage increases buy prices and reduces sell prices; basis-point fees apply to both sides. Unaffordable buys produce rejected journal entries without deducting cash or fees.

Development contains rows before the evaluation start, evaluation contains rows on or after it. Both require N+2 rows and reset cash, positions and warmup independently. There is no parameter optimization. Repeated evaluation or choosing settings after inspecting evaluation results can still bias conclusions.

Equity is cash plus shares at the current close. Returns use starting cash; drawdown uses the running equity peak including initial cash; mean exposure averages shares × close / equity across all recorded rows, including warmup. Final open positions remain marked to market and do not incur an assumed exit fee. No interest, taxes, dividends, shorting, leverage, market liquidity or currency conversion is modeled.

Chat command `/markets` returns stored data timestamps, stale flags (>3 calendar days), parameters and calculated metrics without an LLM calculation. No data and no simulation are explicitly reported. It is a report command; natural-language strategy execution is not supported. Historical data is never represented as a live quote. The trading adapter stays disabled.
