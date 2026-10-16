# Fusion for OpenCode

[← Roles, tools and restrictions](../README.md)

## Install

Requires **OpenCode ≥2.0.31**, **Git**, and configured model access.

```sh
opencode plugin add github:bluetripod/fusion-big-boss
```

## Configure

1. Run `opencode` in your project, then `/fusion`.
2. Choose different **Lead** and **Sidekick** models, then their thinking effort and context budgets.
3. Optionally configure **Advisor** and **Reviewer**.
4. Select **Apply this setup**.

Keep `compaction.auto` enabled when using context budgets.

## Update

Finish active work, then run:

```sh
opencode plugin update github:bluetripod/fusion-big-boss
```

Restart OpenCode. If the background service still uses the old version, run `opencode service restart`.

## Commands

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Configure models or turn Fusion on/off |
| `/usage` | Show token usage and estimated cost |
| `/fusion-models` | Configure models in Mini or headless clients |

```text
/fusion-models <lead> <sidekick> [advisor=<model>] [reviewer=<model>]
```

Model format: `provider/model#effort`, optionally followed by a context budget such as `@100k`. Use `advisor=off` or `reviewer=off` to disable a role. Omitted roles keep their current choices.

With Reviewer configured, ask: **“Do a code review with the Fusion reviewer.”**

**Development:** `npm run test:opencode` (requires Bun) and `npm run typecheck:opencode`. [Full checks](../README.md#development).
