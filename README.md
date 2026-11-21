# Goga — Local-First AI Desktop Operator

Goga is a local-first AI agent that runs on your PC. It uses Electron for privileged system access, React for the UI, and TypeScript throughout. It runs a local model (Ollama) by default, keeps its state on this machine, and asks before it does anything that cannot be undone.

The idea in one sentence: you ask for the work in chat, and Goga does it and reports what actually happened.

---

## The nine destinations

There used to be twenty tabs. There are now nine destinations, and every page that used to be a tab is a section inside one of them. Old tab ids still resolve (see `src/renderer/nav.ts`), so nothing became unreachable by being folded away.

**Chat is the front door.** Work is asked for there, not clicked through pages. The other eight exist because a person has to *see* something (what is running, what is waiting on them) or *configure* something. Every capability behind a section is also a tool the chat path can call, so asking in chat and opening the page do the same work.

| Destination | Sections | What lives there |
|---|---|---|
| **Chat** | Chat | Where you ask for anything. Mission Mode is the voice conversation, opened by the Goga logo. |
| **Security** | Bounty, OSINT, Engineering | Bug bounty: program scope, one approved request at a time, the specialist review, the Lab, and public-source research. |
| **Trading** | Broker, Practice, Strategy, Markets | Two practice venues, the rule-based strategies, and the charts and backtests behind them. |
| **Work** | Business, Jobs | Your own accounts and storefronts, and the background jobs doing the long work. |
| **Machine** | Browser, Setup | The browser Goga drives, and what is installed on this computer. |
| **Memory** | Facts, Library, Self-improve, Developer | What Goga knows, what he has read, and how he works on his own code. |
| **Activity** | Activity | What is running right now, and what it has done. |
| **Approvals** | Approvals | What is waiting on you. Nothing here runs until you say so. |
| **Settings** | Settings | Models, keys, voice, browser choice and the switches that change how Goga behaves. |

The **Stop** button in the header stops everything: the agent loop, running missions, the developer task, and every offensive Lab process. It is the same code path as the emergency stop.

---

## Security

### Programs and scope

You import a program — a HackerOne program, or a Cantina bounty read from its public page — and Goga records its published scope as plain data: the assets, which of them are eligible for submission, the instructions attached to each, and the exclusions.

Checking a target against that scope is a pure function (`services/security/scope.ts`) with no network and no filesystem, so the answer is the same every time and can be tested on its own. The order it decides in is the point:

1. **Deny rules first.** An asset the program lists but marks *not* eligible for submission is kept as a deny rule, and it is decided before any allow. A wildcard elsewhere in the same program never overrides an entry that says a host is out.
2. **Coverage.** A target no eligible asset covers is refused as undetermined. Nothing is "probably fine".
3. **Exclusions, before the allow.** If the program excludes a technique, an in-scope target is still a refusal for that technique.
4. **Then allow**, naming the rule that covered it.

Local, private, and cloud-metadata addresses are refused outright whatever a program says.

### One approved request

`services/security/probe.ts` is the only code in Goga that sends a request at a bounty target, and it sends one **GET** only, and only when all of these hold: a program is imported and active, the target is covered by its eligible scope, the target is not a local or private address, and you approved that exact target and method and the approval is unused. Redirects are not followed, because a redirect can leave scope. The response is capped and returned as an excerpt plus headers. No cookies, no auth headers, no POST bodies.

### Grimoire — the specialist review

Point Goga at a file or a page description and eighteen specialist reviewers argue over it, one vulnerability class each: IDOR/BOLA, SSRF, SQL injection, XSS, authentication, RCE, XXE, SSTI, secrets, OTP, PII, logic, open redirect, recon, CORS, referrer leakage, checksum/integrity, and enumeration/timing. A specialist argues; it does not act. It has no network client, no payload list and no way to send anything. Its signals are read-only regular expressions that point a human at a line worth reading — a match is a lead, not a bug.

Each one can also **stand down** and say "this is not what I look for", because a reviewer that cannot stand down is a noise generator.

An **independent validator** checks every hypothesis and is allowed to refuse it. It looks for counter-evidence first, since the commonest failure of an automated reviewer is flagging correct code. Three outcomes: the confirming observable is present and quoted; the material contains what makes the proposal wrong; or the material does not settle it — and those are **dropped, not softened**.

The **knowledge base** cites real, publicly disclosed HackerOne report ids with their title, severity and CWE as the API reports them. It contains no payloads and no report bodies: the API returns metadata, not bodies, so every entry says so rather than inventing a mechanism.

**Per-program memory** records what was raised and dropped, and why, so the next run does not re-argue it. A confirmed candidate is kept too.

The **seven-question gate** is the checklist a finding must pass before a report is drafted. A "no" on any of the first four kills it and records it as dead:

1. Did you see it happen yourself, on your own copy?
2. Is the thing you touched inside the program's scope, by its own words?
3. Can an attacker do this right now, starting from where they really start?
4. Can you say the concrete impact in one sentence, naming what the attacker gains?
5. Do you have the evidence that proves it, in a form someone else can follow?
6. Was the whole check short — around five minutes — once you knew where to look?
7. Have you decided how you will disclose that AI helped?

### Local source review

`security.indexTarget` and `security.reviewFile` work against a folder you point Goga at — the usual case being a local WordPress Core copy. It reads only inside that folder, at most a bounded number of files, and **nothing leaves the machine**: the review module imports `fs` and nothing else that can leave it, and its test asserts that its import list contains no fetch, http, https, net, dns, child_process or tls.

### The Lab

The Lab runs offensive tools, and every one of them checks a **declared target** before it starts a process. A declaration is a host plus what authorises it — a local VM, your own server, a CTF range, a client engagement with written authorisation, or a container on this machine.

**A declaration is your own assertion. Goga cannot verify that you own a host.** It records what you said, keeps it in the audit trail, and refuses anything the declaration does not cover. A program's rules are separate from and stricter than the law, and a declaration is not permission from a program. Cloud metadata endpoints are refused even when declared, because no declaration can make them yours.

What runs there:

- **A scanner pipeline** — subfinder, httpx, nuclei, katana, ffuf and nmap, plus a built-in TCP port check that needs no external binary. Each discovered name is re-checked against your declarations before it is passed to the next step, so the pipeline cannot walk off your declared target by following its own output.
- **IDOR auto-testing** — takes two of your own accounts and checks whether one can reach the other's object.
- **Credential attack** — wordlist generation and username enumeration, then a spray. The spray has a **hard stop**: it cannot be prepared and run in one step. Preparation produces a proposal naming the exact target, username list, password list and rate; that proposal goes through the single-use gate bound to a fingerprint of all four, and only an approved, unspent proposal that still matches can spray, once.
- **Kill switch and request budget.** Every child process is registered the moment it starts; `killAll()` terminates the whole tree and is what Stop calls. Every request goes through a budget that refuses past the cap and paces to the per-minute rate — and the request is made by that file, so a tool that ignores the refusal still cannot make it.

Every run gets a budget you set, and its findings are labelled honestly: `lead` means a difference worth a human look, `observation` means a response was recorded, and only `confirmed` means the validator agreed. **Nothing in the Lab sets `confirmed` on its own.**

The **Toolbox** is sixteen transcribed cheat sheets, each with a verdict: allowed under program scope, needs explicit program permission, or never. For three families the answer is never, whatever the program says — credential attacking, wireless attacks on networks you do not own, and traffic interception on a network that is not yours. Nothing in the Toolbox executes; it is text and links.

### XSS lab

`security.xssPractice` starts a deliberately vulnerable page **bound to 127.0.0.1 only** — never `0.0.0.0` — on an OS-assigned port, so nothing off this machine can reach it. It serves two endpoints: one reflects your input with no escaping (the vulnerable case) and one HTML-escapes it (the fixed control). The same payload fires on the first and is inert on the second, which makes the practice falsifiable.

**Reflected is not executed**, and Goga does not blur the two. Confirmation works by pointing the real browser at the payload URL and checking that the page title became a value only running script could set — with a control URL that must *not* carry that title, so a pre-existing title is never mistaken for execution. The same proof runs against a live in-scope target through `security.xssAttempt`, which is handed only a scoped GET and an in-scope driver and decides nothing about authorization itself.

---

## Trading

Two practice venues, and neither is real money.

- **Pivex** is a simulation-only evaluation platform. Its on-screen balance is not money and cannot be withdrawn, and no regulator supervises it. The only money at stake is the challenge fee. It has no API, so Goga drives it through the browser tab you are signed in to, using the same primitives any other site would use.
- **Alpaca paper** is a real broker's simulated account with real market data, reached through its API. The host is hard-coded to paper: there is no setting that could point it at a live account.

Both go through the same objects:

- A **risk guard** with a loss budget — a daily figure, an overall figure, a per-trade cap, a maximum order notional and a position limit. Pivex's own rules are 4% daily and 6% overall; Alpaca paper has no such rule, so Goga applies a figure you set and the same overall cap, so both venues are measured the same way. A venue can be halted, and a halted venue sends nothing.
- A **single-use approval ticket bound to one exact order** — venue, symbol, side, size and price. A confirm modal is never clicked without that approval, and a ticket works once and expires.
- **Backtests** that price a trade the way the venue charges it: fee mode is per-share (the default, so existing stock backtests are numerically unchanged) or percent of notional for crypto, and bid/ask spread is modelled separately and reported as its own total. A crypto symbol left on per-share gets a plain-language warning, never a silent correction.
- A **strategy journal** — one append-only file where every signal, prepared intent, decision, refusal, send and closed trade is recorded with the strategy name and the reason, so "is this actually working?" can be answered from a record rather than from memory.

A trade plan is laid out before anything is placed: entry, stop, targets at 1R/2R/3R, suggested size, dollars at risk and reward-to-risk, so you approve a concrete plan instead of a bare order.

---

## Browser

Goga drives a real browser he does not own the code of, through one guarded approval layer.

- **Firefox over WebDriver BiDi** is the default engine. That is a real W3C protocol Firefox serves on its remote-debugging port, and it is the browser used for security testing.
- **Brave** (Chromium-family) is a selectable alternative, driven through Playwright. Settings holds the choice, and `services/browser/engine.ts` resolves whether the chosen browser is actually installed and says what to do if it is not — rather than failing at the first click. A browser preference is never read as test authorization.
- **Site learning.** Pointed at a page it has not seen, Goga reads it, works out which elements are fields and which are actions, and saves a reusable description as plain JSON you can open and correct. The learner labels its guesses as guesses, and a correction you make is kept rather than silently overwritten.

The layer drops a dead attachment instead of pretending to be connected: `isAttached` means *live*, and a session that has died is re-established rather than reported as working.

---

## Machine

The **Setup** area answers "what is already on this computer and what would it take to add something", from the machine itself:

- **Inventory** from four sources that disagree, with each row saying which one it came from: `winget list` (with the ids an install would use), the registry uninstall keys (including programs winget has never heard of), PATH (what can be run by name right now), and Program Files (what is on disk). Every command is a read.
- **Install proposals** from winget, prepared as a description before anything is downloaded, carried out only after you approve **that exact install** — the approval is bound to package id, source and version, so changing any of them refuses. A Toolbox "never" tool is refused outright, with no approval offered.
- **VM proposals** from a measured virtualisation report. The approval is bound to provider, name, image and resources. Goga will not enable a Windows feature to make a proposal workable; if nothing is usable he says so and stops. A VM is isolation, not authorisation.

---

## Work

The **Business** desk prepares outbound work and puts it in an approval queue: mail, social posts, storefront listings, tester invitations, app-store submissions and builds, plus a digest of accounts and tracked apps. Every outbound action is written to the audit trail **before** it is attempted, and it cannot execute until you approve that exact action by id; the approval is single-use, expires, and does not survive a restart. In chat the tools available are the `prepare*` ones; sending happens through the approval, one action at a time.

**Jobs** are the long work: one large request handed to its own worker, with its own step record and report. A job survives the window closing, can stop to ask you something without holding a worker slot, and ends with a report that separates what you get from what happened operationally. Two workers run at once by default, with a step and minute bound each.

**Self-improvement** teaches Goga to work on his own code without letting him rewrite the things that check him. The loop reads his source read-only and names concrete weaknesses, proposes one specific change, applies it to a **private copy** — never the running tree — and verifies it there; then it stops and waits. Nothing reaches the real tree until you approve, and if the install fails its checks it restores the snapshot and says it did. Files under the approval gate, the safety floor and the user-data folder are never writable, approved or not. A repair round allows **two** applied corrections and then stops, names the failing check and its exit code, and refuses further attempts until you reset it. It never commits, pushes, deploys or reloads itself.

The **wake word** ("hey goga") is **off by default**. When it is on, the listener never transcribes the room: it runs a tiny local grammar that only reports when one of a few short phrases is heard, so nothing is written down and nothing leaves the machine. Full dictation starts only after the phrase fires. The Settings toggle will not say "listening" unless a microphone probe actually succeeded.

---

## Memory, Activity, Approvals, Settings

- **Memory** — facts and semantic recall, the library of what Goga has read, the self-improve history, and Developer Mode for code work driven by an external coding agent.
- **Activity** — the audit trail: every action logged before it runs, and what is running now.
- **Approvals** — the queue of things waiting on you, each bound to the exact thing it will do.
- **Settings** — models, keys, voice, the browser choice, and the switches that change how Goga behaves.

---

## How to run it

```bash
npm install
npm run dev      # watch-mode: renderer, main, and Electron together
npm start        # build both, then launch Electron
npm run build    # renderer bundle plus tsc -p tsconfig.main.json
npm run pack     # build and package a Windows installer
```

There is **no `test` or `typecheck` script** in `package.json`. The two checks are run directly:

```bash
npx tsc --noEmit          # typecheck the renderer and shared code
npx vitest run            # the full test suite
```

`npm run dev` needs the Vite dev server on port 5173. Telegram is optional and configured with a BotFather token in a git-ignored `.env` as `TELEGRAM_BOT_TOKEN`; the paired private chat is the only one accepted, and sensitive actions still require approval in the desktop window.

---

## Architecture

```
src/
├── main/               # Electron main process (Node.js, privileged)
│   ├── index.ts        # App entry, window creation
│   ├── handlers/       # IPC handlers, one per area
│   ├── services/       # Orchestrator, agent loop, and one folder per area:
│   │                   #   security/ (scope, probe, grimoire, xss), lab/,
│   │                   #   trading/, venues/, broker/, strategy/, business/,
│   │                   #   jobs/, setup/, browser/, evolution/, selfwork/, approval/
│   ├── tools/          # Tool registry and every registered tool
│   ├── adapters/       # Desktop, browser and research adapters
│   └── utils/          # Shared utilities
├── preload/
│   └── index.ts        # contextBridge API exposed to renderer
├── renderer/           # React UI (no Node access)
│   ├── nav.ts          # The nine destinations and their sections (plain data)
│   ├── pages/          # One page per section
│   └── components/     # StopButton, ApprovalCard, MissionMode, shared UI
└── shared/             # Types and IPC contracts both sides import
```

### Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- All privileged work — desktop control, browser automation, file I/O, every network send — runs **only in the main process**
- The renderer reaches it exclusively through the typed preload bridge (`window.goga`)
- Every action is logged to the audit trail before it runs
- **One single-use approval pattern** for every irreversible thing (an order, an install, a VM, a spray, a patch): an item can be claimed exactly once, only after you approved *that* item, only before it expires, and only while its fingerprint still matches what you approved. Change any part and it refuses.
- The scope checker decides every bounty target, deny-rule-first, and refuses anything it cannot prove
- An emergency stop kills the agent loop, missions, the developer task and every Lab process

### What this does not do

- **Goga does not submit bug reports.** Reports are local drafts. You verify the finding, you write the disclosure, and you decide about the program's rules — including disclosing that AI helped, which several programs require in writing.
- **A declared Lab target is your own assertion.** Goga records it and holds you to it; he cannot check that you own the host.
- **A finding is not a bug until you reproduce it.** The validator can say the observable is present, and it can refuse; it draws no conclusion about exploitability for you.
- **Scanners need the program's permission, not just scope.** Many programs prohibit automated scanning, and an imported scope alone does not authorise it.
- **Neither trading venue is real money**, and nothing here predicts a market.

---

## Adapter Status

| Adapter | Status | Notes |
|---|---|---|
| Desktop | **Working** | Screenshot, cursor, click/drag/scroll, typing, keys and shortcuts, active window, window list, UIAutomation element tree, clipboard, waits, and screen-region OCR (`computer.readScreenText`, Windows OCR — no vision model) |
| Browser | **Working** | Firefox over WebDriver BiDi (default) or Brave via Playwright, with a site-learning layer that saves a reusable description |
| Research | **Working** | `research.search` (DuckDuckGo via `web.search`), `research.summarize`, `research.brief` (search → read top pages → cited answer) |
| Files | **Working** | Read, write, list, search, move, delete, mkdir, with risk levels |
| Memory | **Working** | `electron-store` for settings, facts and history; conversation notes; semantic recall through `nomic-embed-text` |
| Security | **Working** | Program import and scope checking, single-scoped-GET probe, Grimoire review, local source review, the Lab, and the XSS lab |
| Trading | **Practice only** | Pivex and Alpaca paper, behind the risk guard and a single-use order ticket. No live-money venue is configured, and Alpaca is hard-coded to paper |
| Wallet signing | **Disabled** | Will not be enabled |
| Social posting | **Draft and approval only** | Bluesky and Mastodon through their documented APIs, one approved post at a time |

### Tool surface

Tools are registered in `src/main/tools/` and dispatched through `ToolRegistry`. Every call is authorised by `services/authorization.ts` before it runs: read-only observation tools are auto-approved, `filesystem.delete`, `process.kill` and `shell.execute` always require approval, and anything at or above the configured risk threshold pauses for the approval card.

- `security.*` — scope, target check, the single approved GET, specialists, review, knowledge, memory, the gate, program import, the Toolbox, and the XSS practice and attempt
- `lab.*` — declare/revoke/list targets, scan, port scan, IDOR, enumeration, wordlist, prepare/decide/run spray, runs, stop
- `venue.*` / `broker.*` / `strategy.*` / `trading.*` — quotes, plans, practice orders, backtests, the journal, halts
- `browser.*` — the BiDi layer: goto, read, find, click, type, tabs, screenshot, learn/recall/correct a site
- `setup.*` — catalogue, install proposals and their approvals, virtualisation report, VM proposals
- `business.*` / `jobs.*` — prepare mail, posts and listings; digests; testers; background jobs
- `evolution.*` / `selfwork.*` — the self-improvement loop and Goga's work on his own source
- `computer.*` — screen and input control, including `computer.readScreenText` for exact text
- `web.search` / `web.fetch`, `research.*`, `filesystem.*`, `process.*`, `shell.execute`, `memory.*`, `vision.*`, `clock.now`, `schedule.*`, `library.*`, `electronics.*`, `microcontroller.*`, `ee.*`

### Screen-region OCR

`computer.readScreenText` takes `x`, `y`, `width`, `height` in the same logical pixels `computer.click` uses, captures that rectangle at the display's real DPI, and runs Windows' own OCR engine over it. It returns the recognised text, its lines, the region read and the display scale. Omit the region to read the whole primary display. It needs no vision model, no network and no extra dependency, and it is auto-approved as a read-only observation. Use it when exact wording, numbers or an error message matter; use `vision.analyze` when you need a description of what is on screen.
