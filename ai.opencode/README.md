# OpenCode V2 setup

[← Roles, tools and restrictions](../README.md)

## 1. Install

You need **OpenCode V2**, configured model access, **Node/npm**, and a local clone of this repository.

From the **repository root**, install dependencies:

```sh
npm ci
```

Add the adapter's absolute path to the existing `plugins` array in `~/.config/opencode/opencode.jsonc`. Preserve your other settings and plugins:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/fusion-big-boss/ai.opencode"]
}
```

Then link the four agent definitions. Run from the repository root; existing files are not overwritten:

```sh
(
  set -eu
  ROOT="$(pwd)"
  mkdir -p "$HOME/.config/opencode/agents"
  for role in fusion fusion-sidekick fusion-advisor fusion-reviewer; do
    ln -s "$ROOT/ai.opencode/agents/$role.md" "$HOME/.config/opencode/agents/$role.md"
  done
)
```

Keep the clone in place. If Fusion is already installed, inspect existing profiles and plugin entries before replacing anything; avoid loading duplicate copies.

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
- **Updates:** finish active work before reloading. The terminal UI and background service must both load the updated plugin; an unknown `inspect`/`validate` method usually means their versions differ.

**Checks:** from the repository root, run `npm run test:opencode` (requires Bun) and `npm run typecheck:opencode`. See [development](../README.md#development) for the full suite.
