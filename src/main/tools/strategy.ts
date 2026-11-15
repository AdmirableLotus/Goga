import type { ToolResult } from '../../shared/types'
import { ToolRegistry } from './registry'
import { STRATEGIES } from '../services/strategy/engine'
import { readJournal, recordJournal } from '../services/strategy/journal'
import { strategyService, writeStrategySettings } from '../services/strategy/service'
import type { StrategyId, StrategyParams } from '../../shared/strategy'

/**
 * Strategy tools.
 *
 * Reading the strategies, the settings, the journal and a backtest is free. Changing a
 * setting is `medium` (it can change what the paper loop does next), and running the paper
 * loop once is `critical` because it can prepare a paper order.
 *
 * There is deliberately no tool that sends an order: the paper loop prepares an intent and
 * the Trading page sends it. Live trading is not reachable from this file at all.
 */

void 0
const reg = ToolRegistry.getInstance()
const failure = (err: unknown): ToolResult => ({ success: false, error: err instanceof Error ? err.message : String(err) })

const strategyIds = STRATEGIES.map(s => s.id) as StrategyId[]

reg.register({
  name: 'strategy.list',
  description:
    'The rule-based trading strategies built into Goga, with the exact entry and exit rule for each in words, and the parameters with their allowed ranges. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => ({
  success: true,
  data: STRATEGIES.map(s => [
    `${s.id} — ${s.name}: ${s.summary}`,
    `  entry: ${s.entryRule}`,
    `  exit: ${s.exitRule}`,
    `  parameters: ${s.params.map(p => `${p.key} ${p.default} (${p.min}–${p.max})`).join(', ')}`,
  ].join('\n')).join('\n\n'),
}))

reg.register({
  name: 'strategy.state',
  description:
    'The strategy settings and paper-run state: which strategy and symbol, its parameters, the risk and cost assumptions, whether the paper loop is on, whether paper orders auto-approve, the last run result, and the per-strategy performance from closed paper trades.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const state = strategyService().state()
  const s = state.settings
  return {
    success: true,
    data: [
      `Strategy ${s.strategyId} on ${s.symbol}, every ${s.intervalMinutes} min. Parameters: ${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Risk ${s.riskPct}% to the stop, cap ${s.maxPositionPct}% per position, stop ${s.stopAtrMultiple}× ATR(${s.atrPeriod}), slippage ${s.slippageBps}bps, commission $${s.commissionPerShare}/share, starting capital $${s.startingCapital}.`,
      `Paper run ${state.paperRun.enabled ? 'ON' : 'off'}, auto-approve paper orders ${state.paperRun.autoApprovePaper ? 'ON' : 'off'}, paper key ${state.paperKeyStored ? 'stored' : 'MISSING'}.`,
      state.paperRun.lastResult ? `Last run: ${state.paperRun.lastResult}` : 'The paper loop has not run yet.',
      ...(state.summaries.length
        ? ['', 'Closed paper trades:', ...state.summaries.map(m => `  ${m.strategyId} ${m.symbol}: ${m.closedTrades} trades, ${(m.winRate * 100).toFixed(0)}% winners, total ${m.totalPnl >= 0 ? '+' : ''}$${m.totalPnl.toFixed(2)}`)]
        : ['', 'No closed paper trades yet.']),
    ].join('\n'),
  }
})

reg.register({
  name: 'strategy.backtest',
  description:
    'Run one strategy over real daily bars (Alpaca when a paper key is stored, otherwise a saved copy, otherwise a clearly-labelled synthetic series) and return the trades, win rate, drawdown, profit factor and buy-and-hold comparison. Read-only: it places no order. Say which data source the result came from when you report it.',
  parameters: {
    type: 'object',
    properties: {
      strategyId: { type: 'string', enum: strategyIds, description: 'Which strategy.' },
      symbol: { type: 'string', description: 'Stock symbol, e.g. SPY.' },
      days: { type: 'number', description: 'How many calendar days of daily bars (default 400, max 1000).' },
      params: { type: 'object', description: 'Optional parameter overrides, e.g. {"fast":10,"slow":30}.' },
    },
    required: ['strategyId', 'symbol'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const id = String(p.strategyId) as StrategyId
    if (!strategyIds.includes(id)) return { success: false, error: `unknown strategy "${p.strategyId}". One of: ${strategyIds.join(', ')}` }
    const r = await strategyService().backtest({
      strategyId: id,
      symbol: String(p.symbol),
      days: Number(p.days) || 400,
      params: (p.params ?? undefined) as StrategyParams | undefined,
    })
    return {
      success: true,
      data: [
        `${r.strategyId} on ${r.symbol}: ${r.barCount} bars, ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)}. Data: ${r.dataSource} — ${r.dataNote}`,
        `Return ${(r.totalReturn * 100).toFixed(2)}% vs buy-and-hold ${(r.buyHoldReturn * 100).toFixed(2)}%. Worst drawdown ${(r.maxDrawdown * 100).toFixed(2)}%.`,
        `${r.tradeCount} trades, ${(r.winRate * 100).toFixed(0)}% winners, average win $${r.avgWin.toFixed(2)}, average loss $${r.avgLoss.toFixed(2)}, profit factor ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : 'no losses'}, in the market ${(r.exposure * 100).toFixed(0)}% of the time.`,
        ...r.warnings.map(w => `! ${w}`),
        '',
        'Assumptions:',
        ...r.assumptions.map(a => `  • ${a}`),
        '',
        `Trades: ${r.trades.slice(-10).map(t => `${t.entryTime.slice(0, 10)}→${t.exitTime.slice(0, 10)} ${t.qty}sh ${(t.pnlPct * 100).toFixed(2)}% (${t.exitReason})`).join('; ') || 'none'}`,
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'strategy.journal',
  description: 'The strategy trade journal: every signal, prepared paper order, approval, refusal, send and closed trade, with the reason recorded at the time. Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent entries (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = readJournal(Number(p.limit) || 40)
  if (!entries.length) return { success: true, data: 'The strategy journal is empty — nothing has been signalled or traded yet.' }
  return {
    success: true,
    data: entries.slice().reverse().map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.kind}] ${e.mode} ${e.strategyId} ${e.symbol} ${e.side ?? ''} ${e.qty ?? ''} — ${e.reason}`).join('\n'),
  }
})

reg.register({
  name: 'strategy.review',
  description:
    'Compare the real paper results in the journal against the saved backtest for one strategy and symbol, and give a plain verdict: too few trades, in line, weaker, better or diverging. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      strategyId: { type: 'string', enum: strategyIds, description: 'Which strategy.' },
      symbol: { type: 'string', description: 'Stock symbol.' },
    },
    required: ['strategyId', 'symbol'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const r = strategyService().review(String(p.strategyId), String(p.symbol))
    return { success: true, data: [`${r.verdict.toUpperCase()} — ${r.headline}`, ...r.findings.map(f => `  • ${f}`)].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'strategy.configure',
  description:
    'Change the strategy settings: which strategy and symbol, its parameters, the interval, and the risk and cost assumptions. These are saved and apply to the next paper run. It cannot change the paper-run switch, auto-approve, or anything about live trading.',
  parameters: {
    type: 'object',
    properties: {
      strategyId: { type: 'string', enum: strategyIds, description: 'Which strategy.' },
      symbol: { type: 'string', description: 'Stock symbol.' },
      params: { type: 'object', description: 'Parameter overrides, e.g. {"fast":10,"slow":30}. Out-of-range values are clamped.' },
      intervalMinutes: { type: 'number', description: 'How often the paper loop runs, 5–1440 minutes.' },
      riskPct: { type: 'number', description: 'Percent of equity risked to the stop, 0.1–10.' },
      maxPositionPct: { type: 'number', description: 'Percent of equity in one position, 1–100.' },
      slippageBps: { type: 'number', description: 'Slippage per fill in basis points, 0–200.' },
      stopAtrMultiple: { type: 'number', description: 'Stop distance in ATRs, 0–10. 0 turns the stop off.' },
    },
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const patch: Record<string, unknown> = {}
    if (p.strategyId !== undefined) {
      if (!strategyIds.includes(String(p.strategyId) as StrategyId)) return { success: false, error: `unknown strategy "${p.strategyId}"` }
      patch.strategyId = p.strategyId
    }
    if (p.symbol !== undefined) patch.symbol = String(p.symbol).trim().toUpperCase()
    if (p.params !== undefined) patch.params = p.params
    for (const key of ['intervalMinutes', 'riskPct', 'maxPositionPct', 'slippageBps', 'stopAtrMultiple']) {
      if (p[key] !== undefined) patch[key] = Number(p[key])
    }
    const next = writeStrategySettings(patch)
    recordJournal({
      strategyId: next.strategyId, symbol: next.symbol, mode: 'paper', kind: 'note',
      side: null, qty: null, price: null, pnl: null, pnlPct: null,
      reason: `Settings changed by the agent: ${Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`,
      intentId: null, orderId: null,
    })
    return {
      success: true,
      data: `Saved. Now ${next.strategyId} on ${next.symbol} (${Object.entries(next.params).map(([k, v]) => `${k}=${v}`).join(', ')}), every ${next.intervalMinutes} min, ${next.riskPct}% risk, ${next.maxPositionPct}% cap.`,
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'strategy.runPaperOnce',
  description:
    'Run one pass of the PAPER loop now: read bars, ask the strategy at the last closed bar, and either do nothing or prepare ONE paper order for the user to approve in the Trading page. It never sends anything and never touches the live account.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'critical', reversible: true, category: 'system',
}, async () => {
  try { return { success: true, data: await strategyService().tick() } } catch (err) { return failure(err) }
})
