export interface MarketBar { date: string; close: number }
export interface MarketDataset { symbol: string; source: 'Imported CSV'; importedAt: string; bars: MarketBar[] }
export interface BacktestRequest { symbol: string; initialCash: number; quantity: number; lookback: number; feeBps: number; slippageBps: number; evaluationStart: string }
export interface SimulatedTrade { date: string; side: 'buy' | 'sell' | 'rejected'; quantity: number; price: number; fee: number; cash: number; reason: string }
export interface PortfolioPoint { date: string; equity: number; cash: number; quantity: number; exposure: number; drawdown: number }
export interface SimulationPeriod { start: string; end: string; initialCash: number; finalEquity: number; returnPct: number; maxDrawdownPct: number; exposurePct: number; trades: SimulatedTrade[]; curve: PortfolioPoint[] }
export interface BacktestResult { config: BacktestRequest; dataImportedAt: string; dataThrough: string; development: SimulationPeriod; evaluation: SimulationPeriod }
export interface MarketsState { datasets: MarketDataset[]; watchlist: string[]; latest: BacktestResult | null }
