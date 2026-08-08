import type { ToolAdapter } from './base'

class DisabledAdapter implements ToolAdapter {
  readonly enabled = false
  constructor(readonly name: string) {}
  async execute(_params: Record<string, unknown>): Promise<never> {
    throw new Error(`[DISABLED] The '${this.name}' adapter is disabled in this build.`)
  }
}

export const TradingAdapter = new DisabledAdapter('trading')
export const WalletAdapter = new DisabledAdapter('wallet')
export const SocialPostAdapter = new DisabledAdapter('socialPost')
export const OffensiveSecAdapter = new DisabledAdapter('offensiveSec')
