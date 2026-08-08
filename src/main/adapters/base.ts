export interface ToolAdapter {
  readonly name: string
  readonly enabled: boolean
  execute(params: Record<string, unknown>): Promise<unknown>
}
