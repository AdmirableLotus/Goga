# Proposal-only developer mode

This milestone adds a working Developer page to an isolated build based on `6a4e7f7`.
It does not include the separate uncommitted book-discussion work or browser research.
There is no developer approval, apply, install, merge, restart or activation endpoint.

## Working path and deliberate limits

Ask Goga to explain a small named top-level function in a tracked TypeScript file under
`src/`. The application reads the committed blob and displays its base commit, SHA-256,
numbered function, model explanation and exact application-resolved line quotations. It refuses dirty
selected files rather than discarding local work. This is single-function inspection,
not a claim that Goga has understood the entire application or resolved its call graph.

The first editing profile is deliberately limited to `LibraryPage.formatBytes`: return
`0 B` for negative and non-finite inputs while preserving normal B/KB/MB formatting.
Other supported small functions are explanation-only. The user describes the small change;
the configured local model supplies the replacement function. Main constructs the patch
from that actual replacement, rather than asking the model to narrate future actions.

Source, comments and the user's request are data in a user turn. Fixed system rules and
the JSON grammar are application-owned. No general agent, shell tool or remote fallback
is attached. The model can neither execute its proposal nor declare validation successful.

## Restricted pure-function testing

**Candidate validation is restricted pure-function testing, not full JavaScript or
application testing.** Neither candidate JavaScript, repository scripts, imports, builds,
npm commands nor arbitrary test code are executed. A trusted, terminable worker parses the
replacement with installed TypeScript and interprets only a small allowlist of numeric,
conditional, string-template and fixed-decimal AST operations. External/dynamic calls,
loops, property reads and unsupported syntax are rejected, including unreachable branches.
There is no VM/eval of candidate source. The worker's `eval:true` loads only a fixed trusted
evaluator string; model text is passed as worker data to its parser.

Twelve fixed cases compare the original function and candidate: normal byte/KB/MB boundaries
and decimals, existing large-number formatting, negative input, NaN and both infinities.
The full results, validation policy hash and limitation appear in the review. A pass covers
these cases and supported semantics only; it is not a proof of general correctness or a
substitute for a later application build and integration tests in a proper sandbox.

The worker has 128 MB old-generation / 16 MB young-generation limits, a 3-second deadline,
512-node / 48-level syntax limits and a 2,000-operation budget per case. Stop requests
termination and waits for worker exit before the enclosing operation settles. This avoids
running untrusted native JavaScript with the everyday app's permissions. A general candidate
test runner remains future work; the existing broad shell runner is not repurposed for it.

## Isolation and review identity

The repository root is bound in main to the running development checkout; renderer inputs
cannot select an arbitrary root or destination. Source reads are regular committed files,
limited to 100 KB; functions are limited to 100 lines / 7,000 characters. Paths, links,
credential-like source and known environment secret values are rejected before display or
model generation. These checks are conservative and cannot detect every possible secret.

Candidate preparation creates a fresh detached Git worktree under the isolated profile's
developer-proposals directory. Main materializes regular committed blobs without checkout
filters, hooks, dependencies, credentials, profiles or repository-script execution. It rejects
links/submodules/restricted paths and caps materialization at 1,000 files and 120 MB. Only the
inspected function in the supported file is replaced. The source checkout is not edited.
The complete tracked diff must contain exactly that file, with no unexpected untracked files.

Each proposal saves `proposal.patch` and `manifest.json`, recording:

- The base commit, original file SHA-256 and candidate file SHA-256.
- The complete diff and its SHA-256.
- Original/candidate test results, policy hash and validation SHA-256.
- A manifest SHA-256, timestamp, candidate directory and remaining uncertainty.

Verify proposal hashes again checks the candidate HEAD, diff, candidate file, patch file,
manifest bytes and source HEAD against the current main-process proposal. Mutation invalidates
review. This is an integrity check, not user approval or an authenticated update manifest.
The current UI review session is in memory; saved artifacts remain on disk after restart but
are not automatically promoted into trusted approval state. Later approval/activation must
add its own revision-bound, single-use grant and revalidation.

Git calls use structured arguments, bounded output/time, a reduced environment and disabled
hooks/external diff/text conversion. Candidate source is never a command. Partial preparation
can leave an isolated worktree and artifacts for inspection; it never produces an update.
There is no automatic worktree deletion, branch push, merge or everyday activation.

## Local model and Stop

One bounded JSON generation per explanation or patch request: at most 4,096 context tokens,
2,880 formatted input tokens (or the smaller available context minus 1,216), 1,152 output
tokens and a 20,000-character raw-output cap. Main checks explanation/uncertainty/patch lengths
and source-span IDs. String repetition limits are enforced after generation rather
than expanded into the native grammar; a real installed CPU-runtime regression compiles the
actual grammar without loading a model or contacting the network.

The developer request deadline is 90 seconds. Its Stop button, global Stop, emergency shortcut
and shutdown cancel the current request and invalidate old inspection sessions. A request
guard remains held until underlying work settles, so late output cannot create a proposal.
Cancellation does not apply, approve or activate any candidate.

## Validation evidence

Automated implementation tests and the one UI acceptance after grammar simplification are
reported separately in the external developer-proposals review artifacts. The app's renderer
and main builds validate this implementation; they are not candidate application validation.
Everyday Goga and the separate book-discussion work remain unchanged.

## Pinned source-span citations

The local model now selects source-span IDs from an application-owned catalog, rather
than reproducing quotations or line numbers. F1 covers the complete inspected function;
S1 and subsequent IDs identify individual nonempty lines (up to 32 catalog entries).
Only IDs and line ranges are added to the already-numbered source context; quotations
are resolved by main from the pinned inspection. The native grammar enumerates the
known IDs, and main independently rejects unknown IDs and legacy model-provided quotes.

Main re-reads the selected committed file and checks its base revision and SHA-256 after
explanation generation, before patch materialization, and again before issuing a proposal.
Review also checks the pinned source. A working edit or revision/hash change invalidates
the response rather than rebinding its citations to different source bytes.

Exact quotations and valid line references are integrity checks, not semantic entailment.
The UI says so explicitly. The single isolated span-ID retry resolved quotations correctly,
but independent review found overgeneralized decimal-formatting language and a placeholder
uncertainty statement; it was not accepted as a fully accurate explanation, and no patch
request was dispatched. See the external span-retry review for the retained response and
acceptance-harness limitations. No automatic semantic-truth validator is claimed.

## Assisted correction and tested proposal

The optional correction/follow-up field reuses the explanation route. Up to 3,000 characters
of user feedback and the prior explanation for the same pinned source are sent as data;
source-span checks, budgets and cancellation remain unchanged. The corrected explanation
is then included when the user requests a proposal. This is bounded conversation context,
not a new memory subsystem or model-weight training.

After the user corrected the raw-byte versus one-decimal distinction, the actual local model
returned an accurate corrected explanation and generated a one-line invalid-size guard in
an isolated checkout. Independent fixed tests changed from 8/12 original passes to 12/12
candidate passes, preserving all eight normal formatting outputs. The complete diff and
base/patch/candidate/validation/manifest hashes were externally verified. This demonstrates
one assisted pure-helper proposal; full candidate application testing and activation remain
out of scope. See the external correction-proposal-review for process history and evidence.
