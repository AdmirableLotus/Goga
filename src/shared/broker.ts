/**
 * Broker types shared by the main process and the renderer.
 *
 * Everything here describes state Goga actually read from Alpaca or from his own
 * order audit log. Nothing in this file places an order.
 */

export type BrokerMode = 'paper' | 'live'

export interface BrokerCredentialStatus {
  /** Paper keys (key id starts with PK) are stored. */
  paper: boolean
  /** Live keys (key id starts with AK) are stored. */
  live: boolean
  /** Encrypted storage is usable on this PC. */
  encryptionAvailable: boolean
  /** A live order may only be sent when this is true (off by default). */
  liveEnabled: boolean
  /** The user's reason for the current kill-switch state, when halted. */
  halted: boolean
  haltReason: string | null
}

export interface BrokerAccount {
  mode: BrokerMode
  status: string
  currency: string
  equity: number
  cash: number
  buyingPower: number
  dayPnl: number
  dayPnlPct: number
  /** True when today's loss has reached the user's daily loss limit. */
  dailyLossBreached: boolean
  tradingBlocked: boolean
  blockedReason: string | null
  asOf: string
}

export interface BrokerPosition {
  symbol: string
  qty: number
  side: string
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPl: number
  unrealizedPlPct: number
  /** Share of account equity this position represents, in percent. */
  exposurePct: number
}

export interface BrokerOrder {
  id: string
  symbol: string
  side: string
  qty: number | null
  notional: number | null
  type: string
  limitPrice: number | null
  stopPrice: number | null
  status: string
  submittedAt: string
  filledQty: number
  filledAvgPrice: number | null
}

export interface BrokerBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface BrokerSnapshot {
  credentials: BrokerCredentialStatus
  /** Null when no keys are stored for that mode, or when reading failed. */
  account: BrokerAccount | null
  positions: BrokerPosition[]
  openOrders: BrokerOrder[]
  error: string | null
  limits: RiskLimitsView
}

export interface RiskLimitsView {
  maxPositionPct: number
  maxOpenPositions: number
  maxOrderNotional: number
  dailyLossPct: number
}

/** An order worked out but NOT sent. It expires if not confirmed. */
export interface OrderIntent {
  id: string
  createdAt: string
  expiresAt: string
  mode: BrokerMode
  symbol: string
  side: 'buy' | 'sell'
  qty: number | null
  notional: number
  orderType: 'market' | 'limit'
  limitPrice: number | null
  estimatedPrice: number
  estimatedNotional: number
  /** Plain-words line shown with the approval request. */
  confirmation: string
  /** Every risk rule that this order was checked against, and passed. */
  checks: string[]
  reason: string
}

export interface OrderAuditEntry {
  id: string
  time: string
  stage: 'intent' | 'refused' | 'approved' | 'denied' | 'sent' | 'error'
  mode: BrokerMode
  symbol?: string
  side?: string
  qty?: number | null
  notional?: number
  orderType?: string
  price?: number
  orderId?: string
  detail: string
}

export interface BrokerOrderResult {
  ok: boolean
  orderId: string | null
  status: string | null
  message: string
  audit: OrderAuditEntry
}

export interface KillSwitchResult {
  ok: boolean
  cancelled: number
  halted: boolean
  message: string
}
