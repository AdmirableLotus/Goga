# HackerOne integration in the existing local Goga checkout

## Provenance and preservation

- Local starting branch: `main`; starting HEAD: `d677a5bbff98c8247a27db0bc5e89e9eae43ec5a`.
- Working branch: `feature/hackerone-local-integration`. No commits, pushes, remote PR edits or merges were made.
- Reviewed draft [PR #6](https://github.com/AdmirableLotus/Goga/pull/6), head `8e7b094082f6df35432e645c913d482a82b06237`, with PR base `6a4e7f7e5824d625f3047e1094f0aa52289b45f9`.
- The PR's ancestry also contains unrelated library, diagnostics and planner work. That history was not merged. The new HackerOne service and Security page were brought over and hardened; the four other HackerOne file changes were adapted to the local checkout. Local Telegram, developer mode, attachments, observation, cancellation and triangle changes were preserved.
- Starting staged and unstaged patches, starting untracked files, and hashes of visual files are backed up under `.git/goga-hackerone-backup`. The original Git index remains unchanged.
- All pre-existing files under `src/renderer/components/GogaCore` and `assets` remain byte-identical to the starting checkout. The reference image is `assets/icon.png`; the living triangle is implemented by `GogaTriangleScene`, `useGogaScene`, and `livingTriangle`. No standalone transparent overlay image was identified; future changes to a separate overlay would require that original asset. This integration does not change the visual design or invent a logo.

## Credentials and program import

Open Security, enter the HackerOne API username and token, and select **Save encrypted token**. The token is passed directly to Electron's `safeStorage`, saved only as encrypted bytes in `goga-hackerone-credentials.bin`, and cleared from the UI after the save attempt. There is no credential-read IPC method. Status returns only encryption availability and whether a credential file exists. Encryption failure has no plaintext fallback.

**Import program** performs only GET requests to the fixed `https://api.hackerone.com/v1/hackers/programs/{handle}` API family. It imports the policy, structured scopes and scope-exclusion categories described by the [official HackerOne Hacker API](https://api.hackerone.com/hacker-resources/). Requests reject redirects, enforce time and streamed response-size limits, and construct pagination paths locally. Network errors and API error bodies never expose credential headers.

Only assets with `eligible_for_submission === true` enter the authorized-asset list. Bounty eligibility alone does not qualify. All scope entries, eligibility flags, asset types and per-asset instructions are preserved in authoritative imported metadata, so an explicitly ineligible child target overrides an eligible wildcard. Program submission state must be `open` for testing. Empty eligible scope or missing policy prevents import. Importing does not activate a workspace or start a test.

Imported policy and scope cannot be overwritten or widened by the generic update IPC. Notes can be edited. URL, wildcard, IPv4 and CIDR targets are supported conservatively; unsupported asset types are visible in imported metadata but denied for execution. Scope checks do not contact targets.

## Action boundary and reports

Security mode permits only a single, explicitly approved, in-scope `web.fetch` GET at a time. Missing targets, outside targets, shell/process tools, browser automation, desktop input, opaque scripts and scans are blocked. Browser redirects are not followed by the permitted GET. This is deliberately more restrictive than the draft PR; arbitrary shell/browser actions cannot be constrained by a supplied target string alone.

Security authorization runs before normal read-only and risk-based auto-approval rules. After the user approves an action, the backend issues an opaque one-use grant bound to the exact workspace, tool and parameters. Dispatch consumes and rechecks the grant and scope. Reusing an approval, changing parameters, changing workspaces, or stopping revokes authorization. The same registry boundary protects alternate callers. Developer execution and direct desktop input are disabled while a security workspace is active.

Findings are saved locally with status `draft`, even if a caller supplies a submitted status. No report-submission API, scan launcher, automatic target test or deployment was added. Review the imported policy, exclusions and per-asset instructions before approving any GET; scope eligibility is not permission to disregard program rules.

Stop, Ctrl+Shift+Escape, and Telegram `/stop` cancel the agent, missions and developer workflow, revoke grants, and retain an audit entry. Cancellation proceeds even if the security audit cannot be written. Changing the active workspace first stops outstanding workflows. Import, authorization, blocked dispatch, approved dispatch and execution outcomes are audited without credential payloads.

## Separate Windows preview artifact

Build command:

```powershell
npm.cmd run build
npx.cmd electron-builder --win --x64 --publish never --config electron-builder.hackerone.cjs
```

The NSIS installer is emitted under `artifacts/hackerone-preview-20261025-final/` as `Goga-HackerOne-Preview-0.1.0-x64-Setup.exe`. It has app ID `com.goga.hackerone.preview`, executable `Goga-HackerOne-Preview.exe`, and an isolated `%APPDATA%\Goga-HackerOne-Preview` data directory. It does not create desktop/start-menu shortcuts or launch the app after installation. The original Goga icon is embedded. Publishing is disabled. No signing certificate was supplied, so this is an unsigned local preview.

The installer was built but not executed or installed. The unpacked preview was launched only for smoke testing, with Telegram disabled and a temporary working directory so the project's `.env` was not loaded. Real Electron `safeStorage` encryption/decryption and the isolated data directory were verified. No real HackerOne token was entered and no live target testing or HackerOne report submission was performed. The final artifact folder contains screenshots, validation results and a SHA-256 checksum.

## Validation

Use `validation.json` and the copied build/test logs beside the installer for the final results. Tests cover encrypted credential storage, unavailable encryption, official API GET-only import, strict eligibility, pagination, redirect rejection, streamed size limits, token-safe errors, URL/wildcard/CIDR scope checks, imported-scope immutability, fresh one-use approval, changed-target rejection, cancellation and local-draft enforcement. API and target requests in these tests use mocks, not live programs.

Two existing test typing errors were corrected (the Activity shared-types import and an unsupported role-query option). Mock security services were updated for the new cancellation boundary. The full existing test suite is also run with two workers to avoid Windows native-helper compilation contention.
