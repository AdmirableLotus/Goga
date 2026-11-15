# Goga — Local-First AI Desktop Operator

Goga is a local-first AI agent that runs on your PC. It uses Electron for privileged system access, React for the UI, and TypeScript throughout.

---

## Architecture

```
src/
├── main/               # Electron main process (Node.js, privileged)
│   ├── index.ts        # App entry, window creation
│   ├── handlers/       # IPC handlers (chat, actions, memory, logs, settings, developer)
│   ├── services/       # Orchestrator, agent loop, ActionStore, Memory, Logs, Settings
│   ├── tools/          # Tool registry and every registered tool
│   ├── adapters/       # Desktop, browser and research adapters
│   └── utils/          # Shared utilities
├── preload/
│   └── index.ts        # contextBridge API exposed to renderer
├── renderer/           # React UI (no Node access)
│   ├── pages/          # Chat, Library, Memory, Settings, Developer, Markets, Security
│   ├── components/     # StopButton, ApprovalCard, shared UI
│   └── styles.css      # Global dark theme
└── shared/
    ├── types.ts         # Action, ChatMessage, LogEntry, MemoryEntry, AppSettings
    ├── developer.ts     # Developer Mode state and run-diff contracts
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

### Historical Markets

Open **Markets** to import daily CSV prices, manage a watchlist, and run deterministic historical portfolio simulations with separate development and evaluation periods. Chat command `/markets` reports verified local calculations and data timestamps. See [format, calculation assumptions and sample data](docs/markets.md). Live trading remains disabled.

### HackerOne workflow

The existing Security page now supports encrypted HackerOne credentials and read-only program import. Imported scope is default-deny and testing requires fresh per-action approval; only scoped GET requests are supported in security mode. Reports remain local drafts. See [the integration and preview build notes](docs/hackerone-local-integration.md).

### Chat images and videos

Use **Attach** beside the chat input to select images or videos. Preview or remove attachments before sending; text is optional. Up to four files are accepted (images up to 20 MB, videos up to 100 MB), with a combined limit of twelve image frames. Images are resized to 1280 pixels and normalized to JPEG. Video analysis uses six frames spread across the clip and does not include audio or continuous motion. Supported video codecs depend on the browser/Electron build; MP4 and WebM are recommended.

Attachments use the Ollama **Vision model** configured in Settings, regardless of the text model. Run Ollama and install a vision-capable model before analyzing media. The original media is processed locally; normalized images are sent to the configured Ollama endpoint. Media previews remain in the current chat session; image payloads are not stored in conversation history. Text-only chat and voice remain available.

### Developer Mode: improve Goga’s own code

Agent tasks have no overall wall-clock deadline. Long tasks can continue past 90 seconds; Stop, individual operation timeouts, the configured step limit, and repeated-failure guards still apply.

Open **Developer** in the desktop navigation. **Use Goga source** selects this checkout; packaged installations must choose a source folder. Start with **Find weaknesses** and **Analyze code** for a read-only review. To apply a focused fix, choose **Improve reliability** or enter a task, then select **Implement and verify**.

This version runs the installed Codex CLI using its existing login (`codex login`), rather than Goga’s local conversation model. Codex usage applies to that account. Plan runs use `read-only`; implementation runs use `workspace-write`. Permission escalation is disabled. Commands or dependencies requiring additional access can fail and will be reported in the output. Goga does not forward its Telegram or voice-provider environment credentials to the coding process.

The screen shows live agent messages, commands, reported file changes, an agent report, and two change views:

- **Changes in this run** — a diff of what this run changed. Before the coding agent starts, Goga snapshots the working tree with `git stash create`, which writes a commit object without touching the index, the working tree or the stash list. When the run ends it diffs against that snapshot and reports a `--stat` summary, any new or deleted files, and the full patch behind a disclosure. Edits that existed before the run are not counted.
- **Working tree** — everything uncommitted, including pre-existing edits.

Goga does not automatically commit, deploy, rebuild, or reload itself. Review changes and check results before rebuilding and restarting. Stop cancels the coding process tree on Windows; partial edits remain for review. Tasks and their displayed output are kept in memory for the current app session.

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

`npm start` builds the renderer and the main process, then launches Electron. For a watch-mode development loop use `npm run dev`.

---

## Phased Roadmap

### Phase 1 — Shell
- [x] Electron + React + TypeScript scaffold
- [x] Chat interface with the real orchestrator
- [x] Activity log (audit trail)
- [x] Approvals panel (approve / reject / stop)
- [x] Memory store (key-value)
- [x] Settings page
- [x] Disabled stubs for trading, wallet, social posting, offensive security

### Phase 2 — Desktop Control
- [x] Screenshot capture (`screenshot-desktop`)
- [x] Cursor movement and keyboard input (`@nut-tree-fork/nut-js`)
- [x] Active window inspection, window list, UIAutomation element tree
- [x] Screen region OCR (`computer.readScreenText`, Windows.Media.Ocr)

### Phase 3 — Browser Automation
- [x] Playwright integration in the main process
- [x] Semantic locators: ARIA snapshot, role/label/text
- [x] Page content extraction (`browser.getContent`, `web.fetch` readable text)
- [ ] MCP-compatible browser tool interface

### Phase 4 — Local Model Integration
- [x] Ollama API client (default: `http://localhost:11434`)
- [x] Streaming responses in chat
- [x] Native tool calls plus a JSON-mode fallback
- [x] Context window management (per-step result budgets, prompt trimming)

### Phase 5 — Research & Workflows
- [x] Web search adapter (`web.search`, `research.search`)
- [x] Document summarization pipeline (`research.summarize`, `research.brief`)
- [ ] Social media draft composer (review-only, no auto-post)
- [ ] Crypto workflow helpers (read-only, no signing)

### Phase 6 — Persistence & Packaging
- [x] electron-store for settings and memory persistence
- [x] electron-builder packaging for Windows
- [ ] Auto-update support

---

## Adapter Status

| Adapter | Status | Notes |
|---|---|---|
| Desktop | **Working** | Screenshot, cursor, click/drag/scroll, typing, keys and shortcuts, active window, window list, UIAutomation element tree, clipboard, waits, and screen-region OCR (`computer.readScreenText`, Windows OCR — no vision model) |
| Browser | **Working** | Playwright in the main process: open, navigate, click, type, read, screenshot, ARIA snapshot, role/label/text locators. Uses Brave when installed (resolved per platform; `GOGA_BRAVE_PATH` overrides) and Playwright's own Chromium otherwise |
| Research | **Working** | `research.search` (DuckDuckGo via `web.search`), `research.summarize` (fetch a page, chunk it, summarise with the local model, merge), `research.brief` (search → read top pages → cited answer) |
| Files | **Working** | Read, write, list, search, move, delete, mkdir, with risk levels |
| Memory | **Working** | `electron-store` for settings, facts and history; conversation notes; semantic recall through `nomic-embed-text` |
| Trading | **Disabled** | Will not be enabled |
| Wallet signing | **Disabled** | Will not be enabled |
| Social posting | **Disabled** | Draft-only |
| Offensive security | **Disabled** | Will not be enabled |

### Tool surface

Tools are registered in `src/main/tools/` and dispatched through `ToolRegistry`. Every call is authorised by `services/authorization.ts` before it runs: read-only observation tools are auto-approved, `filesystem.delete`, `process.kill` and `shell.execute` always require approval, and anything at or above the configured risk threshold pauses for the approval card.

- `computer.*` — screen and input control, including `computer.readScreenText` for exact text
- `browser.*` — Playwright sessions, plus `browser.openExternal` for the user's own browser
- `web.search` / `web.fetch` — DuckDuckGo search and readable-text page fetch
- `research.search` / `research.summarize` / `research.brief` — the research pipeline above
- `filesystem.*`, `process.*`, `shell.execute`, `memory.*`, `vision.*`, `clock.now`
- `self.*`, `schedule.*`, `library.*`, `trading.*` (read-only), `electronics.*`, `microcontroller.*`

### Screen-region OCR

`computer.readScreenText` takes `x`, `y`, `width`, `height` in the same logical pixels `computer.click` uses, captures that rectangle at the display's real DPI, and runs Windows' own OCR engine over it. It returns the recognised text, its lines, the region read and the display scale. Omit the region to read the whole primary display. It needs no vision model, no network and no extra dependency, and it is auto-approved as a read-only observation. Use it when exact wording, numbers or an error message matter; use `vision.analyze` when you need a description of what is on screen.
