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

// ── Phase A: Snapshot & Accessibility ───────────────────────────────────────

export interface Rect {
  x: number; y: number; width: number; height: number
}

export interface AccessibilityNode {
  automationId: string   // UIAutomation AutomationId or generated index
  name: string
  role: string           // e.g. Button, Edit, Document, MenuItem
  bounds: Rect
  value?: string
  enabled: boolean
  focused?: boolean
  children?: AccessibilityNode[]
}

export interface DesktopSnapshot {
  timestamp: number
  screenWidth: number
  screenHeight: number
  cursorX: number
  cursorY: number
  activeWindow: {
    title: string
    owner: string
    pid: number
    bounds: Rect
  }
  visibleWindows: Array<{ title: string; owner: string; pid: number; bounds: Rect }>
  // uiTree is optional — only populated when explicitly requested (expensive)
  uiTree?: AccessibilityNode[]
  focusedElement?: Pick<AccessibilityNode, 'automationId' | 'name' | 'role'>
}

// Structured verification descriptor — deterministic checks before falling back to vision
export interface VerificationSpec {
  type: 'window_title' | 'element_exists' | 'element_value' | 'url' | 'exit_code' | 'file_exists' | 'process_running' | 'vision'
  expected: string   // value to match against
  windowTitle?: string
  elementName?: string
  elementRole?: string
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
  turnId?: string
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
  autoApproveBelow: RiskLevel
  logRetentionDays: number
  // Primary local model (node-llama-cpp)
  localModelPath: string
  localModelContextSize: number
  localModelGpuLayers: number
  // Ollama (vision + optional fallback)
  modelEndpoint: string
  modelName: string
  visionModelName: string
  agentMaxSteps: number
  primaryModel: 'local' | 'ollama'
  voiceEnabled: boolean
  voiceName: string
  voiceRate: number
  voiceVolume: number
  wakeWordEnabled: boolean
  wakePhrase: string
  autoSpeakResponses: boolean
  allowBargeIn: boolean
  conversationWindowSecs: number
  userName: string
  sttProvider: 'windows' | 'whisper'
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v2' | 'large-v3'
  whisperDevice: 'cuda' | 'cpu' | 'auto'
  whisperLanguage: string
  ttsProvider: 'kokoro' | 'sapi' | 'elevenlabs'
}

// ── Phase D: Mission types ───────────────────────────────────────────────────

export type MissionStatus =
  | 'planning' | 'running' | 'waiting_approval' | 'verifying'
  | 'recovering' | 'completed' | 'failed' | 'cancelled'

export type MissionStepStatus =
  | 'pending' | 'running' | 'verifying' | 'succeeded' | 'failed' | 'retrying' | 'skipped'

export interface MissionStep {
  id: string
  goal: string           // human-readable intent
  tool: string
  args: Record<string, unknown>
  expectedResult: string // what deterministic check to run
  risk: RiskLevel
  status: MissionStepStatus
  retryCount: number
  maxRetries: number
  startedAt?: number
  completedAt?: number
  verificationPassed?: boolean
  error?: string
}

export interface MissionObservation {
  timestamp: number
  activeWindow: string
  activeWindowPid: number
  browserUrl?: string
  browserTitle?: string
  // Compact list — NOT full DOM/screenshots
  interactiveElements?: Array<{ role: string; name: string; tag: string }>
  dialogs?: string[]
  lastActionResult?: string
  verificationResult?: string
}

export interface Mission {
  id: string
  userGoal: string
  status: MissionStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  currentStepId?: string
  steps: MissionStep[]
  observations: MissionObservation[]
  finalResult?: string
  error?: string
  // Security context — required for any security-testing mission
  securityWorkspaceId?: string
}

// Structured activity events emitted by MissionEngine
export type MissionEventType =
  | 'mission.started' | 'mission.planned' | 'mission.replanning'
  | 'mission.completed' | 'mission.failed' | 'mission.cancelled'
  | 'step.started' | 'step.authorizing' | 'step.approved' | 'step.action'
  | 'step.verifying' | 'step.succeeded' | 'step.failed' | 'step.retrying'

export interface MissionEvent {
  type: MissionEventType
  missionId: string
  stepId?: string
  timestamp: number
  // PRIVACY: never include passwords, tokens, typed text, clipboard secrets
  meta?: Record<string, string | number | boolean>
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
  localModelPath: 'E:\\Goga-Models\\hf_bartowski_Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  localModelContextSize: 4096,
  localModelGpuLayers: 35,
  primaryModel: 'local',
  modelEndpoint: 'http://localhost:11434',
  modelName: 'llama3',
  visionModelName: 'llava:13b',
  agentMaxSteps: 20,
  voiceEnabled: true,
  voiceName: '',
  voiceRate: 1.0,
  voiceVolume: 1.0,
  wakeWordEnabled: false,
  wakePhrase: 'hey goga',
  autoSpeakResponses: true,
  allowBargeIn: true,
  conversationWindowSecs: 45,
  userName: 'Boss',
  sttProvider: 'windows',
  whisperModel: 'base',
  whisperDevice: 'cpu',
  whisperLanguage: '',
  ttsProvider: 'sapi'
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
