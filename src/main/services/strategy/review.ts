import type { JournalEntry, ReviewResult, ReviewVerdict } from '../../../shared/strategy'

/**
 * The review loop: does the strategy still do what the backtest said it would?
 *
 * This is the part that makes the system honest. A backtest is a claim; the journal is
 * the evidence. When the two disagree by more than a stated margin, the review says so
 * in plain words and names the strategy as diverging rather than quietly carrying on.
 *
 * The thresholds are deliberately blunt and stated in the output, because a clever
 * statistical test on 12 trades would be false precision.
 */

export const MIN_TRADES_FOR_REVIEW = 10
/** Average trade must be within this many percentage points of the backtest. */
export const AVG_TRADE_TOLERANCE_PCT = 1.5
/** Win rate must be within this many percentage points of the backtest. */
export const WIN_RATE_TOLERANCE_PCT = 20

export interface Baseline {
  strategyId: string
  symbol: string
  at: string
  tradeCount: number
  winRate: number
  avgTradePct: number
  totalReturn: number
}

export function liveStats(entries: JournalEntry[], strategyId: string, symbol: string) {
  const closed = entries.filter(e => e.kind === 'exit' && e.strategyId === strategyId && e.symbol === symbol && e.pnl !== null)
  const wins = closed.filter(e => (e.pnl ?? 0) > 0)
  const avgTradePct = closed.length ? closed.reduce((a, e) => a + (e.pnlPct ?? 0), 0) / closed.length : 0
  // Compounded, so a run of trades is measured the way an account actually grows.
  const totalReturn = closed.reduce((acc, e) => acc * (1 + (e.pnlPct ?? 0)), 1) - 1
  return {
    tradeCount: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgTradePct,
    totalReturn,
  }
}

export function reviewStrategy(entries: JournalEntry[], baseline: Baseline | null): ReviewResult {
  const live = liveStats(entries, baseline?.strategyId ?? '', baseline?.symbol ?? '')
  const base = baseline
    ? { tradeCount: baseline.tradeCount, winRate: baseline.winRate, avgTradePct: baseline.avgTradePct, totalReturn: baseline.totalReturn }
    : null

  if (!base) {
    return {
      strategyId: baseline?.strategyId ?? '', symbol: baseline?.symbol ?? '',
      verdict: 'too-few-trades',
      headline: 'No backtest saved for this strategy and symbol yet, so there is nothing to compare against.',
      findings: ['Run a backtest first. The review compares real paper results with that backtest.'],
      backtest: null, live,
    }
  }

  const findings: string[] = []
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`

  if (live.tradeCount < MIN_TRADES_FOR_REVIEW) {
    findings.push(`Only ${live.tradeCount} closed paper trade${live.tradeCount === 1 ? '' : 's'} so far. ${MIN_TRADES_FOR_REVIEW} is the minimum before a comparison means anything.`)
    findings.push(`The backtest had ${base.tradeCount} trades, ${(base.winRate * 100).toFixed(0)}% winners, average trade ${pct(base.avgTradePct)}.`)
    return {
      strategyId: baseline!.strategyId, symbol: baseline!.symbol,
      verdict: 'too-few-trades',
      headline: `Not enough paper trades yet to judge — ${live.tradeCount} of the ${MIN_TRADES_FOR_REVIEW} needed.`,
      findings, backtest: base, live,
    }
  }

  const avgGap = live.avgTradePct - base.avgTradePct
  const winGap = (live.winRate - base.winRate) * 100
  findings.push(`Paper: ${live.tradeCount} trades, ${(live.winRate * 100).toFixed(0)}% winners, average trade ${pct(live.avgTradePct)}, compounded ${pct(live.totalReturn)}.`)
  findings.push(`Backtest: ${base.tradeCount} trades, ${(base.winRate * 100).toFixed(0)}% winners, average trade ${pct(base.avgTradePct)}, total ${pct(base.totalReturn)}.`)
  findings.push(`Average trade differs by ${(avgGap * 100).toFixed(2)} points (tolerance ${AVG_TRADE_TOLERANCE_PCT}); win rate differs by ${winGap.toFixed(0)} points (tolerance ${WIN_RATE_TOLERANCE_PCT}).`)

  let verdict: ReviewVerdict
  let headline: string
  if (Math.abs(avgGap) * 100 > AVG_TRADE_TOLERANCE_PCT || Math.abs(winGap) > WIN_RATE_TOLERANCE_PCT) {
    verdict = 'diverging'
    headline = avgGap < 0
      ? 'Paper results are materially worse than the backtest. Treat the backtest as unreliable for this strategy until that is explained.'
      : 'Paper results are materially better than the backtest. That is not a win — it usually means the sample is small or the market was kind.'
    findings.push('Material divergence. The usual causes: too few trades, a different market regime, fills worse than assumed, or a backtest that was tuned to the history it was tested on.')
  } else if (avgGap > 0) {
    verdict = 'better'
    headline = 'Paper results are in line with the backtest, and slightly better. Keep measuring.'
  } else if (avgGap < 0) {
    verdict = 'weaker'
    headline = 'Paper results are in line with the backtest, and slightly worse. That is normal slippage and noise.'
  } else {
    verdict = 'in-line'
    headline = 'Paper results are in line with the backtest.'
  }

  return { strategyId: baseline!.strategyId, symbol: baseline!.symbol, verdict, headline, findings, backtest: base, live }
}
