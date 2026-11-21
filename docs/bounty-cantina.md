# Autonomous bounty runs, and using one with Cantina

## What this is

Goga can start a *watched, hands-off* bounty run against a program you have imported and
activated: it declares only the hosts the scope checker proves are in scope, then recons,
installs tools it needs, and tests — streaming every step to the Jobs board, where you watch
and can cancel. The run engine is source-agnostic. This document covers running it against the
**Cantina Bug Bounty Program** (`https://bounties.cantina.xyz/cantina/bug-bounty`), reusing the
existing Cantina scope importer and the existing job engine; it does not add a parallel system.

## Provenance and preservation

- Working branch: `feature/bounty-autonomous-run`. The autonomous-run handoff is commit
  `6edacff`; the Cantina-specific additions sit on top of it. No branch switch, merge,
  cherry-pick, commit of unrelated work, or push was performed for this change.
- The Cantina scope importer (`src/main/services/security/cantina.ts`), the Grimoire import UI,
  the Lab tools, the scope checker, the job engine and the authorization gate already existed
  and were **reused unchanged**. The additions are: a read-only scope *preview*, a launch-time
  acknowledgement gate for programs that restrict automation, and the UI that shows the
  effective scope before a run.

## Setting up the Cantina program

1. **Import the scope.** On the Security page, Grimoire section → *Cantina: import a bounty's
   scope* → paste `https://bounties.cantina.xyz/cantina/bug-bounty` → **Import Cantina scope**.
   This performs GET-only reads of the public page from a fixed Cantina host set, follows no
   redirects, caps the response, and sends nothing to the program's own assets. It does **not**
   join the program, pay a deposit, complete KYC, or grant permission to test anything. Only
   real in-scope URLs from the program's own hosts become assets; the out-of-scope list and the
   program's stated automated-testing rule are parsed and stored beside the scope.
2. **Activate it.** In the program list, select the imported Cantina program as the active
   program.

If the page cannot be fetched or parsed, nothing is imported (rather than importing an empty
scope that would refuse every target). In that case, import is the only supported way to get a
verified Cantina scope — scope is not hand-entered or inferred from the brand or homepage.

## How scope is verified, and reviewed before a run

- **Review scope for a run** (Security page, *Run the active program, hands-off*) calls the
  server, which computes the effective scope with the same pure `decideScope` the launch and
  every tool action use. It shows: the exact in-scope hosts the run will declare, the
  out-of-scope deny rules, the prohibited techniques, which local scanner tools are installed,
  and — for Cantina — the program's automated-testing rule.
- A host is offered **only** when `decideScope` confirms it is in scope. Wildcards reduce to
  their apex and are re-verified; CIDRs, odd wildcards and path-bearing assets whose apex is not
  itself covered are left out. The code under-declares on any doubt; it never widens scope.
- **Revalidation.** Scope is recomputed on the server at launch (the same `inScopeHosts`), and
  every active tool re-checks scope at the moment it runs: `security.probe` re-checks the
  program scope and the forbidden-host rule; the Lab scanners refuse any host not covered by a
  live declaration, and only in-scope hosts are declared. Out-of-scope, ambiguous, and
  local/private/metadata targets are refused automatically. Discovered hosts are **not** added
  to scope during a run; declaring any *new* target always stops to ask, even hands-off.

## The automated-testing rule (Cantina)

Cantina's program asks testers to be extremely cautious with automated, multi-request scans.
Because of this:

- The preview shows the rule, and **launch is refused on the server** until you tick the
  acknowledgement — this is enforced in the `security:startBounty` handler, not only in the UI.
- The run's goal carries the rule and instructs low-and-slow testing: prefer single targeted
  requests (`security.probe`) over high-volume scanners, and skip checks that would mean heavy
  automated traffic. Per-run request caps and the repeat guard still apply as deterministic
  bounds, but pacing within those bounds currently relies on the run honoring the goal — see
  Limitations.

## What actually executes — and what does not

- `security.probe` (one in-scope GET) and the built-in TCP port check run **in-process** and
  need no external tool.
- The external scanners (subfinder, httpx, katana, nuclei, ffuf, nmap) run **only where the
  binary is installed on this machine**. There is **no remote VM / tool-runner** in this
  checkout. A missing tool is reported as *skipped*, never as a completed or faked result, and
  the preview shows which tools are present. A run that could not execute its active steps shows
  as failed or partial on the Jobs board — it is never reported as a successful external test.

## Limitations

- **No VM/tool-runner.** Live external scanning is limited to tools installed locally; the
  broader VM execution path is not connected here. Do not read a run as proof that full external
  testing works.
- **Automation pacing** for a restricted program (Cantina) is instructed in the goal and bounded
  by per-run caps, but not yet hard-limited per-program at the tool layer. Keep Cantina runs
  probe-focused, and treat the acknowledgement as a real commitment.
- Scope parsing reads the public page; **the program's current, authoritative rules on Cantina
  always govern.** Re-import if the program changes, and follow Cantina's own scope, exclusions,
  disclosure and rate rules at the time you test.

## Tests

Local, mocked, no network: `src/main/services/__tests__/security-bounty.test.ts` (scope
extraction, preview, automation-rule gate, goal content) and `authorization-bounty.test.ts`
(the hands-off authorization allowlist). The Cantina importer has its own mocked-fetch tests in
`src/main/services/security/__tests__/grimoire.test.ts`.
