import type { Action, ChatMessage, LogEntry, MemoryEntry, AppSettings, AgentState, AgentStep } from './types'
import type { ScreenshotResult, ActiveWindowResult } from '../main/adapters/desktop'

export type { ScreenshotResult, ActiveWindowResult }

// Channels: renderer -> main (invoke)
export interface MainHandlers {
  'markets:state': () => Promise<import('./markets').MarketsState>
  'markets:import': (symbol: string, csv: string) => Promise<import('./markets').MarketsState>
  'markets:watchlist': (symbols: string[]) => Promise<import('./markets').MarketsState>
  'markets:backtest': (config: import('./markets').BacktestRequest) => Promise<import('./markets').MarketsState>
  'developer:state': () => Promise<import('./developer').DeveloperState>
  'developer:self': () => Promise<import('./developer').DeveloperState>
  'developer:choose': () => Promise<import('./developer').DeveloperState>
  'developer:refresh': () => Promise<import('./developer').DeveloperState>
  'developer:start': (task: string, mode: 'plan' | 'build') => Promise<import('./developer').DeveloperState>
  'developer:stop': () => Promise<import('./developer').DeveloperState>
  // Chat
  'chat:send': (message: string, attachments?: import('./attachments').ChatAttachment[]) => Promise<ChatMessage>

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
  'mission:enabled': () => Promise<boolean>
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
  // A readable reason the settings file was not used, or null when it loaded.
  'settings:load-error': () => Promise<string | null>
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
  'voice:startWakeLoop': () => Promise<import('../main/services/wakeWord').WakeStatus>
  'voice:stopWakeLoop': () => Promise<import('../main/services/wakeWord').WakeStatus>
  'voice:status': () => Promise<import('../main/services/voiceOrchestrator').VoiceStatus>
  /** The honest state of the always-on listener: off / starting / listening / request / error. */
  'voice:wakeStatus': () => Promise<import('../main/services/wakeWord').WakeStatus>
  /** Ask Windows whether a microphone exists and can be opened. Starts nothing. */
  'voice:probeMic': () => Promise<import('../main/services/wakeWord').MicProbe>

  // Library
  'library:ingest': (filePath?: string) => Promise<import('./types').BookMeta>
  'library:list': () => Promise<import('./types').BookMeta[]>
  'library:delete': (bookId: string) => Promise<void>
  'library:search': (query: string, topK?: number) => Promise<import('./types').BookChunk[]>
  'library:listRepo': (repoUrl: string) => Promise<import('../main/services/webLibrary').RepoDoc[]>
  'library:importUrl': (url: string) => Promise<import('./types').BookMeta>

  // Brain
  'brain:facts': () => Promise<import('./types').GogaFact[]>
  'brain:deleteFact': (id: string) => Promise<void>
  'brain:clearHistory': () => Promise<void>
  'ollama:status': () => Promise<boolean>
  'ollama:models': () => Promise<string[]>
  'localModel:status': () => Promise<import('../main/services/localLlama').LocalModelState>
  'localModel:list': () => Promise<string[]>
  'remote:status': () => Promise<{ listening: boolean; port: number | null; addresses: string[]; devices: { id: string; name: string; pairedAt: number; lastSeen?: number }[]; error: string | null }>
  'remote:pair': () => Promise<string>
  'remote:forget': (id: string) => Promise<void>
  'flux:status': () => Promise<import('../main/services/fluxLink').FluxStatus>
  'flux:connect': () => Promise<import('../main/services/fluxLink').FluxStatus>
  'flux:disconnect': () => Promise<import('../main/services/fluxLink').FluxStatus>
  'trading:status': () => Promise<import('../main/handlers/trading').TradingStatus>
  'trading:saveKeys': (keyId: string, secret: string) => Promise<import('../main/handlers/trading').TradingStatus>
  'trading:forgetKeys': () => Promise<import('../main/handlers/trading').TradingStatus>

  // Alpaca broker (read-only account data, prepared orders, kill switch)
  'broker:snapshot': (mode: import('./broker').BrokerMode) => Promise<import('./broker').BrokerSnapshot>
  'broker:prepare': (input: {
    mode: import('./broker').BrokerMode
    symbol: string
    side: 'buy' | 'sell'
    qty?: number | null
    notional?: number | null
    orderType?: 'market' | 'limit'
    limitPrice?: number | null
    reason: string
  }) => Promise<import('./broker').OrderIntent>
  'broker:approve': (intentId: string, approved: boolean) => Promise<import('./broker').OrderIntent>
  'broker:send': (intentId: string) => Promise<import('./broker').BrokerOrderResult>
  'broker:kill': (mode: import('./broker').BrokerMode, reason: string) => Promise<import('./broker').KillSwitchResult>
  'broker:clearKill': () => Promise<import('./broker').KillSwitchResult>
  'broker:setLive': (enabled: boolean, phrase: string) => Promise<{ liveEnabled: boolean; message: string }>
  'broker:audit': (limit?: number) => Promise<import('./broker').OrderAuditEntry[]>
  'broker:limits': () => Promise<import('./broker').RiskLimitsView>
  'broker:savePaperKeys': (keyId: string, secret: string) => Promise<{ ok: boolean; error: string | null }>
  'broker:saveLiveKeys': (keyId: string, secret: string) => Promise<{ ok: boolean; error: string | null }>
  'broker:forgetLiveKeys': () => Promise<{ ok: boolean }>
  'broker:keyState': () => Promise<{ paper: boolean; live: boolean }>

  // The general browser-control layer: attach to Firefox, read and drive a page
  'browser:readiness': () => Promise<{
    engine: 'firefox' | 'brave'
    firefox: { engine: 'firefox' | 'brave'; installed: boolean; executable: string | null; message: string; overrideVar: string }
    brave: { engine: 'firefox' | 'brave'; installed: boolean; executable: string | null; message: string; overrideVar: string }
  }>
  'browser:status': () => Promise<import('./browser').BrowserStatus>
  'browser:start': (url?: string) => Promise<import('./browser').BrowserStatus>
  'browser:attach': () => Promise<import('./browser').BrowserStatus>
  'browser:detach': () => Promise<import('./browser').BrowserStatus>
  'browser:tabs': () => Promise<import('./browser').BrowserTab[]>
  'browser:selectTab': (id: string) => Promise<import('./browser').BrowserTab>
  'browser:navigate': (url: string) => Promise<{ url: string; title: string }>
  'browser:readPage': () => Promise<import('./browser').PageRead>
  'browser:find': (query: import('./browser').ElementQuery) => Promise<import('./browser').FoundElement>
  'browser:click': (query: import('./browser').ElementQuery) => Promise<{ clicked: string }>
  'browser:type': (query: import('./browser').ElementQuery, text: string) => Promise<{ typed: string }>
  'browser:readValue': (query: import('./browser').ElementQuery) => Promise<{ found: boolean; value: string | null; visible: boolean }>
  'browser:waitForText': (text: string, exact?: boolean, timeoutMs?: number) => Promise<{ found: boolean; firstText: string }>
  'browser:waitForElement': (query: import('./browser').ElementQuery, timeoutMs?: number) => Promise<import('./browser').FoundElement>
  'browser:screenshot': () => Promise<{ base64: string; url: string }>
  'browser:recipes': () => Promise<import('./browser').SiteRecipe[]>
  'browser:learn': () => Promise<import('./browser').SiteRecipe>
  'browser:correctRecipe': (host: string, notes: string) => Promise<import('./browser').SiteRecipe>
  'browser:forgetRecipe': (host: string) => Promise<import('./browser').SiteRecipe[]>

  // One persistent Brave window the user signs in to Cantina by hand (dedicated Goga profile)
  'brave:openForCantina': () => Promise<import('../main/services/browser/braveSession').BraveSessionStatus>
  'brave:status': () => Promise<import('../main/services/browser/braveSession').BraveSessionStatus>
  'brave:confirmSignedIn': () => Promise<import('../main/services/browser/braveSession').BraveSessionStatus>
  'brave:closeCantina': () => Promise<import('../main/services/browser/braveSession').BraveSessionStatus>
  'brave:navigateRead': (url: string) => Promise<{ ok: boolean; read: import('../main/services/browser/braveSession').BravePageRead | null; message: string }>
  'brave:readCurrent': () => Promise<{ ok: boolean; read: import('../main/services/browser/braveSession').BravePageRead | null; message: string }>
  /** Which Brave Goga drives, and switching it. Persisted in settings. */
  'brave:mode': () => Promise<{ mode: import('./braveMode').BraveSessionMode; status: import('../main/services/browser/braveSession').BraveSessionStatus }>
  'brave:setMode': (mode: import('./braveMode').BraveSessionMode) => Promise<{ mode: import('./braveMode').BraveSessionMode; status: import('../main/services/browser/braveSession').BraveSessionStatus }>
  /** Read the Cantina page Goga is on and say whether that page shows a signed-in account. */
  'brave:checkSignedIn': () => Promise<import('../main/services/browser/braveSession').BraveSessionStatus>

  // The Lab: declared targets, payload dispatch, and the local WordPress XSS path
  'lab:state': () => Promise<{
    targets: import('./lab').DeclaredTarget[]
    runs: import('./lab').LabRun[]
    payloads: { id: string; targetHost: string; method: string; marker: string; status: string }[]
    running: boolean
    killed: number
  }>
  'lab:stop': (reason?: string) => Promise<{ message: string }>
  /** What the live view shows on open: the log so far, the last real capture, and whether a run is working. */
  'lab:liveState': () => Promise<import('./lab').LabLiveState>
  /** Ask for one fresh picture of the browser Goga drives. Read-only; it starts nothing. */
  'lab:capturePane': () => Promise<{ ok: boolean; message?: string; frame?: import('./lab').LiveFrame | null }>
  'lab:declareTarget': (input: { host: string; ports?: string; kind: import('./lab').TargetKind; note: string }) => Promise<{ ok: boolean; message: string; target: import('./lab').DeclaredTarget | null }>
  'lab:revokeTarget': (id: string, reason: string) => Promise<{ ok: boolean; message: string }>
  'lab:checkPayloadTarget': (url: string) => Promise<{ allowed: boolean; host: string | null; port: number | null; targetId: string | null; reason: string }>
  'lab:preparePayload': (input: { urlTemplate: string; payload: string; marker: string; method?: 'GET' | 'POST'; why?: string }) => Promise<{ ok: boolean; message: string; proposal: { id: string; url: string; method: string; payload: string; marker: string; targetHost: string } | null }>
  'lab:decidePayload': (id: string, approved: boolean) => Promise<{ ok: boolean; message: string }>
  'lab:dispatchPayload': (id: string) => Promise<import('./lab').PayloadResult>
  'lab:readXssSinks': (root: string, file: string) => Promise<{
    file: string
    bytes: number
    candidates: { file: string; line: number; excerpt: string; context: string; observable: string | null; why: string; wouldConfirm: string[] }[]
    dropped: { file: string; line: number; excerpt: string; context: string; outcome: string; why: string }[]
  }>
  'lab:wpXssPath': (root: string, file: string, line?: number) => Promise<{
    executed: boolean; reflected: boolean; tookAsMarkup: boolean; contextMatched: boolean
    context: string; payload: string; expectedTitle: string; status: number | null; bytes: number
    excerpt: string; steps: { step: string; detail: string }[]
    source: { file: string; line: number; excerpt: string; observable: string | null; wouldConfirm: string[] }
    finding: { title: string; detail: string; evidence: string } | null
    caveat: string
  }>

  // Joining a source finding to a live attempt in the signed-in Brave session
  /** The policy quotes and the rate/volume ceiling the join view must show. Read-only. */
  'lab:joinPolicy': () => Promise<import('./lab').JoinPolicyView>
  /** Promote a source finding to a proposed live attempt. Sends nothing. */
  'lab:joinPrepare': (input: {
    root: string; file: string; line?: number; targetUrl: string
    limits?: Partial<import('./lab').RunBudget>
  }) => Promise<{ ok: boolean; message: string; attempt: import('./lab').JoinAttemptView | null }>
  'lab:joinDecide': (id: string, approved: boolean) => Promise<{ ok: boolean; message: string; attempt: import('./lab').JoinAttemptView | null }>
  'lab:joinSend': (id: string) => Promise<import('./lab').JoinSendResult>
  'lab:joins': () => Promise<import('./lab').JoinAttemptView[]>
  /** The kill switch for one joining run. */
  'lab:joinStop': (id: string) => Promise<{ ok: boolean; message: string }>
  /** Assemble a draft from a confirmed finding. Local only; there is no submission path. */
  'lab:joinDraft': (id: string, notes?: { verifiedByUser: boolean; aiExtent?: string }) => Promise<{ ok: boolean; message: string; draft: import('./lab').JoinDraft | null }>

  // The two practice venues, the shared approval gate, the shared learning loop
  'venue:info': () => Promise<Record<import('./venues').VenueId, import('./venues').VenueInfo>>
  'venue:halt': (venue: import('./venues').VenueId, halted: boolean, reason: string) => Promise<import('../main/services/venues/state').VenueHalt>
  'venue:haltState': (venue: import('./venues').VenueId) => Promise<import('../main/services/venues/state').VenueHalt>
  'venue:events': (limit?: number) => Promise<import('../main/services/venues/state').VenueEvent[]>
  'venue:pivexRead': () => Promise<import('../main/services/venues/pivex').PivexRead>
  'venue:pivexQuote': (symbol: string) => Promise<import('./venues').VenueQuote | null>
  'venue:pivexPrepare': (input: import('../main/services/venues/pivex').PivexPrepareInput) => Promise<import('./venues').VenueTicket>
  'venue:pivexSend': (ticketId: string) => Promise<import('./venues').VenueSendResult>
  'venue:alpacaRead': () => Promise<import('../main/services/venues/alpaca').AlpacaRead>
  'venue:alpacaQuote': (symbol: string) => Promise<import('./venues').VenueQuote | null>
  'venue:alpacaPrepare': (input: import('../main/services/venues/alpaca').AlpacaPrepareInput) => Promise<import('./venues').VenueTicket>
  'venue:alpacaSend': (ticketId: string) => Promise<import('./venues').VenueSendResult>
  'venue:approve': (ticketId: string, approved: boolean) => Promise<{ ok: boolean; message: string; ticket: import('./venues').VenueTicket | null }>
  'venue:ticket': (ticketId: string) => Promise<{ ticket: import('./venues').VenueTicket; approved: boolean; spent: boolean; expired: boolean } | null>
  'venue:stats': (venue: import('./venues').VenueId) => Promise<import('./venues').LoopStats>
  'venue:trades': (limit?: number) => Promise<import('./venues').TradeRecord[]>
  'venue:closeTrade': (venue: import('./venues').VenueId, symbol: string, exitPrice: number, contractSize?: number) => Promise<{ ok: boolean; message: string; trade: import('./venues').TradeRecord | null }>
  'venue:studyBase': () => Promise<import('../main/services/venues/study').StudyBase>

  // Bug bounty: programs, scope, one approved request, drafts, study material
  'security:programs': () => Promise<{
    programs: import('./security').ProgramImport[]
    active: import('./security').ProgramImport | null
    credentials: Record<'hackerone' | 'bugcrowd', { configured: boolean; encryptionAvailable: boolean }>
    connections: Record<'hackerone' | 'bugcrowd', import('./security').PlatformConnection>
  }>
  /** A real, narrow call to the platform. This is what decides connected / rejected / expired. */
  'security:checkConnection': (source: import('./security').ProgramSource) => Promise<import('./security').PlatformConnection>
  /** The platform's own directory of programs this account can see. */
  'security:listPrograms': (source: import('./security').ProgramSource) => Promise<{
    programs: import('./security').ProgramSummary[]
    pages: number
    participating: number
    connection: import('./security').PlatformConnection
  }>
  /** Import several programs in one pass; each one reports its own outcome. */
  'security:importMany': (source: import('./security').ProgramSource, handles: string[]) => Promise<{
    results: import('./security').ProgramImportResult[]
    programs: import('./security').ProgramImport[]
    active: import('./security').ProgramImport | null
  }>
  'security:credentials': (source: import('./security').ProgramSource, user: string, token: string) => Promise<Record<'hackerone' | 'bugcrowd', { configured: boolean; encryptionAvailable: boolean }>>
  'security:clearCredentials': (source: import('./security').ProgramSource) => Promise<Record<'hackerone' | 'bugcrowd', { configured: boolean; encryptionAvailable: boolean }>>
  'security:import': (source: import('./security').ProgramSource, handle: string) => Promise<import('./security').ProgramImport>
  'security:setActive': (id: string | null) => Promise<{ programs: import('./security').ProgramImport[]; active: import('./security').ProgramImport | null }>
  'security:remove': (id: string) => Promise<{ programs: import('./security').ProgramImport[]; active: import('./security').ProgramImport | null }>
  'security:program': (id: string) => Promise<import('./security').ProgramImport | null>
  'security:toolbox': () => Promise<import('./toolboxTypes').ToolboxCatalog>
  'security:toolboxSearch': (query: string) => Promise<import('./toolboxTypes').ToolboxSearchResult[]>
  'security:toolboxTool': (identifier: string) => Promise<import('./toolboxTypes').ToolReference | null>
  'security:checkTarget': (target: string, technique?: string) => Promise<{ decision: import('./security').ScopeDecision; program: { id: string; name: string } | null }>
  'security:approveRequest': (target: string, method: string) => Promise<{ grantId: string; decision: import('./security').ScopeDecision }>
  'security:previewBounty': () => Promise<{
    program: { id: string; name: string; source: string }
    hosts: { host: string; asset: string }[]
    outOfScope: string[]
    exclusions: { category: string; details: string }[]
    automatedTestingRule: string | null
    requiresAck: boolean
    tools: { id: string; name: string; installed: boolean }[]
  }>
  'security:startBounty': (focus?: string, acknowledgeAutomationRule?: boolean) => Promise<{ jobId: string; declared: { host: string; targetId: string }[]; program: { id: string; name: string } }>
  'security:findings': () => Promise<import('./security').Finding[]>
  'security:addFinding': (input: { title: string; severity: import('./security').Finding['severity']; asset: string; summary: string; steps: string; impact: string; remediation: string; evidence: string }) => Promise<import('./security').Finding>
  'security:updateFinding': (id: string, patch: Partial<import('./security').Finding>) => Promise<import('./security').Finding>
  'security:deleteFinding': (id: string) => Promise<void>
  'security:audit': (limit?: number) => Promise<import('./security').SecurityAuditEntry[]>
  'security:curriculum': () => Promise<import('./security').Curriculum>
  'security:lesson': (id: string) => Promise<import('./security').Lesson | null>

  // Grimoire: specialist review, the independent validator, knowledge base, memory
  'grimoire:specialists': () => Promise<import('./grimoire').Specialist[]>
  'grimoire:knowledge': () => Promise<import('./grimoire').KnowledgeBase>
  'grimoire:gate': () => Promise<import('./grimoire').GateQuestion[]>
  'grimoire:indexTarget': (root: string) => Promise<import('./grimoire').LocalTarget>
  'grimoire:reviewFile': (input: { root: string; path: string; marker?: string; specialists?: import('./grimoire').SpecialistId[] }) => Promise<import('./grimoire').ReviewRun>
  'grimoire:reviewText': (input: { text: string; label?: string; marker?: string; specialists?: import('./grimoire').SpecialistId[] }) => Promise<import('./grimoire').ReviewRun>
  'grimoire:sample': (input: { text: string; marker?: string }) => Promise<import('./grimoire').SampledText>
  'grimoire:headers': (headers: Record<string, string>) => Promise<import('./grimoire').HeaderOfInterest[]>
  'grimoire:jsEndpoints': (source: string) => Promise<import('./grimoire').JsEndpoint[]>
  'grimoire:memory': (programId?: string) => Promise<{ entries: import('./grimoire').MemoryEntry[]; summary: import('./grimoire').MemorySummary }>
  'grimoire:forget': (key: string) => Promise<{ entries: import('./grimoire').MemoryEntry[]; summary: import('./grimoire').MemorySummary }>
  'grimoire:gateDecide': (input: { hypothesis: import('./grimoire').Hypothesis; answers: import('./grimoire').GateAnswer[] }) => Promise<import('./grimoire').GateResult>
  'grimoire:importCantina': (url: string) => Promise<{ program: import('./security').ProgramImport; bar: import('./security').ProgramEntryBar }>
  'grimoire:bountyFeed': (query?: string) => Promise<import('./bountyFinder').BountyFeed>
  'grimoire:state': () => Promise<{
    programs: import('./security').ProgramImport[]
    active: import('./security').ProgramImport | null
    specialists: number
    memory: import('./grimoire').MemorySummary
  }>

  // OSINT: public-source people and domain research, with an audit trail
  'osint:state': () => Promise<import('./osint').OsintPageState>
  'osint:run': (kind: import('./osint').OsintKind, params: Record<string, unknown>) => Promise<{ data: unknown; text: string; audit: import('./osint').OsintAuditEntry }>
  'osint:history': (limit?: number) => Promise<import('./osint').OsintAuditEntry[]>
  'osint:saveBreachKey': (key: string) => Promise<import('./osint').OsintBreachKeyState>
  'osint:clearBreachKey': () => Promise<import('./osint').OsintBreachKeyState>

  // Self-improvement loop and the persistent learning layer
  'evolution:state': () => Promise<import('./evolution').EvolutionState>
  'evolution:start': (goal: string) => Promise<import('./evolution').EvolutionRun>
  'evolution:install': () => Promise<import('./evolution').EvolutionRun>
  'evolution:discard': () => Promise<unknown>
  'evolution:notes': () => Promise<import('./evolution').LearningNote[]>
  'evolution:remember': (kind: import('./evolution').LearningNote['kind'], text: string, source: string) => Promise<import('./evolution').LearningNote>
  'evolution:forget': (id: string) => Promise<void>
  'evolution:skills': () => Promise<import('./evolution').SkillRecord[]>
  'evolution:recordSkill': (input: { name: string; whenToUse: string; steps: string[]; tools?: string[] }) => Promise<import('./evolution').SkillRecord>
  'evolution:deleteSkill': (id: string) => Promise<void>

  // Goga working on its own source code: read and search freely, write only on approval
  'selfwork:state': () => Promise<import('./selfwork').SelfWorkState>
  'selfwork:files': () => Promise<import('./selfwork').RepoFile[]>
  'selfwork:read': (path: string, start?: number, count?: number) => Promise<import('./selfwork').RepoRead>
  'selfwork:search': (query: string, max?: number) => Promise<import('./selfwork').RepoHit[]>
  'selfwork:propose': (input: { path: string; summary: string; after: string; operation?: import('./selfwork').SelfWorkOperation }) => Promise<import('./selfwork').SelfWorkProposalView>
  'selfwork:proposePatch': (input: { path: string; summary: string; find: string; replace: string }) => Promise<import('./selfwork').SelfWorkProposalView>
  'selfwork:proposeDelete': (input: { path: string; summary: string }) => Promise<import('./selfwork').SelfWorkProposalView>
  'selfwork:decide': (id: string, approved: boolean) => Promise<{ ok: boolean; message: string; proposal: import('./selfwork').SelfWorkProposalView | null }>
  'selfwork:apply': (id: string) => Promise<{ ok: boolean; message: string; proposal: import('./selfwork').SelfWorkProposalView | null }>
  'selfwork:revert': (id: string) => Promise<{ ok: boolean; message: string }>
  'selfwork:check': (only?: ('build' | 'typecheck' | 'tests')[]) => Promise<import('./selfwork').SelfWorkCheckReport>
  'selfwork:resetRepairs': () => Promise<{ ok: boolean; message: string; repair: import('./selfwork').SelfWorkRepairStatus }>

  // Strategy: the rule-based strategies, backtests, journal, review and the paper loop
  'strategy:state': () => Promise<import('./strategy').StrategyPageState>
  'strategy:backtest': (input: { strategyId: import('./strategy').StrategyId; symbol: string; params?: import('./strategy').StrategyParams; days?: number }) => Promise<import('./strategy').BacktestResult>
  'strategy:review': (strategyId: string, symbol: string) => Promise<import('./strategy').ReviewResult>
  'strategy:saveSettings': (patch: Partial<import('./strategy').StrategySettings>) => Promise<import('./strategy').StrategyPageState>
  'strategy:setPaperRun': (enabled: boolean) => Promise<import('./strategy').PaperRunState>
  'strategy:setAutoApprove': (enabled: boolean) => Promise<import('./strategy').PaperRunState>
  'strategy:runOnce': () => Promise<string>
  'strategy:approvePending': () => Promise<{ ok: boolean; message: string }>
  'strategy:discardPending': () => Promise<{ ok: boolean; message: string }>
  'strategy:journal': (limit?: number) => Promise<import('./strategy').JournalEntry[]>

  // Business: the user's own accounts, drafts, testers, releases and monitoring
  'business:state': () => Promise<import('./business').BusinessPageState>
  'business:digest': () => Promise<import('./business').Digest>
  'business:gmailAuthUrl': (clientId: string, clientSecret: string) => Promise<{ url: string; port: number }>
  'business:gmailPending': () => Promise<boolean>
  'business:connectBluesky': (identifier: string, appPassword: string) => Promise<import('./business').BusinessState>
  'business:connectMastodon': (instance: string, token: string) => Promise<import('./business').BusinessState>
  'business:connectShopify': (shop: string, token: string) => Promise<import('./business').BusinessState>
  'business:connectPrintful': (token: string, storeId: string | null) => Promise<import('./business').BusinessState>
  'business:disconnect': (id: import('./business').ConnectionId) => Promise<import('./business').BusinessState>
  'business:accounts': () => Promise<Record<string, string | null>>
  'business:prepareMail': (input: { to: string; subject: string; body: string; threadId?: string }) => Promise<import('./business').BusinessActionResult>
  'business:preparePost': (platform: 'bluesky' | 'mastodon', text: string, about: string) => Promise<import('./business').BusinessActionResult>
  'business:prepareListing': (input: {
    storefront: import('./business').Storefront
    title: string
    description: string
    tags: string[]
    price: number
    currency: string
    shipping: string
  }) => Promise<import('./business').BusinessActionResult>
  'business:prepareTesterInvite': (appId: string, candidateId: string, subject: string, body: string) => Promise<import('./business').BusinessActionResult>
  'business:approve': (pendingId: string) => Promise<import('./business').BusinessActionResult>
  'business:deny': (pendingId: string) => Promise<import('./business').BusinessActionResult>
  'business:addCandidate': (input: { appId: string; name: string; email: string; source: string; notes: string }) => Promise<import('./business').TesterCandidate>
  'business:setCandidateState': (appId: string, id: string, state: import('./business').TesterState, optedInAt?: string | null) => Promise<import('./business').TesterCandidate>
  'business:forgetCandidate': (appId: string, id: string) => Promise<void>
  'business:setCandidateOptInDate': (appId: string, id: string, date: string) => Promise<import('./business').TesterCandidate>
  'business:addTrackedApp': (input: { name: string; packageName: string; track?: import('./business').PlayTrack; required?: number; optInDays?: number; notes?: string }) => Promise<import('./business').TesterApp>
  'business:editTrackedApp': (appId: string, patch: Partial<Pick<import('./business').TesterApp, 'name' | 'track' | 'required' | 'optInDays' | 'notes'>>) => Promise<import('./business').TesterApp>
  'business:forgetTrackedApp': (appId: string) => Promise<void>
  'business:saveCopyDraft': (channel: string, text: string) => Promise<{ id: string; createdAt: string; channel: string; text: string }>
  'business:forgetCopyDraft': (id: string) => Promise<void>
  'business:forgetListingDraft': (id: string) => Promise<void>
  'business:forgetPostDraft': (id: string) => Promise<void>
  'business:saveProfile': (patch: Record<string, unknown>) => Promise<import('./business').JobProfile>
  'business:addApp': (input: { name: string; url: string; packageName: string; liveVersion: string; publishedWhere: string }) => Promise<import('./business').MonitoredApp>
  'business:forgetApp': (id: string) => Promise<void>
  'business:checkApp': (id: string) => Promise<{ app: import('./business').MonitoredApp; check: import('./business').HealthCheck }>
  'business:checkAll': () => Promise<{ results: { id: string; check: import('./business').HealthCheck }[] }>
  'business:build': (id: string) => Promise<import('./business').BuildProject>
  'business:run': (id: string) => Promise<import('./business').BuildProject>
  'business:stop': (id: string) => Promise<import('./business').BuildProject>
  'business:searches': () => Promise<import('./business').SavedSearch[]>

  // Google Play Console: the service account key, the read-only baseline, and the gated upload
  'business:playState': () => Promise<import('./business').PlayState>
  'business:playPickKey': () => Promise<{ canceled: boolean; path: string | null }>
  'business:playUseKeyFile': (filePath: string) => Promise<{ ok: boolean; message: string; state: import('./business').PlayState }>
  'business:playPasteKey': (text: string) => Promise<{ ok: boolean; message: string; state: import('./business').PlayState }>
  'business:playCheckAccess': () => Promise<import('./business').PlayState>
  'business:playReadBaseline': () => Promise<import('./business').PlayBaseline>
  'business:playForget': () => Promise<import('./business').PlayState>
  'business:playPickBundle': () => Promise<{ canceled: boolean; path: string | null }>
  'business:playPrepareUpload': (input: {
    packageName: string
    track: string
    aabPath: string
    versionCode: string
    releaseNotes: string
    language?: string
  }) => Promise<{ ok: boolean; message: string; submission: import('./business').PlaySubmissionView | null; state: import('./business').PlayState }>

  // Persona: who Goga is, the user's own notes, and what he remembers
  'persona:state': () => Promise<import('./persona').PersonaState>
  'persona:save': (text: string) => Promise<import('./persona').PersonaState>
  'persona:forgetFact': (id: string) => Promise<boolean>

  // Jobs: separate workers with their own goals, questions and reports
  'jobs:state': () => Promise<import('./jobs').JobsView>
  'jobs:create': (input: { goal: string; title?: string; maxSteps?: number; maxMinutes?: number }) => Promise<{ job: import('./jobs').Job; view: import('./jobs').JobsView }>
  'jobs:answer': (jobId: string, answer: string) => Promise<import('./jobs').JobsView>
  'jobs:cancel': (jobId: string) => Promise<import('./jobs').JobsView>
  'jobs:resume': (jobId: string) => Promise<import('./jobs').JobsView>
  'jobs:setCap': (cap: number) => Promise<import('./jobs').JobsView>
  'jobs:shutdown': () => Promise<void>

  // Setup: the installed-tool catalogue, install proposals, virtualisation and VMs
  'setup:catalogue': () => Promise<import('./setup').CatalogueReading>
  'setup:virtualisation': () => Promise<import('./setup').VirtualisationReport>
  'setup:state': () => Promise<import('./setup').SetupPageState>
  'setup:audit': (limit?: number) => Promise<import('./setup').SetupAuditEntry[]>
  'setup:proposeInstall': (input: {
    package: string
    task: string
    why?: string
    withoutIt?: string
    vendorUrl?: string
    version?: string
  }) => Promise<import('./setup').InstallProposalResult>
  'setup:decideInstall': (proposalId: string, approved: boolean) => Promise<{ ok: boolean; message: string; proposal: import('./setup').InstallProposal | null }>
  'setup:runInstall': (proposalId: string) => Promise<import('./setup').InstallRunResult>
  'setup:vmImages': () => Promise<{ key: string; name: string; url: string; vendorHost: string; verification: string; downloadGb: number }[]>
  'setup:vmDefaults': () => Promise<import('./setup').VmResources>
  'setup:proposeVm': (input: {
    purpose: string
    usedFor: string
    name?: string
    image?: string
    provider?: import('./setup').VirtualisationProvider
    cpuCores?: number
    memoryGb?: number
    diskGb?: number
  }) => Promise<import('./setup').VmProposalResult>
  'setup:decideVm': (proposalId: string, approved: boolean) => Promise<{ ok: boolean; message: string; proposal: import('./setup').VmProposal | null }>
  'setup:createVm': (proposalId: string) => Promise<{ ok: boolean; message: string }>
  'setup:explainFeatureEnable': (feature: string) => Promise<{ ok: boolean; message: string }>

  // Kokoro model management
  'model:kokoro-status': () => Promise<{ installed: boolean; downloading: boolean }>
  'model:kokoro-preflight': () => Promise<{
    commit: string
    manifestVersion: string
    totalSize: string
    destination: string
    artifacts: Array<{ filename: string; sha256: string; sizeMB: string }>
  }>
  'model:kokoro-download': () => Promise<void>

  // Reload TTS provider after settings change — returns error string or null
  'voice:reload-tts': () => Promise<string | null>

  // Whisper STT pre-download disclosure (no network, no process spawned)
  'whisper:preflight': (model: string, device: string) => Promise<{
    model: string; device: string; downloadMB: number;
    cached: boolean; cacheDir: string; source: string
  }>

}

// Channels: main -> renderer (on)
export interface RendererEvents {
  'developer:state': import('./developer').DeveloperState
  'chat:message': ChatMessage
  'chat:token': { token: string; turnId: string }
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
  'voice:wakeStatus': import('../main/services/wakeWord').WakeStatus
  // Kokoro download progress
  'model:kokoro-progress': import('../main/services/modelManager').DownloadProgress
  'voice:transcript': { text: string }
  'voice:partial': { text: string }
  'voice:amplitude': { value: number }
  // Whisper model download disclosure (emitted before first recognition if model not cached)
  'whisper:download-required': { model: string; device: string; downloadMB: number; cached: boolean; cacheDir: string; source: string }
  // Self-improvement progress
  'evolution:status': string
  'evolution:update': import('./evolution').EvolutionState
  // Job board: any change to any job, plus the queue numbers
  'jobs:update': import('./jobs').JobsView  // The live view of a Lab run: one entry as it happens, one real browser picture, or a
  // state change. A typed channel, so the renderer gets nothing it has no type for.
  'lab:live': import('./lab').LabLiveEvent
}

export type MainChannel = keyof MainHandlers
export type RendererChannel = keyof RendererEvents
