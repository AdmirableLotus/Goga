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
  /** True when this action was created by the agent loop's approval gate.
   *  On approve: only resolveApproval is called — desktop.execute is NOT.
   *  False/absent: legacy desktop action — only desktop.execute is called. */
  agentOwned?: boolean
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

export interface MonitorInfo {
  /** Stable index assigned by EnumDisplayMonitors (0-based, consistent within a session) */
  index: number
  /** Win32 HMONITOR value — stable within a session, not across reboots */
  hmonitor: number
  /** Full monitor bounds in virtual-desktop coordinates (may include negative x/y) */
  bounds: Rect
  /** Work area (excludes taskbar) in virtual-desktop coordinates */
  workArea: Rect
  /** True if this is the primary monitor (origin 0,0 in virtual-desktop space) */
  primary: boolean
  /**
   * DPI scale factor reported by GetDpiForMonitor (MDT_EFFECTIVE_DPI).
   * 1.0 = 96 DPI (100%), 1.25 = 125%, 1.5 = 150%, 2.0 = 200%.
   * Screenshot pixels are in physical pixels; mouse input coordinates are in
   * logical (scaled) pixels. To convert screenshot pixel → input coordinate:
   *   inputX = monitorBounds.x + Math.round(pixelOffsetX / scaleFactor)
   * NOTE: this mapping is only verified for screenshots; cross-monitor clicking
   * has not been end-to-end tested. Do not use for automated clicking until verified.
   */
  scaleFactor: number
  /** Device name e.g. "\\\\.\\DISPLAY1" */
  deviceName: string
}

export interface VirtualDesktopBounds {
  /** Leftmost x across all monitors (may be negative) */
  left: number
  /** Topmost y across all monitors (may be negative) */
  top: number
  /** Total width spanning all monitors */
  width: number
  /** Total height spanning all monitors */
  height: number
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
  category: 'computer' | 'browser' | 'shell' | 'filesystem' | 'process' | 'vision' | 'memory' | 'web' | 'android' | 'system'
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
  /** How the step's effect was checked after the tool ran. */
  check?: StepCheck
}

/** passed/failed come from a tool error or a deterministic check; doubtful is a vision
 *  model's negative opinion (advisory only); unchecked means nothing could confirm it. */
export interface StepCheck {
  outcome: 'passed' | 'failed' | 'doubtful' | 'unchecked'
  method: string
  detail: string
}

export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'done' | 'error' | 'stopped'

export interface AgentState {
  status: AgentStatus
  task: string
  steps: AgentStep[]
  currentTool?: string
  error?: string
  /** Completed task text, retained with the latest state for UI reopening. */
  reply?: string
}

export interface ChatMessage {
  attachments?: import('./attachments').ChatAttachment[]
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
  // Ollama embedding model for semantic memory recall ('' disables, keyword match only)
  embeddingModelName: string
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
  // Free-text notes from the user on how Goga should behave (Settings → Personality)
  personality: string
  // Paired devices (Rabbit R1) reaching Goga over the home network
  remoteEnabled: boolean
  remotePort: number
  sttProvider: 'windows' | 'whisper'
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v2' | 'large-v3'
  whisperDevice: 'cuda' | 'cpu' | 'auto'
  whisperLanguage: string
  ttsProvider: 'kokoro' | 'sapi' | 'elevenlabs'
  // Sleep mode: closing the window keeps Goga in the tray, watching and listening
  sleepOnClose: boolean
  startWithWindows: boolean
  guardianEnabled: boolean
  routineLearning: boolean
  // Practice trading risk rules, enforced in code on every order
  tradingMaxPositionPct: number
  tradingRequireStop: boolean
  tradingDailyLossPct: number
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

// Long enough for a few paragraphs, short enough to leave the 8K brain room to think.
export const MAX_PERSONALITY_CHARS = 1500

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
  visionModelName: 'qwen3-vl:4b',
  embeddingModelName: 'nomic-embed-text',
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
  personality: '',
  remoteEnabled: false,
  remotePort: 8765,
  sttProvider: 'windows',
  whisperModel: 'base',
  whisperDevice: 'cpu',
  whisperLanguage: '',
  ttsProvider: 'sapi',
  sleepOnClose: true,
  startWithWindows: true,
  guardianEnabled: true,
  routineLearning: true,
  tradingMaxPositionPct: 10,
  tradingRequireStop: true,
  tradingDailyLossPct: 3
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
  policyReview?: import('./securityGuide').PolicyReview
  hackerOne?: {
    handle: string
    importedAt: number
    submissionState: string
    scopes: Array<{ id: string; identifier: string; type: string; eligible: boolean; instruction: string }>
  }
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
