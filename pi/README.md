# Fusion for Pi 0.87.1

Fusion's [shared design](../README.md) uses a user-selected lead, persistent background execution sidekick, optional read-only advisor and user-requested read-only reviewer. Callers analyze source themselves; sidekicks receive only fully specified coding, location-only lookups or exact command jobs.

## Install and configure

Requires Node >=22.19.0. Pi supplies the extension's SDK dependencies. From the workspace you want to work in, start Pi with:

```sh
pi --no-extensions --extension /absolute/path/to/fusion/pi/index.ts
```

This loads Fusion as the only extension for that launch. To use the independent user-level `ask_user` extension in the same session while retaining `--no-extensions`, load both explicitly:

```sh
pi --no-extensions --extension /absolute/path/to/fusion/pi/index.ts --extension "$HOME/.pi/agent/extensions/ask-user/index.ts"
```

Without `--no-extensions`, Pi discovers user-level extensions normally. The root `pi.extensions` manifest also supports Pi package discovery. Start a new Pi process or reload when idle after updating the extension.

Run **`/fusion`**, select your models and efforts, then **Apply this setup**:

- Every role offers its **three most recent model + effort + context choices** and **Choose new model** (search, model, effort, context). **Change context budget** edits only an already-selected role's window.
- Lead and Sidekick are required and must have different selections. Advisor and Reviewer also offer **Off**; neither has an implicit default.
- For Reviewer, prefer a different model family from the lead and author where practical. A different provider or model size is not necessarily a different family. This is advice only; Fusion never infers, selects, substitutes, or enforces a family.
- **Use last setup** fills the draft. Escape anywhere discards it. Unavailable choices cannot be applied.
- Fusion becomes active only after Apply; Pi's existing default is not automatically adopted. The default Pi footer shows `Fusion: on` while active, `Fusion: off` after turning it off, and no Fusion status on branches without a setup.

For explicit text setup:

```text
/fusion-models provider/model#effort provider/model#effort [advisor=provider/model#effort|off] [reviewer=provider/model#effort|off]
```

Omitting Advisor or Reviewer retains its current selection. Only the user can configure models. Existing branch/history data retains the lead, sidekick, advisor selections and child identities; older history gets empty reviewer recents without losing other choices. Obsolete utility fields and references are ignored; old utility chats are neither adopted as the sidekick nor deleted. Explicit `utility=` options are rejected.

### Per-role context budgets

Default keeps the native model window. The picker offers 50k, 100k, 200k, 400k and 1M only where the model's advertised capacity supports them; no explicit budget above 1M is offered. Text choices can append a budget, for example `provider/model#low@100k` or `provider/model#high@1M`. Older thousand-unit suffixes remain readable and display in million units where appropriate. Budgets persist in branch setup, recents and last setup; old choices without a suffix remain Default. A different budget alone does not make identical lead/sidekick models and efforts distinct.

Fusion passes a session-local model clone with a smaller `contextWindow`, retaining the API provider/id, output limit and selected effort. It does not mutate the shared model registry or settings files. The root restores its selected window on resume/branch changes; children and advisor/reviewer-owned evidence sidekicks receive it on creation and resume. Evidence workers use the selected sidekick budget. Turning Fusion off restores the current model's native window without deleting the setup or history.

Keep Pi's native automatic compaction enabled (the host default). Native compaction uses the reduced window and the existing reserve/recent-history settings, including model-specific overrides; Fusion does not inflate `reserveTokens`, change global settings or blindly trim messages. A **local compaction target is not a provider context/pricing tier or strict billing ceiling**. Large new inputs/tool results and fixed instructions can exceed it; summarization can itself exceed it, fail, or lose details. Pi can continue after threshold-compaction failure, so this chooser cannot guarantee requests remain under a provider's long-context pricing threshold. See [Pi's native compaction guide](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/compaction.md).

### Session usage

Run **`/usage`** to display recorded input, output, cache-read and cache-write tokens and estimated USD cost, grouped by provider/model with a grand total. It works without active Fusion setup and includes all entries in the current session, including compacted/alternate-branch history, plus saved Fusion descendant sessions and evidence workers. Returned subagent usage is counted from child histories, not again from copied tool/background results. Subagents created by other extensions are not discoverable through Fusion's storage.

Explicit usage entries (such as cache warming) are included. Summaries and other tool usage without model attribution appear as **Unattributed**. Missing metrics/prices show **n/a**; partial costs show the known subtotal, and missing or unfinished child histories are flagged. Costs are recorded estimates, not invoices; zero pricing on a subscription/unpriced model is treated as unavailable. In-flight or unrecorded usage may be absent. The command only reads history and displays a notification; it does not call a model or add report text to its context.

While Fusion is active, `/fusion` offers **Turn Fusion off** at the top of the menu. This disables Fusion's prompt and tool routing in the same Pi session without changing the current model, conversation, saved setup, or worker histories. Finish or stop active workers before turning it off. The disabled menu offers **Enable saved Fusion setup**; Escape changes nothing.

| Role | Pi behavior |
| --- | --- |
| Lead | Owns interpretation, planning, coding and review; text reads (explicit offset >=1, limit 1–350), edit/write, `fusion_delegate` and `fusion_worker` for its direct workers. May implement multi-file changes directly. |
| Sidekick | Multiple persistent root coding workers for independent precise coding, location-only lookups and specified commands/checks. No analysis, open-ended exploration, repair loops or delegation. |
| Advisor | Read-only consultation; optional background execution, focused 350-line text/skill reads and its own parallel background evidence-only sidekicks with worker controls. No direct shell, edits, web or other agents. |
| Reviewer | User-requested background review; focused 350-line reads, advertised installed skill files and its own persistent evidence-only sidekick. Independent reviewer conversations may run concurrently. No direct shell, edits, web or other agents. |

The lead reads and interprets relevant source itself, reusing sufficient context. File-location jobs supply roots and concrete filenames/symbols/patterns, returning only paths/line ranges/matched symbols. Coding briefs specify target files/symbols, exact changes, scope, checks and stop conditions; file count alone never requires delegation. Delegate only when a precise handoff is worthwhile. Failures or ambiguity return to the caller, not autonomous worker debugging. Independent specified jobs may run concurrently where supported; coordinate conflicting writes and stable-tree checks.

Advisor/reviewer SDK sessions expose a narrow `fusion_delegate` tool for their own persistent evidence sidekicks on the user's selected sidekick model. Advisors may run independent evidence jobs in parallel; each reviewer retains one evidence worker. These workers can only locate files, inspect Git read-only or run specified tests/checks, with read/grep/find/ls/bash and no edit/write/delegation/worker-control tools. Source edits, staging, commits, pushes and repairs are forbidden; shell side effects remain instruction-governed, not sandboxed. Evidence delegation returns a live worker ID when that job starts; same-worker continuations wait for the prior job. Results arrive directly in the owning advisor/reviewer conversation as custom follow-ups; its native session stays alive until the evidence and resulting turns settle. The owner can keep working and use `fusion_worker` during evidence execution. Ownership, explicit model and cancellation checks apply; missing or foreign histories fail rather than silently replacing the worker. Nested evidence jobs appear in the caller's trajectory, not as separate root viewer runs.

For lead/advisor delegation, omit `sessionID` to create a sidekick for an independent task, or supply its confirmed ID to resume related work, including after an explicit user change to its model/effort. Each session permits only one active task: further continuations serialize behind it and revalidate ownership, branch/setup and selected models before starting. A failed predecessor preserves its history for continuation; cancellation cancels already-queued continuations too. A new explicit continuation remains possible after cancellation settles. Different worker sessions may run concurrently. Ownership is recorded when the first child messages become durable, so navigating away after a persisted edit and returning to the original branch retains that worker. Existing saved worker histories remain explicitly resumable. Background completion returns to the lead as a queued follow-up. Switching sessions or branches aborts and waits for active and queued child work. Apply requires an idle lead and no active children. Recent selections are stored privately per workspace under Pi's agent directory; applied setup and confirmed child references follow the active session branch.

### Running worker controls

Use `fusion_delegate` with `role: 'advisor', background: true` when the lead needs to retain control during a consultation. Omitted/false `background` keeps the foreground advisor option. Sidekicks, evidence workers and reviewers require explicit `background: true`.

`fusion_worker` accepts `action: 'status' | 'message' | 'cancel'`, an explicit `sessionID`, and `message` only for the message action:

- **status** returns observed run state, elapsed time, available activity and bounded recent assistant/tool output (up to six messages, last 4,000 characters), without waiting or invoking a model.
- **message** admits ordinary steering text into the same native conversation. Use it for wrap-up requests too: ask for findings, changed paths, checks/results, blockers and unfinished work. No special action or timer exists. Custom messages bypass command/template expansion and do not split viewer runs. An idle advisor/reviewer still waiting on background evidence wakes to process steering immediately, so it can cancel stuck evidence; the acknowledgement does not wait for that model response. Fusion tracks the wake turn through settlement and reports processing failures while cancelling outstanding evidence. Busy workers queue steering through the native session. Acknowledgement does not prove reading or obedience; completion can race with delivery. Terminal runs are not restarted, and no concurrent model prompt is launched.
- **cancel** promptly requests cooperative abort, includes available partial output and requests cancellation of active owned evidence descendants. The immediate result reports **requested**, with descendant stops **unconfirmed**. It does not wait for stopping, force-kill processes, undo changes or guarantee a final summary. Background cancellation outcomes are delivered to the owner when the run settles; navigation suppresses stale root delivery.

The lead controls only its direct workers; advisors/reviewers control only their own evidence workers. Sidekicks have no management tool. Live handles are released on settlement; root/branch navigation invalidates them and aborts/drains work. Confirmed completed IDs return recorded status without restarting anything; incomplete durable history is not proof that work stopped. Foreign, unknown and stale live targets are rejected. Cancellation preserves histories, output and edits for explicit later continuation.

## User-requested review

After explicitly choosing a Reviewer model and effort, ask the lead normally:

```text
Do a code review with the Fusion reviewer.
```

The lead prepares a neutral packet with the exact baseline and frozen reviewed snapshot, included working-tree/untracked scope, requirements, complete in-scope diff and relevant source/callers/tests, and reported checks and limitations. See the [shared packet and reviewer contract](../skills/fusion-delegation/SKILL.md). A moving workspace or a compacted summary alone is not snapshot evidence.

The lead calls native `fusion_delegate` with `role: 'reviewer'`, the prepared packet as `task`, and `background: true`. It chooses a retained confirmed root-owned reviewer conversation for the same change when appropriate; unrelated work starts fresh. You do not need a review command, authorization token, or session ID. Missing-evidence follow-ups stay within the requested review. A separate review or re-review needs another explicit user request, and the lead is instructed never to invoke the reviewer automatically after coding or fixes. This is instruction policy, not runtime intent detection or a permission gate.

Independent reviewer conversations can run concurrently; continuations of the same confirmed reviewer wait for its prior turn. Session/branch navigation aborts and drains active and queued work without delivering stale results. Changing models or turning the reviewer off does not delete saved reviewer conversations; durable partial review history remains resumable after a provider failure. Review results return to the lead once as model-visible follow-ups; the lead retains interpretation, fixes, and the final answer.

Workers retain native project instructions and `APPEND_SYSTEM.md`. Coding/evidence sidekicks append Fusion role rules to the native worker system prompt, retaining Pi's tool guidance. All worker roles use native installed-skill discovery with disabled filters preserved; the reviewer can read any advertised installed skill, with `code-review-and-quality` as its default review guidance. Discovery skips missing/mismatched packages instead of installing them. Advisor/reviewer documents use bounded `read` calls (explicit offset >=1, limit 1–350). Fusion does not install/fetch/vendor skills or enable scripts. Skills grant no extra execution/editing authority. Missing default review guidance is disclosed and the inline contract still applies; an available skill must actually be read before claiming it was loaded. Gather only precise missing evidence or ask the lead, never broad exploration. Distinguish supplied results from sidekick checks.

## Subagent viewer

Use **Alt+A** or **`/fusion-agents`** to list this root session's running and finished sidekick, advisor, and reviewer runs. Reviewer IDs remain available when useful, but are not required in user requests. Select with ↑/↓ and Enter; Esc closes the list. The detail overlay renders the prompt, assistant text, and result as Markdown, with numbered tool steps and three-line output previews. Press **o** to toggle all tool output between previews and full output (bounded to 2,000 characters per step). Scroll with ↑/↓ or PgUp/PgDn; Esc returns to the list. Above the editor, a live widget shows up to five runs (active runs first), elapsed time, activity/result, and prompt previews.

The viewer keeps no separate persistent storage. Confirmed, owned child histories remain viewable after reload, with each resumed prompt shown separately. Child histories record terminal cancellation/failure, including an idle advisor/reviewer waiting on evidence, so an earlier waiting response is not reconstructed as successful completion. An incomplete persisted trajectory is shown as aborted because its live status cannot be recovered. Session/branch switches clear the in-process viewer state.

## Checks and limits

From the **repository root**, use `npm run test:pi` and `npm run typecheck:pi`; `npm run check` runs the full local workspace checks.

**Pi-specific limits:** model availability, auth and supported effort are checked, but Pi lacks metadata to preflight general tool support. There are no native websearch/webfetch tools; the sidekick can retrieve known URLs through its shell within existing approvals. Fusion adds no retrieval framework. Child extensions stay disabled to preserve role tool boundaries; installed skills are read as documents, not extension-provided capabilities. Background usage appears in follow-up details, not Pi's native initiating tool totals. Pi navigation aborts/drains workers to preserve branch isolation rather than keeping them live across navigation; Off waits for work to settle instead of changing routing underneath it. Routing guards are not an OS sandbox, and other extensions loaded in the lead can interfere with them. Deliberate human `!`/`!!` commands remain available.

Verified with isolated SDK sessions and a deterministic fake provider: ordinary user prompting can reach native reviewer delegation without a command. This verifies plumbing, not live-model obedience to the user-request-only instruction. API references: [extensions](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/extensions.md), [SDK](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/sdk.md), [packages](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/packages.md).
