import type { ToolDefinition, ToolResult, RiskLevel } from '../../shared/types'
import type { OllamaTool } from '../services/ollamaClient'
import { plannerDiagnostic } from '../services/plannerDiagnostics'

export type { ToolDefinition, ToolResult }

export type ToolExecutor = (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>

export interface ToolContext {
  abortSignal: AbortSignal
  // Set when agent is in security-research mode
  securityWorkspaceId?: string
}

interface RegisteredTool {
  definition: ToolDefinition
  execute: ToolExecutor
}

// Risk levels ordered lowest → highest for comparison
const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical']

export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER.indexOf(level) >= RISK_ORDER.indexOf(threshold)
}

export class ToolRegistry {
  private static instance: ToolRegistry
  private tools: Map<string, RegisteredTool> = new Map()

  static getInstance() {
    if (!ToolRegistry.instance) ToolRegistry.instance = new ToolRegistry()
    return ToolRegistry.instance
  }

  register(definition: ToolDefinition, execute: ToolExecutor) {
    this.tools.set(definition.name, { definition, execute })
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { success: false, error: `Unknown tool: ${name}` }
    try {
      plannerDiagnostic('registry.dispatch', { tool: name, aborted: context.abortSignal.aborted })
      const result = await tool.execute(params, context)
      const data = result.data as { filePath?: string; bytes?: number } | undefined
      plannerDiagnostic('registry.result', { tool: name, success: result.success, error: result.error, filePath: data?.filePath, bytes: data?.bytes })
      return result
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Returns a compact JSON schema string the LLM can reason over
  toSchema(): string {
    const tools = this.list().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      riskLevel: t.riskLevel,
      reversible: t.reversible
    }))
    return JSON.stringify(tools, null, 2)
  }

  // Returns a compact plain-text summary for injection into prompts
  toPromptSummary(): string {
    return this.list()
      .map(t => `- ${t.name}(${Object.keys(t.parameters.properties).join(', ')}): ${t.description} [risk:${t.riskLevel}]`)
      .join('\n')
  }

  // Returns Ollama-compatible tool definitions for native tool-call support
  toOllamaTools(): OllamaTool[] {
    return this.list().map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }
}
