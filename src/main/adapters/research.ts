import type { ToolAdapter } from './base'

export class ResearchAdapter implements ToolAdapter {
  readonly name = 'research'
  readonly enabled = true

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const op = params.op as string
    switch (op) {
      case 'summarize': return this.summarize(params.url as string)
      case 'search': return this.search(params.query as string)
      default: throw new Error(`Unknown research op: ${op}`)
    }
  }

  private async summarize(_url: string) {
    return { stub: true, summary: 'Summarization not yet implemented' }
  }

  private async search(_query: string) {
    return { stub: true, results: [] }
  }
}
