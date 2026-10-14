# Three-role Fusion

## Completed: Pi and Copilot behavioral parity

User approved making Pi/Copilot consistent with the working OpenCode adapter as
far as native SDKs permit. OpenCode is the reference implementation.

1. Pi: preserve native coding-worker guidance, align supported project/skill
   context, serialize same-worker continuations, allow independent reviewers,
   retain worker ownership across navigation, and preserve cancellation outcomes.
   Verify SDK/fake-provider lifecycle regressions and Pi typecheck.
2. Copilot: align native capabilities, caller/worker configuration validation,
   cancellation admission and reviewer-worker reuse where task APIs permit.
   Verify guard/SDK regressions; document native steering/continuation limits.
3. Integrate adapter docs and shared guidance as needed, review diffs against
   `/tmp/opencode/fusion-parity-before-726yvlwl`, run `npm run check`.

Use native facilities rather than emulating unavailable tools. Preserve role
boundaries, user-chosen models, existing histories and installed configuration.
Pi and Copilot implementation can proceed independently; root docs/integration
belong to the lead. No commits or dependency additions.

Acceptance checks:
- Coding workers retain native coding guidance plus Fusion scope; installed
  project/skill context is available without extending read-only tool authority.
- Same-worker continuation never overlaps the previous task; independent workers
  (including reviewers) can progress concurrently where the native host permits.
- Cancellation blocks further evidence admission for that run; failure and later
  legitimate continuation do not silently lose history or permanently lock it.
- Disabled/unavailable role configuration blocks new work consistently, while
  inspecting/stopping existing workers remains possible.
- Navigating away preserves durable child ownership; restored status does not
  label cancelled partial work successful.
- SDK gaps are explicit: no invented native web tools, no promises that native
  task messaging atomically distinguishes steering from continuation, and no
  live-provider verification claim from fake-provider tests.

Verification: `npm run check` passed (134 Node tests: 133 passed, one optional
SDK test skipped; 95 OpenCode tests; 97 Pi tests; both typechecks). The optional
installed Copilot SDK setup test and cancellation dispatch test passed separately
over an inert transport. Briefing drift and offline packaging checks passed.
Integration regressions cover first history becoming durable during navigation
abort and overlapping cancellation requests retaining the admission block.
OpenCode remains identical to the pre-parity snapshot. Adapter guides record
native tool, continuation, terminal-task and Pi navigation/Off differences.

## Completed extension: live worker controls

Approved contract: [worker-control-spec.md](worker-control-spec.md), with ordinary
messages for wrap-up and no timer. The previous three-role work below is complete.

1. OpenCode: add owned-worker status/message/cancel tools using pinned host APIs;
   allow background advisors. Verify lifecycle/ownership tests and typecheck.
2. Copilot (independent): permit native running-worker steering and add targeted
   cancellation using task RPC with verified caller/target ancestry. Verify guard
   and extension-registration behavior with Node tests.
3. Pi (independent): retain live session/controller handles, expose controls to
   lead and evidence callers, and support background advisors/evidence work.
   Verify fake-provider delivery/cancellation and typecheck.
4. Integrate shared instructions/docs, regenerate Copilot briefing, run all checks.

Use existing native mechanisms; preserve partial output and histories, report
requested versus confirmed cancellation, and reject foreign/stale controls.
Shared files and integration belong to the lead; host adapters can be built in
parallel. Tests precede runtime changes. No new dependencies or installed setup edits.

## Approved scope

Replace utility with the existing persistent sidekick in OpenCode, Copilot, and Pi. Lead owns source-grounded planning, consequential decisions, review, and the final answer. Sidekick owns bounded investigation, implementation, commands, Git, checks, and evidence retrieval. Advisor remains optional and reasoning-only. Model choices remain explicit user actions; no defaults or substitutions are introduced.

## Decisions and boundaries

- For each task, lead assesses whether its next decision needs source evidence. It reads focused ranges or obtains verbatim excerpts before choosing an implementation approach; missing evidence calls for read-only discovery, not immediate implementation.
- Keep bounded lead reads and one persistent sidekick conversation. Independent tool calls/jobs may run concurrently where supported; coordinate conflicting writes and checks requiring a stable tree. Do not overlap prompts to the same worker.
- Sidekick performs Git and host-supported retrieval directly; preserve authorization and raw evidence. It cannot delegate to other agents. Advisor cannot use tools.
- Remove utility from new setup, routing, profiles, and model pickers. Existing lead/sidekick/advisor selections survive; obsolete utility selections/references are ignored without substituting models or deleting conversations.
- Change repository sources only. Do not change installed configuration, user-selected models, or live sessions. Do not commit or push.

## Slices and verification

1. **Shared briefing and OpenCode**: clarify discovery versus implementation; update schemas, picker, state projection, guards, and profiles. Verify direct sidekick Git/web access, no nested agents, bounded reads, model ownership/continuity, and legacy saved choices with focused tests and typecheck.
2. **Copilot**: remove utility setup and delegation, permit sidekick Git/known-URL fetch, preserve approvals and identity/model checks. Verify hooks, state migration, picker/Apply/Off behavior, and extension entrypoint tests. Shared briefing generation is owned by slice 1.
3. **Pi**: remove utility tools/sessions and nested delivery, give sidekick the combined coding/lookup tools, retain child ownership and background lifecycle. Verify state migration, direct commands, no nested delegation, fake-provider SDK behavior, cancellation, viewer behavior, and typecheck.
4. **Integration and documentation**: update role maps/install guidance, remove only artifacts made unused by utility removal, regenerate Copilot briefing, and run `npm run check`. Review remaining utility references for intentional migration coverage only.

Copilot and Pi are independent bounded implementation streams after lead inspection of their relevant source. Shared files, OpenCode, root documentation, and integration review remain with the lead.

## Risks

- Saved setup may contain obsolete fields: project supported roles rather than validate removed models or map them into sidekick.
- Installed utility profiles may remain after repository removal: document explicit cleanup and reload; do not delete user configuration automatically.
- Prompt wording does not prove source understanding: verify tool/state contracts automatically and describe evidence-first planning as a behavioral instruction, not a comprehension guarantee.
- Shell access is not an OS sandbox; preserve the documented boundary.
