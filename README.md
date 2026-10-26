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

### Independent local AI

Goga's local engine restores actual conversation history and passes cancellation to native generation. See [the native AI foundation and next milestone](docs/goga-native-ai.md). Developer Mode currently uses Codex CLI for code work; native self-review is a separate next milestone.

### HackerOne workflow

The existing Security page now supports encrypted HackerOne credentials and read-only program import. Imported scope is default-deny and testing requires fresh per-action approval; only scoped GET requests are supported in security mode. Reports remain local drafts. See [the integration and preview build notes](docs/hackerone-local-integration.md).

### Chat images and videos

Use **Attach** beside the chat input to select images or videos. Preview or remove attachments before sending; text is optional. Up to four files are accepted (images up to 20 MB, videos up to 100 MB), with a combined limit of twelve image frames. Images are resized to 1280 pixels and normalized to JPEG. Video analysis uses six frames spread across the clip and does not include audio or continuous motion. Supported video codecs depend on the browser/Electron build; MP4 and WebM are recommended.

Attachments use the Ollama **Vision model** configured in Settings, regardless of the text model. Run Ollama and install a vision-capable model before analyzing media. The original media is processed locally; normalized images are sent to the configured Ollama endpoint. Media previews remain in the current chat session; image payloads are not stored in conversation history. Text-only chat and voice remain available.

### Developer Mode: improve Goga’s own code

Agent tasks have no overall wall-clock deadline. Long tasks can continue past 90 seconds; Stop, individual operation timeouts, the configured step limit, and repeated-failure guards still apply.

Open **Developer** in the desktop navigation. **Use Goga source** selects this checkout; packaged installations must choose a source folder. Start with **Find weaknesses** and **Analyze code** for a read-only review. To apply a focused fix, choose **Improve reliability** or enter a task, then select **Implement and verify**.

This version runs the installed Codex CLI using its existing login (`codex login`), rather than Goga’s local conversation model. Codex usage applies to that account. Plan runs use `read-only`; implementation runs use `workspace-write`. Permission escalation is disabled. Commands or dependencies requiring additional access can fail and will be reported in the output. Goga does not forward its Telegram or voice-provider environment credentials to the coding process.

The screen shows live agent messages, commands, reported file changes, an agent report, and Git working-tree status (including pre-existing edits). It does not automatically commit, deploy, rebuild, or reload itself. Review changes and check results before rebuilding and restarting. Stop cancels the coding process tree on Windows; partial edits remain for review. Tasks and their displayed output are kept in memory for the current app session.

### Telegram connection

1. Put your BotFather token in the local, git-ignored `.env` file as `TELEGRAM_BOT_TOKEN=your_token`. Replace any token shared publicly using BotFather first.
2. Start Goga from this project directory with `npm start` (PowerShell: `npm.cmd start`).
3. Find `[Telegram] In your private bot chat send: /pair ...` in the launch terminal, and send that exact command to your bot in Telegram.
4. Send text messages or tasks. `/stop` requests cancellation. Sensitive actions still require approval in Goga's desktop window.

Only the paired private chat is accepted. Pairing persists in `telegram-owner.json` in Electron's user-data directory; close Goga and remove that file to pair a different account. Goga and the PC must remain running and online. Text messages and replies travel through Telegram's Bot API: https://core.telegram.org/bots/api. Do not run another polling client for the same bot. Tokens are never included in application error logs.

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
