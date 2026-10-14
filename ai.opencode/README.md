# Fusion for OpenCode V2

Fusion's [shared design](../README.md) uses a user-selected lead, persistent execution sidekick, optional read-only advisor and user-invoked read-only reviewer. The lead owns source analysis and may code directly; sidekicks execute only precise coding, location-only lookups or specified commands. Advisor/reviewer roles may use their own evidence-only sidekicks, never the lead's coding worker. This directory is an OpenCode adapter, **not** a native Agent Plugins namespace.

## Install and configure

Clone to a stable absolute path and run `npm ci` from the repository root. Add the **adapter directory**, not the repository root, to the existing `plugins` array in `~/.config/opencode/opencode.jsonc`, preserving other entries:

```jsonc
{ "plugins": ["/absolute/path/to/fusion/ai.opencode"] }
```

Install the four Markdown definitions separately as `~/.config/opencode/agents/{fusion,fusion-sidekick,fusion-advisor,fusion-reviewer}.md`, pointing to `/absolute/path/to/fusion/ai.opencode/agents/<role>.md`. The reviewer's model remains optional. For a new install with no files at those names:

```sh
mkdir -p "$HOME/.config/opencode/agents"
for role in fusion fusion-sidekick fusion-advisor fusion-reviewer; do
  ln -s "/absolute/path/to/fusion/ai.opencode/agents/$role.md" "$HOME/.config/opencode/agents/$role.md"
done
```

If an agent or old `~/.config/opencode/plugins/fusion/` already exists, inspect and privately back up only Fusion-owned files before replacing them; a duplicate auto-discovered plugin can conflict. The configured directory needs `index.ts` and `tui.ts`; package-root exports alone do not activate a local directory. For an offline tarball, `npm pack` and install it in a stable prefix, then configure its `node_modules/fusion-big-boss/ai.opencode` directory and install its four agent definitions the same way. No publication is needed.

When upgrading a utility-role installation, finish or stop active workers before loading the new source. Inspect and remove only the old Fusion-owned `fusion-utility.md` definition or symlink; do not delete conversations or unrelated configuration. Saved lead/sidekick/advisor model choices and sidekick IDs are retained; obsolete utility choices are ignored and old utility workers cannot resume through Fusion. Three-role histories remain valid with reviewer unconfigured. Install the new Fusion-owned reviewer definition without overwriting an unrelated profile, then reapply your setup explicitly after a safe reload; no model is substituted into another role.

## Use

In a **new TUI session**, `/fusion` shows current lead, sidekick, advisor, and reviewer models/efforts. Pick any role to see up to three recently applied model-and-effort choices (newest first), or **Choose new model** to search models and choose an effort. Advisor and reviewer can also be disabled there. Recents are shared across Fusion sessions at this location; only explicitly selected roles are recorded on successful Apply or `/fusion-models`, and clearing an optional role keeps its recents. **Apply this setup** is explicit; Escape discards the draft without changing models or creating a session. Initial setup requires lead and sidekick. **Use last setup** copies the last successfully applied supported choices into a draft for explicit Apply; opening the menu never restores it automatically. Unavailable models/efforts are shown but cannot be applied; they must be replaced, not silently substituted. Existing sessions take precedence over remembered choices.

In an active Fusion session, `/fusion` puts **Turn Fusion off** first. It switches that same root conversation to its prior available ordinary primary agent, or asks you to pick an available non-Fusion primary agent if none was saved. Escape from either menu changes nothing. Off keeps the exact current model/effort, conversation, saved Fusion choices/recents, and worker sessions; it releases Fusion's root prompts, tool routing, and static agent permissions for subsequent turns. Already-running background workers finish under their original guarded roles and return to the same session. The disabled menu shows **Enable saved Fusion setup** to turn Fusion back on explicitly; that step validates the saved models, while turning off does not require them to remain available.

In Mini/headless clients, use `/fusion-models <lead> <sidekick> [advisor=<model>|advisor=off] [reviewer=<model>|reviewer=off] [task]`. Each model is `provider/model#thinking` when thinking options exist; use `#default` for the model's default. Omitted optional roles keep their current selections. Removed `utility=` and `adhoc=` setup options are rejected. The text command also remembers successfully applied choices. No model-callable tool configures Fusion models.

### Per-role context budgets

**Choose new model** now walks through model → thinking effort → context budget. **Change context budget** edits just that role's window without changing its model or effort. Default uses the model's native window; supported choices are 50k, 100k, 200k, 400k and 1M, limited by the model's advertised capacity. No explicit budget above 1M is offered. Recents and last setup retain the budget; old choices without a budget still mean Default. Escape discards all draft changes.

The picker uses OpenCode's live, provider-specific limits, not the raw cached catalog. If a provider integration reports less than 1M, that choice is hidden even when another route to the same model advertises a larger window.

Text choices can append `@100k` or `@1M`, for example `anthropic/claude-haiku-5-5@100k` or `openai/gpt-6-astra#high@1M`. Older thousand-unit suffixes remain readable and display in million units where appropriate; stored alias IDs remain unchanged. Fusion registers only needed runtime model aliases with the same provider/API `modelID`, effort variants and output limit, but smaller native context/input limits. Aliases are rebuilt from stored setups after reload, appear in OpenCode's native model catalog, and are excluded from Fusion's model search. Original models and configuration files are unchanged. Coding and evidence sidekicks share the selected sidekick budget; advisors/reviewers use their own. Returning to Default selects the original catalog model. Turning Fusion off preserves the exact selected alias/window along with the current model/effort.

Keep OpenCode's native `compaction.auto` enabled (the host default). Its configured buffer starts compaction before the smaller window, and its normal recent-history retention and failure handling still apply. Fusion does not override global compaction settings or manually delete transcript messages. This is a **local compaction target, not a provider context/pricing tier or strict billing ceiling**: token estimates, large new inputs/tool results, fixed instructions/tools, and compaction requests can exceed the target or fail. Summarization is lossy and uses the selected model, so it can incur charges. Host references: [model aliases](https://opencode.ai/v2/docs/models#aliases), [compaction and limits](https://opencode.ai/v2/docs/compaction).

### Session usage

Run **`/usage`** in the terminal UI to display recorded input, output, cache-read and cache-write tokens plus estimated USD cost, grouped by provider/model with a grand total. It includes the current session and all descendant subagents, including advisor/reviewer evidence workers, and works with Fusion on or off. Context-budget aliases and thinking efforts are combined under their base model.

The report reads paginated session histories without making model requests or adding messages. Recorded compaction usage is included; usage with no recorded model appears as **Unattributed**. Missing metrics/prices show **n/a**, and partially priced totals show the known subtotal marked **partial**. OAuth/subscription models often have no recorded price. Costs are host estimates, not invoices; in-flight calls and auxiliary requests the host does not record may be absent. An unreadable session produces an error rather than an apparently complete total. This command requires the TUI plugin; it is not a headless server command.

Lead/advisor/reviewer reads require explicit offset and a limit of at most **350 lines per call**. These callers read and interpret source themselves. File-location jobs specify roots and filenames/symbols/patterns and return only paths/line ranges/matched symbols. Coding briefs must specify target files/symbols, exact changes, scope, checks and stop conditions; multi-file work may stay with the lead. Sidekicks return failures or ambiguity rather than starting analysis or repair loops. Independent specified jobs may run concurrently where supported; coordinate conflicting writes and stable-tree checks. Sidekicks cannot spawn agents or execute two tasks in the same session simultaneously; steering messages can update the active task.

The lead and advisor may start multiple native `subagent(agent: fusion-sidekick, background: true)` sessions for independent, fully specified jobs. Omit `sessionID` to start a worker; pass its confirmed ID for a related follow-up, which waits for that worker's previous turn. Existing saved sidekick IDs remain explicitly resumable. Every worker uses the user's chosen sidekick model and belongs to its direct caller. The reviewer retains its single persistent evidence child.

Advisor/reviewer evidence children expose only read/grep/glob/shell for file locations, read-only Git inspection and specified test/check commands. Source edits, staging, commits, pushes and repairs are forbidden; shell side effects remain governed by instructions and ordinary host permissions. Advisors support background calls (recommended for retaining control) and foreground calls; reviewers run in background. Only the lead can start consultations/reviews. Advisor models require tool support; a text-only choice must be explicitly replaced or disabled by the user, never silently substituted.

### Live worker controls

The lead can call `fusion_worker` with an owned `sessionID` and `action: "status"`, `"message"`, or `"cancel"`. Advisor/reviewer callers use the same tool for their own evidence sidekicks. Status returns last-observed busy/retry/idle state and up to 16,000 characters of recent assistant/tool output; missed status events or a disconnected stream give `unknown`, not an inferred completion. Hidden reasoning is excluded.

For example, `action: "message", message: "Wrap up now with findings and unfinished checks"` queues ordinary steering at the next host boundary. There is no wrap-up command or automatic timeout. Messages use native synthetic input with `resume: false`, so a race with completion cannot restart an idle worker; a queued message may remain pending for a later continuation. Known-idle/cancelling workers are not messaged. Cancellation requests interruption of the target and its recorded owned evidence children, preserves histories/output and file edits, and reports requested/interrupted/idle/failed outcomes. Inspect status again when needed to check an asynchronous cancellation failure. A stuck provider/tool may delay stopping; cancellation is not rollback or a guaranteed final summary.

### Optional code review

Choose a reviewer model/effort explicitly, then ask the lead normally: **“Do a code review with the Fusion reviewer.”** The lead prepares the [shared review packet](../skills/fusion-delegation/SKILL.md#user-requested-code-review) and invokes the native background `fusion-reviewer`. No review command, token, or user-supplied session ID is needed. Prefer a different model family from the lead/author; this advice never blocks your selection, and Fusion never substitutes a model.

The lead chooses a retained same-change reviewer conversation itself, verifying direct-root ownership and waiting for its prior native turn; unrelated changes start fresh. Missing-evidence follow-ups complete the requested review. A separate review or re-review needs another explicit user request, never an automatic post-coding or post-fix run. This is an instruction policy, not a runtime intent detector. Setup, Off, and plugin reload preserve owned review records and history; Off prevents new Fusion delegation while already-running reviewers remain read-only.

The reviewer can use native `read` with explicit offset and a limit of 1–350 lines, `skill` for installed guidance, and its own evidence-sidekick delegation. It cannot run shell/Git directly, edit, search broadly, browse or invoke other roles. Install `code-review-and-quality` yourself through OpenCode's normal skill configuration; it is loaded explicitly, not bundled or fetched. Missing skills/evidence must be disclosed. Exact frozen source, not the mutable workspace or a compacted summary, defines the reviewed snapshot. Distinguish supplied results from requested sidekick checks. Packet completeness and source interpretation are instruction contracts, not automatic proof of understanding.

## Checks and limits

From the **repository root**, use `npm run test:opencode` and `npm run typecheck:opencode`; `npm run check` runs the full local workspace checks. The shared briefing skill is read at plugin setup. To diagnose loading, use `node scripts/verify-opencode-loader.mjs /absolute/path/to/fusion/ai.opencode active`; it starts and stops only its private server, without model inference.

The current TUI must load updated `tui.ts`; an already-running shared server may still serve older RPC methods until a **safe future reload**. An unknown `inspect`/`validate` method means the client and server are out of step. Do not force-restart an active service merely to install this source. Fake-context and isolated private-server checks do not establish live child-model switching or all native permission behavior. Host guards are not sandboxes: scripts, indirect tools, or network programs can bypass named-tool checks.
