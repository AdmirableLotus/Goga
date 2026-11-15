import { ToolRegistry } from './registry'
import { MarketsService } from '../services/markets'

/**
 * Markets tools: the local historical-data surface behind the Trading → Markets section.
 *
 * That page had no tool at all before this — only a `/markets` slash command reached its
 * report, and importing or backtesting needed the buttons. These are the same operations the
 * page calls, reachable by the agent.
 *
 * Nothing here is a live quote and the tool says so every time. The data is a date,close CSV
 * the user imported, and a simulation over history is not a prediction.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'markets.state',
  description: 'The local historical market data on this machine: each dataset with its symbol, row count, source, when it was imported and how stale it is, plus the parameters of the last simulation. Historical simulation only — not a live quote. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => ({
  success: true,
  data: MarketsService.getInstance().report(),
}))

reg.register({
  name: 'markets.import',
  description: 'Import a date,close CSV the user holds into the local market data store, under a symbol, so it can be simulated. Writes only to Goga\'s own store; nothing is fetched. Give the CSV text itself.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'The symbol, e.g. AAPL.' },
      csv: { type: 'string', description: 'The CSV text: a header row, then date,close. Two years of daily data is plenty.' },
    },
    required: ['symbol', 'csv'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const state = MarketsService.getInstance().importCsv(String(p.symbol ?? ''), String(p.csv ?? ''))
    const data = state.datasets.find(d => d.symbol.toUpperCase() === String(p.symbol).toUpperCase())
    return {
      success: true,
      data: data
        ? `Imported ${data.symbol}: ${data.bars.length} row(s) from ${data.source}, through ${data.bars[data.bars.length - 1]?.date}. It is in the watchlist. This is historical data, not a live price.`
        : `Imported into the store; ${state.datasets.length} dataset(s) now held.`,
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'markets.watchlist',
  description: 'Set the symbols a simulation runs over. Every symbol must already be imported. Reversible.',
  parameters: {
    type: 'object',
    properties: { symbols: { type: 'array', description: 'Symbols to keep, e.g. ["AAPL","SPY"].' } },
    required: ['symbols'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const symbols = Array.isArray(p.symbols) ? (p.symbols as unknown[]).map(String) : []
    const state = MarketsService.getInstance().watchlist(symbols)
    return { success: true, data: `Watchlist: ${state.watchlist.join(', ') || '(empty)'}.` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'markets.backtest',
  description: 'Run the local simulation over an imported symbol: development and evaluation periods, final equity, return, max drawdown, mean exposure and the journal. Historical simulation only, with the assumptions the page prints. No order is placed anywhere.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'An imported symbol, e.g. AAPL.' },
      lookback: { type: 'number', description: 'Bars used for the signal mean (default 20, 2–252).' },
      quantity: { type: 'number', description: 'Shares per entry (default 10).' },
      initialCash: { type: 'number', description: 'Starting cash (default 10000).' },
      feeBps: { type: 'number', description: 'Fee in basis points (default 5).' },
      slippageBps: { type: 'number', description: 'Slippage in basis points (default 5).' },
      evaluationStart: { type: 'string', description: 'Where the evaluation period starts, YYYY-MM-DD. Default: the middle of the data.' },
    },
    required: ['symbol'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const service = MarketsService.getInstance()
    const state = service.state()
    const symbol = String(p.symbol ?? '').trim().toUpperCase()
    const data = state.datasets.find(d => d.symbol === symbol)
    if (!data) {
      return {
        success: false,
        error: `No imported data for ${symbol}. Import a date,close CSV first — the Markets section takes one, or give me the CSV text and I will import it.`,
      }
    }
    const lookback = Number(p.lookback) || 20
    // The split has to leave lookback + 2 rows on each side, so default to the middle.
    const middle = data.bars[Math.floor(data.bars.length / 2)]?.date
    const config = {
      symbol,
      initialCash: Number(p.initialCash) || 10_000,
      quantity: Number(p.quantity) || 10,
      lookback,
      feeBps: p.feeBps === undefined ? 5 : Number(p.feeBps),
      slippageBps: p.slippageBps === undefined ? 5 : Number(p.slippageBps),
      evaluationStart: String(p.evaluationStart ?? middle ?? ''),
    }
    const next = service.run(config)
    const latest = next.latest
    if (!latest) return { success: false, error: 'The simulation produced no result.' }
    return {
      success: true,
      data: [
        `Historical simulation of ${symbol}, from the CSV you imported (through ${latest.dataThrough}). This is not a live quote and not a prediction.`,
        `Parameters: ${JSON.stringify(latest.config)}`,
        ...(['development', 'evaluation'] as const).map(k => {
          const period = latest[k]
          return `${k} ${period.start} to ${period.end}: equity ${period.finalEquity.toFixed(2)}, return ${period.returnPct.toFixed(2)}%, max drawdown ${period.maxDrawdownPct.toFixed(2)}%, mean exposure ${period.exposurePct.toFixed(2)}%, ${period.trades.length} journal event(s).`
        }),
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})
