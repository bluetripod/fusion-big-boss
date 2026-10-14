# Automatic worker supervision

Status: implemented, with prompt-guided concise updates.

## Goal

Every agent that delegates work supervises its own active workers automatically.
Use runtime timers and observed activity, with brief general owner instructions.
Apply the same contract to OpenCode, Copilot CLI and Pi where their SDKs permit.

## Proposed behavior

- Check active workers every 60 seconds, starting when delegation begins.
- Send one concise, grouped progress update to each owner: worker identity,
  elapsed time, observed state, latest activity and outstanding blockers.
- Ask workers to keep progress replies concise and choose enough detail to make
  the status clear. Do not truncate status fields or omit workers to enforce a
  length limit. Prioritize quiet/blocked workers; avoid unnecessary logs or task
  repetition through prompt guidance.
- Deliver updates at the owner's next safe processing boundary; wake an idle
  owner awaiting workers where supported. Do not start overlapping owner turns.
  Pi checks for owner idleness on each tick; Copilot foreground owners cannot
  receive native messages. OpenCode coalesces pending context updates, and Copilot
  keeps at most one pending native owner message until consumption is observed.
- If a running worker has no new observable activity since the prior check,
  request a brief progress/blocker update through its existing message route.
  Keep at most one such request outstanding per worker until new activity arrives.
- Report missing telemetry as unknown and unchanged activity as no observed
  progress, not proof of a hang. Include long-running tool activity when available.
- The owner decides whether to clarify, redirect, wait or cancel. Time alone
  never triggers cancellation, a replacement worker or a model change.
- Stop monitoring on completion or confirmed cancellation; retain observation
  during cancellation settlement. Dispose timers on adapter shutdown/detachment
  and invalidate stale callbacks on session/branch changes.
- Monitor only caller-owned workers. Advisors/reviewers supervise their own
  sidekicks; the lead supervises its direct sidekicks, advisors and reviewers.
- Reuse host status/events and messaging. Report unsupported delivery or status
  capabilities explicitly; avoid restarting finished workers to request updates.

## Implementation scope

- Runtime adapters: `ai.opencode/index.ts`,
  `com.github.copilot/extensions/fusion-guard/`, `pi/index.ts`, `pi/worker.ts`.
- General owner guidance: `skills/fusion-delegation/SKILL.md` and generated copies.
- Follow existing adapter style and lifecycle ownership; add no dependencies.
- Inspect relevant SDK notification/timer contracts before choosing integration points.
- Status inspection should not invoke a model. Processing owner notifications
  and answering progress requests can consume model calls and tokens.

## Verification

Use controlled clocks and existing fake-host/SDK fixtures to verify cadence,
grouping, caller ownership, no overlapping turns, bounded update requests,
unknown/quiet-worker handling and cleanup after completion/navigation/disposal.
Keep host-specific limitations explicit; fake-provider tests do not prove live delivery.

Run `npm test`, `npm run test:opencode`, `npm run typecheck:opencode`,
`npm run test:pi`, `npm run typecheck:pi` for affected slices; finish with
`npm run sync:briefing` and `npm run check` after integration.

## Approval

The user approved the 60-second cadence and grouped owner updates, and requested
prompt-guided brevity instead of hard length caps. Commits still require explicit
message approval.
