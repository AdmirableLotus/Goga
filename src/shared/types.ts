export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'error'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface Action {
  id: string
  type: string
  label: string
  params: Record<string, unknown>
  status: ActionStatus
  createdAt: number
  resolvedAt?: number
  result?: unknown
  error?: string
  requiresApproval: boolean
  riskLevel: RiskLevel
}

// JSON Schema subset used to describe tool parameters to the LLM
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  enum?: string[]
  items?: JSONSchemaProperty
  properties?: Record<string, JSONSchemaProperty>
  required?: string[]
}

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, JSONSchemaProperty>
  required?: string[]
}

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  // base64 screenshot taken after the action (for visual verification)
  screenshotAfter?: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameterSchema
  riskLevel: RiskLevel
  // true = action can be undone (click, type, navigate); false = destructive (delete, format)
  reversible: boolean
  // categories used for scope checking in security mode
  category: 'computer' | 'browser' | 'shell' | 'filesystem' | 'process' | 'vision' | 'memory' | 'web' | 'android'
}

// One step the agent took during a task
export interface AgentStep {
  index: number
  thought: string
  tool: string
  params: Record<string, unknown>
  result: ToolResult
  verified: boolean
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'done' | 'error' | 'stopped'

export interface AgentState {
  status: AgentStatus
  task: string
  steps: AgentStep[]
  currentTool?: string
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  actionIds?: string[]
}

export interface LogEntry {
  id: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
  actionId?: string
  meta?: Record<string, unknown>
}

export interface MemoryEntry {
  id: string
  key: string
  value: unknown
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  theme: 'dark' | 'light'
  requireApprovalForAll: boolean
  // Minimum risk level that triggers an approval prompt (low = approve everything, critical = only approve critical)
  autoApproveBelow: RiskLevel
  logRetentionDays: number
  modelEndpoint: string
  modelName: string
  visionModelName: string
  agentMaxSteps: number
  voiceEnabled: boolean
  voiceName: string
  voiceRate: number
  voiceVolume: number
  userName: string
}

export interface BookChunk {
  bookId: string
  chunkIndex: number
  text: string
}

export interface BookMeta {
  id: string
  title: string
  filename: string
  format: 'pdf' | 'txt' | 'epub'
  chunkCount: number
  ingestedAt: number
  sizeBytes: number
}

// Persistent fact Goga remembers about you or things he learned
export interface GogaFact {
  id: string
  category: 'about_user' | 'learned' | 'preference' | 'event'
  content: string
  source: 'conversation' | 'book' | 'observation'
  createdAt: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  requireApprovalForAll: false,
  autoApproveBelow: 'medium',
  logRetentionDays: 30,
  modelEndpoint: 'http://localhost:11434',
  modelName: 'llama3',
  visionModelName: 'llava:13b',
  agentMaxSteps: 20,
  voiceEnabled: true,
  voiceName: '',
  voiceRate: 1.0,
  voiceVolume: 1.0,
  userName: 'Boss'
}

// ── Security Workspace ────────────────────────────────────────────────────────

export interface SecurityFinding {
  id: string
  title: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  target: string
  description: string
  steps: string
  evidenceIds: string[]
  status: 'draft' | 'submitted' | 'triaged' | 'resolved'
  createdAt: number
  updatedAt: number
}

export interface EvidenceEntry {
  id: string
  type: 'screenshot' | 'request' | 'response' | 'note' | 'file'
  label: string
  content: string   // base64 for screenshots, raw text for others
  createdAt: number
}

export interface SecurityAuditEntry {
  id: string
  timestamp: number
  tool: string
  target: string
  params: Record<string, unknown>
  result: string
  inScope: boolean
}

export interface SecurityWorkspace {
  id: string
  program: string
  programUrl: string
  authorizedAssets: string[]   // globs like *.acme.com or CIDR like 10.0.0.0/8
  excludedAssets: string[]
  allowedTechniques: string[]
  prohibitedTechniques: string[]
  rateLimit: string
  programRules: string
  testNotes: string
  findings: SecurityFinding[]
  evidence: EvidenceEntry[]
  auditLog: SecurityAuditEntry[]
  createdAt: number
  updatedAt: number
}
