# Goga — Local-First AI Desktop Operator

Goga is a local-first AI agent that runs on your PC. It uses Electron for privileged system access, React for the UI, and TypeScript throughout.

---

## Architecture

```
src/
├── main/               # Electron main process (Node.js, privileged)
│   ├── index.ts        # App entry, window creation
│   ├── handlers/       # IPC handlers (chat, actions, memory, logs, settings)
│   ├── services/       # Orchestrator, ActionStore, Memory, Logs, Settings
│   ├── adapters/       # Tool adapters (desktop, browser, research, disabled stubs)
│   └── utils/          # Shared utilities
├── preload/
│   └── index.ts        # contextBridge API exposed to renderer
├── renderer/           # React UI (no Node access)
│   ├── pages/          # Chat, Activity, Approvals, Memory, Settings
│   ├── components/     # StopButton, shared UI
│   └── styles.css      # Global dark theme
└── shared/
    ├── types.ts         # Action, ChatMessage, LogEntry, MemoryEntry, AppSettings
    └── ipc.ts           # Typed IPC channel contracts
```

### Security model
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- All privileged operations (desktop control, browser automation, file I/O) run only in the main process
- Renderer communicates exclusively through the typed preload bridge (`window.goga`)
- Every action is logged before execution
- High-risk actions require explicit user approval before running

---

## Getting Started

```bash
npm install
npm start
```

This runs Vite dev server + TypeScript watch + Electron concurrently.

---

## Phased Roadmap

### Phase 1 — Shell (current)
- [x] Electron + React + TypeScript scaffold
- [x] Chat interface with mock orchestrator
- [x] Activity log (audit trail)
- [x] Approvals panel (approve / reject / stop)
- [x] Memory store (key-value)
- [x] Settings page
- [x] Stub adapters for all tool categories
- [x] Disabled stubs for trading, wallet, social posting, offensive security

### Phase 2 — Desktop Control
- [ ] Screenshot capture via `@nut-tree/nut-js` or `robotjs`
- [ ] Cursor movement and keyboard input
- [ ] Active window inspection
- [ ] Screen region OCR

### Phase 3 — Browser Automation
- [ ] Playwright integration in main process
- [ ] MCP-compatible browser tool interface
- [ ] Page content extraction and summarization

### Phase 4 — Local Model Integration
- [ ] Ollama API client (default: `http://localhost:11434`)
- [ ] Streaming responses in chat
- [ ] Tool-call parsing from model output
- [ ] Context window management

### Phase 5 — Research & Workflows
- [ ] Web search adapter
- [ ] Document summarization pipeline
- [ ] Social media draft composer (review-only, no auto-post)
- [ ] Crypto workflow helpers (read-only, no signing)

### Phase 6 — Persistence & Packaging
- [ ] electron-store for settings and memory persistence
- [ ] electron-builder packaging for Windows/macOS
- [ ] Auto-update support

---

## Adapter Status

| Adapter | Status | Notes |
|---|---|---|
| Desktop | Stub | Phase 2 |
| Browser | Stub | Phase 3 |
| Research | Stub | Phase 5 |
| Trading | **Disabled** | Will not be enabled |
| Wallet signing | **Disabled** | Will not be enabled |
| Social posting | **Disabled** | Draft-only in Phase 5 |
| Offensive security | **Disabled** | Will not be enabled |
