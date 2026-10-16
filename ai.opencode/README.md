# OpenCode V2 setup

[← Roles, tools and restrictions](../README.md)

## 1. Install

You need **OpenCode V2 (2.0.31 or newer)**, **Git**, and configured model access.

```sh
opencode plugin add github:bluetripod/fusion-big-boss
opencode plugin list
```

OpenCode manages the package and its dependencies. Fusion registers its four bundled agents automatically; no manual clone, configuration edits, or agent links are needed.

**Migrating from the old local setup:** finish active workers, remove the old Fusion path from `plugins`, and remove only the Fusion agent symlinks pointing into that checkout from `~/.config/opencode/agents/`. Preserve custom files and unrelated settings. Then install the package above and restart OpenCode. Reapply your model choices with `/fusion` if needed.

## 2. Choose models

1. Open a **new terminal UI session** and run **`/fusion`**.
2. Choose **Lead** and **Sidekick** models, thinking effort and context budgets.
3. Optionally choose **Advisor** and **Reviewer**.
4. Select **Apply this setup**. Escape cancels without applying.

**Use last setup** fills the menu with saved choices; you still need to Apply.

## Everyday use

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Change setup, turn Fusion off or re-enable saved choices |
| `/usage` | Show recorded session/worker tokens and estimated cost (terminal UI) |
| `/fusion-models` | Configure models in Mini/headless clients; syntax below |

```text
/fusion-models <provider/model#effort> <provider/model#effort> [advisor=<provider/model#effort>] [reviewer=<provider/model#effort>]
```

The first two choices are Lead and Sidekick. Use `advisor=off` or `reviewer=off` to disable an optional role; omitted roles retain their choices. A choice can include a budget, such as `provider/model#high@100k`.

For code review, configure Reviewer, then ask **“Do a code review with the Fusion reviewer.”** Ask the lead normally for worker progress, messages or cancellation.

## Know before you use it

- **Context:** choose Default or a supported smaller window, up to 1M. Keep native `compaction.auto` enabled. Budgets are local targets, not token or spending guarantees.
- **Off:** preserves your model, conversation and workers. Existing workers retain their restrictions.
- **Updates:** run `opencode plugin update github:bluetripod/fusion-big-boss`. Finish active work before restarting the terminal UI; if the background service still has the old plugin, run `opencode service restart`. The package update includes all four agents.

**Checks:** from the repository root, run `npm run test:opencode` (requires Bun) and `npm run typecheck:opencode`. See [development](../README.md#development) for the full suite.
