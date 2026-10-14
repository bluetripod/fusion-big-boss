# User-requested Fusion reviewer

## Current revision: natural-language requests

The user superseded the slash-command design below: ask the lead normally, for example **“Do a code review with the Fusion reviewer.”** The lead prepares the existing source-backed packet and invokes the configured reviewer through native delegation. No `/fusion-review` command, transient authorization grant, one-use token, or user-supplied session ID is required.

“Invoke only when the user explicitly asks for Fusion reviewer code review; never automatically after coding” is an instruction policy, not a runtime intent detector. The lead selects a retained same-change review conversation when appropriate; unrelated changes start fresh. Missing-evidence follow-ups stay within the requested review; a separate review or re-review needs another user request. Model selection/availability, ownership, read-only tools, installed-skill isolation, frozen evidence, and concurrency/lifecycle checks remain intact. Copilot's Off-mode group-message restriction is removed because it existed only to enforce the retired command gate.

1. Update canonical and adapter role guidance; verify generated Copilot copies and keep source-packet requirements unchanged.
2. Remove command-only admission machinery in each adapter; prove direct lead → reviewer start/resume works and preserved ownership/model/read-only/concurrency contracts still hold.
3. Remove only tests made obsolete by the intentional gate removal; retain valuable regressions. Run the full check and offline package validation, then independently review this smaller delta.

Baseline: last verified source passed 228 tests and both typechecks. Exact pre-revision source copy: `/tmp/opencode/fusion-natural-review-before-a2n9y475`. No installed settings, model choices, commits, pushes, or live inference will be changed.

- [x] Canonical guidance and documentation updated.
- [x] Three adapters support direct lead delegation without review commands.
- [x] Preserved contracts, full checks, and independent review verified.

Final revision verification: `npm run check` passed **217 tests, zero failed/skipped** (84 Node, 74 OpenCode, 59 Pi), plus both typechecks and briefing drift validation. Offline package dry-run passed with 33 files; the final full check also verified Pi import closure. The obsolete parser/gate module and its three tests were removed after all consumers were gone. Command/grant-only tests were removed or revised; direct start/resume, ownership, configuration, read-only, failure, and concurrency regressions were retained or adapted. Each adapter first reproduced direct delegation failing at the old gate.

Independent review of `/tmp/opencode/fusion-natural-review-verified-cn6ix17j` validated all 59 source hashes and 24 changes and personally ran 179 scoped tests. It found one introduced model-safety regression: removing the command had also removed the check that the root still uses the selected lead model/effort. A regression reproduced direct delegation succeeding after an external model change; three production lines restore the check without restoring authorization. The test covers a different model, changed effort, and missing root model, including native prompt admission and recovery after reapplying setup. Independent corrective verification personally passed that test (18 assertions) and closed the sole finding; the complete 217-test check followed the correction.

Exact final revised source: `/tmp/opencode/fusion-natural-review-final-f20un9q8`, with a full baseline delta and SHA256 manifest. Runtime/test hashes match the independently verified correction; the dependency lockfile is unchanged. Only this completion record follows the final freeze. These checks establish the native delegation path, not live-model obedience to the user-request-only instruction. Copilot resumed-child model adoption and live host inference remain unverified. No installed configuration, model choices, conversations, commits, or pushes were changed.

The completed records below describe the superseded command-gated implementation, not the current requested behavior.

## Superseded command-gated design and verification

Add an optional `fusion-reviewer` to OpenCode, Copilot, and Pi. The user alone selects its model/effort and requests review through `/fusion-review [session=<id>] [request]`. Prefer a different model family from the lead (and author where practical), as advice only: never infer, substitute, or enforce model families.

A command grants one review invocation, fresh or explicitly resumed. It does not authorize automatic re-review or unrelated future work. Reviewer conversations survive for later user-requested follow-ups. Use a fresh conversation for an unrelated change. Authorizations are transient, root-owned, and cleared on setup/off/navigation as supported; saved model choices do not grant permission to review.

The lead owns a neutral, source-backed packet: exact baseline and reviewed snapshot, included working-tree/untracked scope, requirements and unchanged contracts, concise affected flow, complete in-scope diff and relevant surrounding source/callers/types/tests, reported verification and limitations, author rationale separated from facts, risks, and the review contract. The sidekick may gather artifacts; a compaction summary is orientation, not code evidence. Snapshot assembly remains a lead/sidekick responsibility, not a new generic snapshot engine.

Reviewer tools are bounded read-only inspection and host-supported skill loading. No shell, editing, web, repository-wide search, delegation, or autonomous planning. Default external skill suggestion is `code-review-and-quality`; specialized security/performance skills are optional where relevant. Fusion does not install, fetch, or vendor review skills. Missing skills are disclosed; inline review boundaries and evidence requirements still apply. Pi exposes installed compatible review skills only for the reviewer, leaving other child isolation unchanged.

**Approved Copilot compatibility exception:** native `write_agent` group selectors (`scope=children|siblings`) are denied while Fusion is off, even if no reviewer was configured or created. Explicit non-reviewer targets and passive reads remain available. The task RPC does not establish a complete communication-recipient catalog, so a reviewer-free task list is insufficient proof that a group message cannot invoke a retained reviewer. After the independent audit surfaced this broader restriction, the user explicitly chose **Keep strict guard** over relaxing the user-only guarantee or deferring the Copilot reviewer.

## Work and verification

1. Baseline + shared contract: baseline full check and pre-change source copy; shared command grammar and single-use root gate tests, canonical packet/reviewer guidance.
2. Independent adapters: OpenCode lead-owned; Copilot and Pi delegated after lead source inspection. Behavioral RED/GREEN tests cover no grant, explicit grant, consumption, resume/ownership, concurrency/failure, optional models/history migration, read-only tools, and skill access. No wording/snapshot tests.
3. Integration: regenerate marked Copilot guidance, update setup/install/architecture docs, review exact source changes against the pre-change copy, run `npm run check` and package dry-run.

No installed settings or model choices are changed; no commits, pushes, live inference, or non-web network access.

## Checkpoints

- [x] Baseline `npm run check`: 161 tests and both typechecks passed. Source copy: `/tmp/opencode/fusion-reviewer-before-ce0w64z8`.
- [x] Shared parser/gate and guidance.
- [x] OpenCode runtime, RPC, picker, profiles, and regressions.
- [x] Copilot runtime, commands, setup/state, profiles, and regressions.
- [x] Pi lifecycle, skills/tools, state/viewer, and regressions.
- [x] Integration, documentation, independent review, and final checks.

Initial integrated `npm run check`: 211 tests and both typechecks passed (81 Node, 71 OpenCode, 59 Pi). Offline package test verifies the Pi entrypoint's transitive local imports. User approved adding the pre-existing omitted Pi viewer modules to the package file list; no unrelated viewer behavior was changed. Copilot guidance regenerated and drift check passed.

Independent reviews use frozen snapshot `/tmp/opencode/fusion-reviewer-review-d9spkya0` and its manifest/diff against the baseline source copy. Additional OpenCode setup-race tests and documentation refinements follow that snapshot and will be rechecked before completion. No live-host inference, installed-setting mutation, or model selection was performed.

### Independent findings and resolutions

- OpenCode: Off now holds the same setup lock as Apply; new commands invalidate older waiting invocations; prompt admission correlates the exact native invocation rather than any fresh direct child. Reproduced with adapter fixtures. A runtime-generated prompt prefix is correlation only, never authorization; live native forwarding remains an assumption and mismatches fail closed.
- Copilot: unknown Fusion descendant origins no longer bypass bounded `view` checks when startup/replay evidence is unavailable. Commands and hooks share one attachment binding so a delayed hook cannot revoke a new attachment's grant. Reproduced with inert fixtures.
- Pi: reviewer isolation now excludes independently discovered `APPEND_SYSTEM.md` content. Native reviewer discovery skips missing/mismatched configured packages; a package-free loader preserves installed compatible skill access and disabled resource filters. Real-SDK deterministic regressions reproduced the ambient prompt leak and intercepted an installation attempt before fixing them; 60 Pi tests and its typecheck pass.

OpenCode corrective review closed the original three traces and identified an earlier metadata-wait variant: invocation epochs must be captured before any async metadata lookup. The existing regression now covers both metadata and prior-turn waits and passed after reproducing this variant. Copilot corrective tests close missed-start/replay, reconnect ordering failures, and native reviewer invocation after Off. Unrelated explicit agent calls and passive reads remain available; the broader group-messaging restriction was surfaced and explicitly approved rather than presented as unchanged ordinary behavior.

Corrective evidence is retained in `/tmp/opencode/fusion-reviewer-opencode-corrections-tp2wtwod` and `/tmp/opencode/fusion-reviewer-pi-corrections-zngw3bux`, each with a manifest and delta from the initial review snapshot. The OpenCode entry-epoch correction follows its snapshot and was independently checked against the stable workspace delta. Final integration checks followed all corrections, rather than reusing the earlier green result.

### Final verification

- `npm run check`: **228 passed, zero failed/skipped** (89 Node, 79 OpenCode, 60 Pi); both TypeScript checks passed. Briefing drift and offline Pi import-closure packaging checks passed.
- `npm pack --dry-run --offline --ignore-scripts`: passed; 34 files include all reviewer profiles, shared review support, and both existing Pi viewer modules.
- Frozen reviewed source: `/tmp/opencode/fusion-reviewer-final-8ikq9m6f`; full baseline diff, corrective delta, and SHA256 manifest account for untracked/ignored source. No baseline source files were removed; all workspace hashes matched at freezing and no code-line trailing whitespace was introduced. Final verification notes and the approved compatibility clarification were added to documentation after freezing; runtime and test source remained unchanged.
- Independent OpenCode correction verification: all original traces plus metadata-wait, reapply, and Off/reapply variants closed; 79 tests personally rerun, no remaining high-conviction findings in the corrective delta.
- Independent Pi correction verification: append isolation and cached-only discovery closed; three targeted native-SDK tests personally rerun, no remaining high-conviction findings in scope.
- Independent Copilot correction verification: missed-start inspection, reconnect grant preservation, and after-Off reviewer invocation traces closed; 76 scoped tests personally rerun, zero skipped. The remaining group-messaging compatibility finding was explicitly resolved by user approval of the strict policy described above; it was not relabelled a fix or silently ignored.

Live inference/host loading, OpenCode native prefix forwarding, and Copilot resumed-child model adoption remain unverified. Packet adequacy and focused-reading intent are instruction contracts, not runtime guarantees. No installed configuration, user model choices, conversations, commits, or pushes were changed.

Latest pre-fix full check: 215 tests and both typechecks passed. This did not cover the independently identified races/isolation gap; passing tests were not treated as approval.
