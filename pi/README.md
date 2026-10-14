# Pi setup

[← Roles, tools and restrictions](../README.md)

## 1. Load Fusion

You need **Pi 0.87.1**, **Node ≥22.19.0**, configured model access, and a local clone of this repository. Pi supplies the extension's SDK dependencies.

From the **project you want to work on**, run:

```sh
pi --no-extensions --extension /absolute/path/to/fusion-big-boss/pi/index.ts
```

Replace the path with your clone's location. This loads only Fusion; omit `--no-extensions` if you also want your usual extensions.

## 2. Choose models

1. Run **`/fusion`**.
2. Choose **Lead** and **Sidekick** models and thinking effort. Their model/effort selections must differ.
3. Optionally choose **Advisor**, **Reviewer**, and a context budget for each role.
4. Select **Apply this setup**. The footer shows **Fusion: on**.

**Use last setup** fills the menu with saved choices; you still need to Apply. Escape discards changes.

## Everyday use

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Change setup, turn Fusion off or re-enable saved choices |
| `/fusion-agents` or **Alt+A** | Inspect running and completed workers |
| `/usage` | Show recorded session/worker tokens and estimated cost |

In the worker viewer, use arrows and Enter to select, **o** for tool output, and Esc to return.

For code review, configure Reviewer, then ask **“Do a code review with the Fusion reviewer.”** Ask the lead normally for worker progress, messages or cancellation.

## Know before you use it

- **Context:** choose Default or a supported smaller window, up to 1M. Keep native automatic compaction enabled. Budgets are local targets, not token or spending guarantees.
- **Navigation:** switching sessions/branches aborts and drains workers. Saved history and edits remain. Finish or stop workers before changing setup or turning Fusion off.
- **Tools:** Pi has no native web-search/fetch tools. Child extensions are disabled; installed skills remain readable. Other extensions in the lead session can affect routing.
- **Updates:** reload only when idle, or start a fresh Pi process.

**Checks:** from the repository root, run `npm run test:pi` and `npm run typecheck:pi`. See [development](../README.md#development) for dependencies and the full suite. Tests use a deterministic fake provider.
