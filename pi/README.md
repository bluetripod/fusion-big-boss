# Pi setup

[← Roles, tools and restrictions](../README.md)

## 1. Install

You need **Pi 1.3.0**, **Node ≥22.19.0**, and configured model access. Update your global Pi installation independently if needed to meet the supported version. Pi supplies the extension's SDK dependencies.

Install Fusion with Pi's native package manager and confirm it is listed:

```sh
pi install git:github.com/bluetripod/fusion-big-boss
pi list
```

Then run ordinary `pi` from the **project you want to work on**. The installed package loads automatically; no manual clone, `npm ci`, or extension flags are needed.

When migrating from a manual copy, remove only Fusion's old explicit `-e`/`--extension` arguments or extension-path settings so it is not loaded alongside the installed package. Preserve unrelated extensions and settings.

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
- **Updates:** run `pi update git:github.com/bluetripod/fusion-big-boss`, then start a fresh Pi process after active workers finish, or reload when idle.

**Checks:** from the repository root, run `npm run test:pi` and `npm run typecheck:pi`. See [development](../README.md#development) for dependencies and the full suite. Tests use a deterministic fake provider.
