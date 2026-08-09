import type { Action, ChatMessage, LogEntry, MemoryEntry, AppSettings, AgentState, AgentStep, SecurityWorkspace, SecurityFinding, EvidenceEntry } from './types'
import type { ScreenshotResult, ActiveWindowResult } from '../main/adapters/desktop'

export type { ScreenshotResult, ActiveWindowResult }

// Channels: renderer -> main (invoke)
export interface MainHandlers {
  // Chat
  'chat:send': (message: string) => Promise<ChatMessage>

  // Actions / approvals
  'action:approve': (actionId: string) => Promise<Action>
  'action:reject': (actionId: string) => Promise<Action>
  'action:stop': () => Promise<void>
  'actions:list': () => Promise<Action[]>

  // Agent loop
  'agent:start': (task: string) => Promise<void>
  'agent:stop': () => Promise<void>
  'agent:state': () => Promise<AgentState>

  // Phase D: Mission engine
  'mission:start': (goal: string) => Promise<string>   // returns missionId
  'mission:stop': (missionId: string) => Promise<void>
  'mission:state': (missionId: string) => Promise<import('./types').Mission | null>
  'mission:list': () => Promise<import('./types').Mission[]>

  // Memory
  'memory:get': (key: string) => Promise<MemoryEntry | null>
  'memory:set': (key: string, value: unknown) => Promise<MemoryEntry>
  'memory:list': () => Promise<MemoryEntry[]>
  'memory:delete': (key: string) => Promise<void>

  // Logs
  'logs:list': () => Promise<LogEntry[]>
  'logs:clear': () => Promise<void>

  // Settings
  'settings:get': () => Promise<AppSettings>
  'settings:set': (settings: Partial<AppSettings>) => Promise<AppSettings>

  // Desktop (direct IPC — also available as agent tools)
  'desktop:screenshot': (displayId?: number) => Promise<ScreenshotResult>
  'desktop:activeWindow': () => Promise<ActiveWindowResult>
  'desktop:moveCursor': (x: number, y: number) => Promise<{ x: number; y: number }>
  'desktop:click': (x: number, y: number, button?: 'left' | 'right') => Promise<{ x: number; y: number; button: string }>
  'desktop:typeText': (text: string) => Promise<{ typed: string }>
  'desktop:pressKey': (key: string) => Promise<{ key: string }>
  'desktop:listDisplays': () => Promise<{ id: string | number; name: string }[]>

  // TTS / STT
  'tts:speak': (text: string) => Promise<void>
  'tts:stop': () => Promise<void>
  'tts:voices': () => Promise<string[]>
  'stt:start': () => Promise<{ transcript: string }>
  'stt:stop': () => Promise<void>
  // Voice orchestrator
  'voice:listenOnce': () => Promise<void>
  'voice:stopListening': () => Promise<void>
  'voice:stopSpeaking': () => Promise<void>
  'voice:startWakeLoop': () => Promise<void>
  'voice:stopWakeLoop': () => Promise<void>
  'voice:status': () => Promise<import('../main/services/voiceOrchestrator').VoiceStatus>

  // Library
  'library:ingest': (filePath: string) => Promise<import('./types').BookMeta>
  'library:list': () => Promise<import('./types').BookMeta[]>
  'library:delete': (bookId: string) => Promise<void>
  'library:search': (query: string, topK?: number) => Promise<import('./types').BookChunk[]>

  // Brain
  'brain:facts': () => Promise<import('./types').GogaFact[]>
  'brain:deleteFact': (id: string) => Promise<void>
  'brain:clearHistory': () => Promise<void>
  'ollama:status': () => Promise<boolean>
  'ollama:models': () => Promise<string[]>
  'localModel:status': () => Promise<import('../main/services/localLlama').LocalModelState>

  // Security workspace
  'security:list': () => Promise<SecurityWorkspace[]>
  'security:get': (id: string) => Promise<SecurityWorkspace | null>
  'security:create': (data: Omit<SecurityWorkspace, 'id' | 'findings' | 'evidence' | 'auditLog' | 'createdAt' | 'updatedAt'>) => Promise<SecurityWorkspace>
  'security:update': (id: string, patch: Partial<SecurityWorkspace>) => Promise<SecurityWorkspace>
  'security:delete': (id: string) => Promise<void>
  'security:setActive': (id: string | null) => Promise<void>
  'security:getActive': () => Promise<SecurityWorkspace | null>
  'security:addFinding': (workspaceId: string, finding: Omit<SecurityFinding, 'id' | 'createdAt' | 'updatedAt'>) => Promise<SecurityFinding>
  'security:addEvidence': (workspaceId: string, evidence: Omit<EvidenceEntry, 'id' | 'createdAt'>) => Promise<EvidenceEntry>
  'security:checkScope': (workspaceId: string, target: string) => Promise<{ inScope: boolean; reason: string }>
}

// Channels: main -> renderer (on)
export interface RendererEvents {
  'chat:message': ChatMessage
  'chat:token': { token: string }
  'action:update': Action
  'action:approval-required': Action
  'log:entry': LogEntry
  'agent:step': AgentStep
  'agent:state': AgentState
  'agent:stopped': { reason: string }
  // Phase D: Mission events
  'mission:event': import('./types').MissionEvent
  'mission:state': import('./types').Mission
  // Voice
  'voice:status': { status: import('../main/services/voiceOrchestrator').VoiceStatus }
  'voice:transcript': { text: string }
}

export type MainChannel = keyof MainHandlers
export type RendererChannel = keyof RendererEvents
