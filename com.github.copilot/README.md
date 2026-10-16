# Fusion for Copilot CLI

[← Roles, tools and restrictions](../README.md)

## Install

Requires **Copilot CLI**, **Git**, and a signed-in Copilot account.

```sh
copilot plugin marketplace add bluetripod/fusion-big-boss
copilot plugin install fusion-big-boss@bluetripod-plugins
```

## Configure

1. Open a new Copilot session. If extensions are disabled, run `/settings experimental on` and start another session.
2. Approve Fusion's hook, command and tool registration prompts.
3. Run `/fusion`. Choose **Lead** and **Sidekick** models and thinking effort; optionally configure **Advisor** and **Reviewer**.
4. Select **Apply this setup**.

Wait for workers to finish before changing the setup. Copilot uses `default` and `long_context` context tiers.

## Update

Finish active work, then run:

```sh
copilot plugin update fusion-big-boss@bluetripod-plugins
```

Start a new Copilot session.

## Commands

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Configure models and context tiers |
| `/fusion status` | Show the current setup |
| `/fusion off` | Turn Fusion off |
| `/fusion apply` | Re-enable the saved setup |

With Reviewer configured, ask: **“Do a code review with the Fusion reviewer.”**

## Switching from an older plugin name

Run `/fusion` again after installing. Settings and history from a differently named plugin are not migrated automatically.

**Development:** `npm test`. [Full checks](../README.md#development).
