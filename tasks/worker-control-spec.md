# Spec: live Fusion worker controls

Status: implemented and locally verified across all three adapters. Wrap-up is
an ordinary message, not a separate action or automatic timeout; advisors can
use background execution.

## Objective

Let the lead inspect, steer, wrap up, and cancel its running Fusion workers in
OpenCode, Copilot CLI, and Pi. Treat these as one worker-lifecycle capability,
with host-specific implementations and consistent user-facing meanings.

## Behavior

- Expose model-callable controls for `status`, `message`, and `cancel`.
  Reuse native tools where they meet the contract; add small adapter tools where
  required. Every action targets one explicit, confirmed worker ID.
- `status` returns promptly without waiting for completion or invoking a model:
  observed state, available timing/activity, and bounded recent output. Mark
  missing, stale, or truncated information honestly; never invent progress.
- `message` sends text to an active worker at the host's next steering boundary.
  Acknowledgement means admitted/queued, not read or obeyed. It does not launch
  a second concurrent task. Asking for a fresh progress report uses this action;
  available replies can subsequently be inspected with `status`.
- Wrap-up is an ordinary message asking for findings, changed files,
  checks/results, blockers, and unfinished work. The caller decides when to
  inspect progress or cancel; there is no dedicated action or automatic timeout.
- `cancel` promptly requests targeted interruption and returns available partial
  output. Report cancellation requested separately from confirmed stopped.
  Preserve conversation history, output, and file changes; cancellation is not
  rollback. A worker-written final summary is best-effort, not guaranteed.
- Preserve existing completion delivery and make explicit cancellation visible
  to the caller. Do not leak results into a different root or navigated Pi branch.
- Permit background advisor consultations in OpenCode and Pi, and instruct the
  lead to use them when it needs to retain control. Keep foreground consultation
  available for callers choosing to wait. Copilot already uses background advisors.

## Ownership and lifecycle

- Lead controls its own direct sidekick, advisor, and reviewer workers.
  Advisor/reviewer controls its own evidence sidekicks. Sidekicks gain no worker
  management authority. Verify caller and target identity for each control.
- Reject foreign, ambiguous, unverified, and stale targets. Control tools cannot
  select models or bypass existing role/read-only boundaries.
- Live steering is distinct from existing completed-worker continuation. A known
  terminal target returns its state rather than silently starting another task.
  Handle completion racing with steering according to verified host semantics;
  do not claim an atomic running-only delivery guarantee where none exists.
- Cancelling a parent should request cancellation of its verified active evidence
  descendants too. Explicitly report any descendant whose stop cannot be confirmed.
- Live handles are tied to the current run and cleaned up on completion,
  cancellation, navigation, or plugin disposal.
- Host interruption is cooperative. No hard process-termination, guaranteed
  summary, instant steering, or no-further-writes guarantee is implied.

## Verified host evidence (before implementation)

- OpenCode uses `@opencode/plugin` 2.0.15. `ai.opencode/index.ts:532,564`
  currently waits before continuations; `:538` requires foreground advisors.
  Installed `node_modules/@opencode/plugin/dist/promise/session.d.ts:143`
  exposes context, prompt, synthetic, interrupt, and wait. Installed client
  interrupt input uses `resume`, unlike the live plugin documentation's
  `continue` example: implementation must follow the pinned API and typecheck.
  `session.status` events expose busy/retry/idle; session metadata alone records
  the last outcome, not authoritative current running status.
- Copilot's installed 1.0.95 native `read_agent` reads running status/history;
  `write_agent` steers running workers. Its SDK `tasks` RPC exposes list,
  getProgress, sendMessage, and cancel. Fusion's busy-write prohibition is in
  `com.github.copilot/extensions/fusion-guard/hooks.mjs:31-39`.
  New controls must verify ownership themselves; existing lead-to-advisor
  continuation lacks the same target-ancestry check as sidekick/reviewer routes.
  Native cancellation settlement/cascade semantics require verification.
- Pi uses SDK 0.87.1. `pi/index.ts:285-312` already captures a controller and
  live session; `pi/viewer.ts` retains progress. Custom steering messages can
  avoid prompt-template expansion and splitting persisted viewer runs.
  `pi/worker.ts` already connects abort signals to session cancellation.
   Explicit cancel delivery must be distinguished from navigation suppression.

## Implementation verification and host limits

- OpenCode: `fusion_worker` uses observed status events, bounded recent context,
  native synthetic steering with `resume: false`, and asynchronous interruption.
  Unknown observations remain unknown; queued steering may remain pending if a
  completion race leaves the worker idle. Tests use a controlled host harness.
- Copilot: native `read_agent`/`write_agent` plus registered `fusion_cancel`.
  Running writes steer; idle writes retain native continuation semantics, and
  terminal-state writes remain subject to host acceptance. This reuse cannot
  promise atomic running-only delivery. Installed SDK dispatch was verified over
  an inert transport; live CLI delivery and interruption settlement were not.
- Pi: real SDK with deterministic fake-provider tests verifies same-run steering,
  waking an idle owner while evidence remains blocked, targeted cancellation,
  retained partial results, and branch isolation. No live-provider inference.
- Final `npm run check`: 302 tests passed and both typechecks passed; one optional
  SDK setup test skipped there passed separately with the installed SDK selected.
  Briefing drift and offline package-content checks passed.

## Project structure and style

- OpenCode implementation/tests: `ai.opencode/index.ts`, role profiles, and
  `ai.opencode/*.test.ts`; use its existing TypeScript style, e.g.
  `await ctx.session.wait({ sessionID: input.sessionID })`.
- Copilot implementation/tests: `com.github.copilot/extensions/fusion-guard/`,
  agent profiles, and `tests/*.test.mjs`; preserve existing ESM/semicolon style.
- Pi implementation/tests: `pi/index.ts`, `pi/worker.ts`, viewer integration,
  and `pi/*.test.ts`; retain existing session ownership and cleanup patterns.
- Shared role guidance: `skills/fusion-delegation/SKILL.md` and generated Copilot
  sections. Update adapter READMEs and `ARCHITECTURE.md` with actual guarantees.
- Keep scheduling and host APIs in their adapters; avoid a new generic worker
  framework or dependencies.

## Commands and testing strategy

Use existing Bun tests for OpenCode and Node tests for Copilot/Pi, including
Pi's fake-provider SDK integration tests. Test observable lifecycle behavior,
not exact prompt text or tool-schema snapshots.

```sh
npm test
npm run test:opencode
npm run typecheck:opencode
npm run test:pi
npm run typecheck:pi
npm run sync:briefing
npm run check
```

## Success criteria

1. While a controlled worker is blocked on a test barrier, its caller can read
   available progress and enqueue steering without awaiting worker completion.
2. Releasing that barrier delivers steering into the same worker conversation;
   no second simultaneous task or unintended template expansion occurs.
3. Targeted cancellation leaves unrelated workers running and preserves partial
   output/history. Owned evidence descendants receive cancellation requests.
4. Wrap-up text follows the same steering path as any other message. Stop failure
   remains visible rather than being reported as successful termination.
5. Foreign-worker controls, sidekick-originated controls, stale Pi branch handles,
   and invalid inputs are rejected before affecting a worker.
6. Background advisors return control to the lead and retain normal result
   delivery, evidence-worker ownership, and user-selected models.
7. Relevant tests and both typechecks pass; generated briefing stays in sync.
   Distinguish fake-host verification from any live host smoke tests performed.

## Boundaries and approval

- Always preserve user work, selected models, worker histories, ownership, and
  evidence-only role restrictions. Keep changes limited to this capability.
- Ask before adding dependencies, changing installed configuration, or running
  non-web network operations. Live inference is not required for unit checks.
- Never commit/push without approval, delete histories to cancel work, or weaken
  tests merely to satisfy changed behavior.
- User approved all adapters and background advisors, and removed the proposed
  wrap-up action/timer. Host API uncertainties are implementation verification
  items, not promises to simulate unsupported behavior.
