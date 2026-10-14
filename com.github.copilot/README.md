# Copilot CLI setup

[← Roles, tools and restrictions](../README.md)

## 1. Install

You need **Copilot CLI** and **Git**. This repository is public; downloading the plugin requires no repository credentials. Sign in to Copilot to use your models.

```sh
copilot plugin install bluetripod/fusion-big-boss
copilot plugin list
```

This uses the [native plugin installer](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#plugin-specification-for-install-command); no local clone or marketplace setup is needed.

CLI 1.0.95 supports direct installs but emits a deprecation warning; GitHub's current documentation still lists this route.

## 2. Enable and choose models

1. Open a new Copilot session. If extensions are disabled, run `/settings experimental on` and start another session.
2. Approve Fusion's **hook, command and tool registration** prompts. The guard needs hook approval to enforce restrictions.
3. Run **`/fusion`**. Choose **Lead** and **Sidekick** models and thinking effort; optionally add Advisor and Reviewer.
4. Select **Apply this setup**. Escape cancels without applying.

Worker choices are saved in native `/subagents` settings with required model enforcement. Wait for workers to finish before applying a different setup.

## Everyday use

| Command | Purpose |
| :--- | :--- |
| `/fusion` | Choose models and supported context tiers |
| `/fusion status` | Show the current setup |
| `/fusion off` | Return to the default agent; retain history and worker restrictions |
| `/fusion apply` | Re-enable the saved setup |

For code review, configure Reviewer, then ask **“Do a code review with the Fusion reviewer.”** Ask the lead normally for worker progress, messages or cancellation.

## Know before you use it

- **Context:** native `default` / `long_context` tiers, not custom token budgets. Long context may cost more.
- **Follow-ups:** `write_agent` steers running workers or continues idle ones. Terminal workers cannot resume; foreground advisors do not support these follow-ups.
- **Updates:** run `copilot plugin update fusion-big-boss`, then start a fresh session after active work finishes. After upgrading from a differently named plugin, reapply `/fusion`; settings/history are not migrated automatically.

**Checks:** from the repository root, run `npm test`. See [development](../README.md#development) for dependencies and the full suite. SDK tests use an inert transport; live permissions and delivery still depend on the installed CLI.
