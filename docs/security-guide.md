# Security guidance milestone

The Security page now provides a beginner learning path starting at Hacker101,
public program/disclosure discovery, bounded public disclosure reading, policy
review and passive tool inventory. Research captures source URLs and retrieval
dates. Search results are untrusted discovery material; import the current program
policy before testing. Dynamic or authenticated pages may not supply readable text.

For an imported workspace, refresh policy and scope, read the full policy and
per-asset instructions, and fill all seven checklist topics. Record explicit
uncertainty when a rule is absent and clarify it before using that technique.
Saving the checklist is a human review record, not automatic policy interpretation.
Testing approvals require a review against the current policy fingerprint,
refreshed within 24 hours. Refresh clears review and revokes approval before
network I/O, including on failure. Successful refresh flags changed policy or scope
and preserves findings, evidence and test notes. Every refresh requires review.

Research uses fixed public sources or numeric HackerOne report URLs, one GET at
a time, no redirects, a 15-second timeout and a 1 MB response limit. Search contacts
only DuckDuckGo and accepts HackerOne result URLs without visiting them. The target
testing boundary remains individually approved in-scope GET requests.

Inventory looks for curl, nmap, nuclei and httpx executable files on absolute PATH
entries. It never executes them: identity, version and integrity remain unverified,
and absent results do not mean a tool is absent elsewhere on disk. Installation
recipes, installation, scanner adapters, paper-specific citations and end-to-end
guided report generation are deferred. No reference paper has been selected.

Targeted fixture checks: `node scripts/test-security.mjs`.
Type checks: `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit`
and `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`.
Tests use mocked public/API responses and temporary storage; they do not test a
real bounty target or use saved application credentials.
