# Local knowledge and approval-controlled developer mode

## Existing capabilities and gaps

This work is isolated on feature/local-knowledge-library, based on d677a5b, without
uncommitted browser research. LibraryService, Add Book, native file selection, library IPC,
and LibraryPage already supported PDF/TXT/EPUB and keyword search. The index was memory-only,
page/chapter boundaries were lost, and general chat inserted passages into its system prompt.
Installed pdf-parse v2 provides per-page text; epub2 supplies reading-order chapters. Reuse
those extractors and the app userData directory; no new packages or remote service.

Generic filesystem and PowerShell tools can edit files and invoke Git, but there is no
repository worktree manager or revision-bound application update protocol. Existing
ActionStore/action handlers guard pending status, stale approval after Stop and duplicate
execution. AuthorizationService retains critical and always-approval gates. Those protections
remain unchanged; an action ID alone does not bind approval to a reviewed revision.

## Implemented bounded library milestone

Add a local book, choose **Ask about this book**, and enter specific terms. At most three
BM25-ranked passages form an explicitly extractive answer, with filenames and source
locations. This is grounded passage retrieval, not model-generated synthesis or semantic
search. Book Q&A abstains unless all meaningful query terms occur in the retrieved passages;
generic overlap alone is insufficient. This conservative lexical check can miss synonyms and
is not semantic entailment. No match reports a retrieval limitation, not proof of absence. There is no model,
network, tool dispatch, or instruction execution in this read-only Q&A path. React renders
untrusted passages as plain text. General chat no longer promotes book contents or metadata
to its system prompt or conversation memory. Book Q&A is explicitly scoped to the Library
panel, so retrieved text never becomes an assistant instruction in later agent turns.

PDF citations are 1-based physical PDF pages, which can differ from printed page labels.
TXT uses line ranges and EPUB uses reading-order chapters, with no invented pages.
The versioned JSON index contains metadata, source SHA-256 and chunks. It is stored locally
at userData/library-index.json: temporary file, flush, atomic rename; memory changes only
after persistence succeeds. Reinitialization reloads it. Exact contents deduplicate; same
filenames with different contents coexist. Removal deletes indexed contents, not originals.
Failed extraction/storage preserves existing books. Damaged/unknown-version indexes are
reported and preserved; no import/delete can overwrite them silently. The index is local
plaintext book text; neither original books nor acceptance indexes are committed.

Bounds: 25 MB input, 2 million extracted characters, 10 books, 32 MB index, 800-character
chunks with 100-character overlap, 1,000-character questions, five search results maximum
(three in Q&A), 30-second PDF/EPUB extraction deadline. PDF workers are destroyed in finally.
No OCR, DRM removal, or password bypass. Unknown formats, unsupported text encodings,
image-only/empty extraction, invalid files, unsupported EPUB layouts and extraction failures
produce explicit errors and never commit partial results. EPUB support is limited by epub2.

Next library milestones: optional local-model synthesis with bounded untrusted evidence,
validated citation IDs and abstention; corpus selection and migrations; import cancellation
and progress; explicit backups/recovery; OCR or semantic retrieval only when justified and
separately scoped. A generated answer must never authorize tools or application updates.

## Developer mode design only

### Isolate and validate

A future main-process DeveloperUpdateService owns an explicit request and creates a fresh
Git worktree at an identified base commit. Never edit the running checkout/userData. A narrow
repository adapter reuses Git/filesystem capabilities with structured arguments and explicit
cwd, resolved path containment and symlink/traversal checks. It does not pass model-built
shell strings to the existing broad shell executor. Exclude credentials/profiles/models.

A worktree is source isolation, not an OS sandbox. Untrusted candidate validation must run
in a restricted worker/container without production credentials or userData, no network by
default, with allowlisted commands and wall-time/output/resource limits. Do not automatically
install dependencies, fetch, merge or execute a repository script merely because a book or
model recommends it. Stop terminates owned subprocess trees. Record each command, environment
fingerprint, exit code, duration, bounded output hash and candidate hash. Failed or timed-out
validation prevents review-ready status. Approval for risky validation is distinct from apply.

### Freeze and review exact bytes

Before asking approval, show the full diff (including binary/untracked changes), base commit,
candidate tree/artifact hash, changed-file hashes, validation results and rollback target.
Freeze the candidate or copy to immutable staging; validation and displayed diff must refer
to those same bytes. Persist a main-process review manifest containing request ID, canonical
target, base revision, candidate revision/SHA-256, full diff SHA-256, validation-manifest hash,
rollback revision, expiry and authenticated user/session.

### Bind a single-use approval to the revision

Reuse approval UI/pending/reject/Stop handling, but add a dedicated always-approval update
action. Main process rechecks manifest, target/base state, candidate bytes, validation and
approval state immediately before applying. A boolean from a model, book, tool parameter or
renderer cannot approve an update. Only the user approval event consumes a single-use grant.

Any candidate edit, changed target/base, changed validation, expiry, Stop or concurrent apply
invalidates approval and requires a new diff review. Lock transitions, reject replay/double
click, persist state atomically and preserve existing critical/stale/workspace protections.
Existing action IDs lack this revision binding; implement/test it before enabling apply.

### Stage inactive, activate separately, retain rollback

An approved apply stages a verified immutable candidate in an inactive version slot. Preserve
and verify the current last-known-good version and activation pointer in a rollback slot first.
If rollback cannot be retained, fail closed. Keep code and profile separate; no automatic
live-profile migrations or credential/model copies. Recheck hashes after staging.

Activation is a separate explicit user-controlled step tied to that artifact, with activation
and rollback targets shown. Only at a safe app boundary may an atomic pointer change occur;
never replace loaded modules. Editing, validation, review and staging leave the running app
unchanged. No automatic merge, installation or restart. On failed health checks offer the
verified rollback version, without inventing another repair or applying an unreviewed diff.

Before enabling this: test candidate mutation after review, stale base, binary/untracked
changes, expired/replayed/rejected approvals, Stop/approval races, concurrent apply, validation
timeout/failure, path escapes, missing rollback, interrupted staging/activation, artifact
integrity and unchanged running code/profile until separately approved activation.

No developer apply/activation code, autonomous merge, installation or restart is implemented here.

## Acceptance on the supplied book (October 20, 2026)

The user supplied OWASP_WSTG_v4.2.pdf (10,175,044 bytes). Real PDF extraction produced
1,582 indexed passages in a 1,206,485-byte local JSON snapshot. A fresh Node process
reloaded that snapshot and returned source-referenced answers for session-identifier
randomness and threat modeling. Six references (physical PDF pages 187, 188, 352, 19, 20,
21) were checked against a fresh direct read of those pages from the original PDF; every
returned quote matched its cited page. This uses the installed PDF parser independently
of the persisted retrieval state, not a second PDF extraction engine. Source and index
SHA-256 were unchanged by the read-only checks. No model or network calls were involved.

164 tests across seven files passed: durable library/extraction/failure cases, UI and
untrusted-text rendering, approval dispatch, observation orchestration, browser routing,
agent resilience and timeout behavior. Both builds and git diff --check passed. Existing
Vite deprecation and chunk-size warnings remain. This is code/core-service and renderer
component acceptance; the new Library panel has not been exercised in a running Electron
window. The running app, everyday profile and browser research were not activated/changed.

The acceptance book and index remain outside this checkout. No developer-mode apply,
activation, installation, restart, merge or approval-policy change took place.

## Precommit isolated-app acceptance (October 20, 2026)

All three requested checks passed in the built Electron app with its separate acceptance
profile and the previously persisted OWASP index. Native Computer Use inspected the visible
Library and persisted book. When that helper disconnected and failed recovery, renderer
browser automation completed the checks through the same normal navigation/buttons/input.
No test called library.answer directly to obtain the displayed answers.

1. Persistence: close and relaunch the isolated Electron app using the same profile (distinct
   main-process PIDs 12972 and 2760). Ask "What does the book say about threat modeling?"
   through Open conversation history > Library > Ask about this book > Find passages in both
   launches. Both answers were identical. Instrumented imports were zero in both processes;
   the book ID, 1,582 chunks, and index SHA-256 were unchanged.
2. Honesty: ask "What is the recommended sourdough hydration ratio?" The displayed response
   explicitly said "I do not have supporting evidence" and supplied no citation or invented
   hydration ratio. A regression test covers this case when generic query terms still match.
3. Usability/source integrity: the normal Library UI displayed source filename and physical
   PDF pages 19, 20 and 25. Every displayed quote was compared against a fresh direct read
   of that physical page from the original PDF, outside the persisted retrieval state.
   All three matched. Screenshots of supported and unsupported UI answers were inspected
   and retained outside the repository with the lifecycle/citation verification records.

The original source PDF and index hashes were unchanged. Primary source HEAD/status/diff,
everyday HEAD/status/build/settings, and browser-research HEAD/status/diff all matched their
pre-run snapshots. The isolated test apps were closed. No everyday app activation/restart,
installation, merge or push occurred. Approval, action-store, agent-loop and action-handler
protection files are unchanged. The existing browser-research milestone remains unfinished;
these library checks do not complete it. Developer mode remains a design, not executable apply.

Final precommit regression run: 165 tests across seven files passed, including the new generic-overlap abstention case. Renderer/main builds passed with existing Vite warnings.

## Review fix: cross-instance index writes

Each write acquires an exclusive create-only `library-index.json.lock`, then reads and
compares the on-disk snapshot to the caller's loaded revision while still holding that lock.
The lock stays held through atomic rename. A stale instance receives an explicit reload/
restart error instead of overwriting another instance's imports or resurrecting a deletion.
Lock contention fails closed. A lock left by a crashed writer is not automatically stolen;
recovery requires stopping all writers and inspecting/removing the orphaned lock.

Regression coverage: competing imports, deletion followed by a stale import, lock ownership
through revision read/rename, and contention with a separate process. The 19 library tests
and both builds passed for this fix. No live book-answer demonstration was repeated.
