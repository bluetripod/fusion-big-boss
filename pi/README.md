# Fusion for Pi

[← Roles, tools and restrictions](../README.md)

## Install

Requires **Pi 1.3.0**, **Node ≥22.19.0**, and configured model access.

```sh
pi install git:github.com/bluetripod/fusion-big-boss
```

## Configure

1. Run `pi` in your project, then `/fusion`.
2. Choose **Lead** and **Sidekick** models and thinking effort. Their model/effort selections must differ.
3. Optionally configure **Advisor**, **Reviewer**, and context budgets.
4. Select **Apply this setup**.

Keep automatic compaction enabled when using context budgets.

## Update

Finish active work, then run:

```sh
pi update git:github.com/bluetripod/fusion-big-boss
```

Restart Pi or run `/reload`.

## Commands

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Configure models or turn Fusion on/off |
| `/fusion-agents` or **Alt+A** | Inspect running and completed workers |
| `/usage` | Show token usage and estimated cost |

In the worker viewer, use arrows and Enter to select, **o** for tool output, and Esc to return.

With Reviewer configured, ask: **“Do a code review with the Fusion reviewer.”**

Switching sessions or branches stops running workers.

**Development:** `npm run test:pi` and `npm run typecheck:pi`. [Full checks](../README.md#development).
