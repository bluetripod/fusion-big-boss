# Three-role Fusion tasks

## Automatic worker supervision

- [x] Shared monitor and prompt-guided concise updates without status truncation, tested with controlled time; a scratch mutation confirms repeated requests are caught.
- [x] OpenCode, Pi and Copilot lifecycle integration and focused tests.
- [x] General guidance, generated copies and full checks: 159 Node, 100 OpenCode, 105 Pi tests, both typechecks, offline packaging and briefing drift passed. Final Copilot continuation regression checked separately.

## Pi/Copilot parity with OpenCode

- [x] Pi prompt/context/capabilities and worker scheduling/lifecycle alignment: 97 SDK/behavior tests and typecheck passed, including navigation-time first-history persistence.
- [x] Copilot native search, foreground advisors, configuration/cancellation admission and Off alignment; guard and installed-SDK checks passed, including overlapping cancellation regression.
- [x] Document host differences and review integration. `npm run check` passed: 133 Node tests (one optional SDK test passed separately), 95 OpenCode tests, 97 Pi tests, both typechecks, briefing drift and offline packaging. Installed-SDK setup/cancellation checks used inert transport; no live-provider inference.

## Live worker controls

- [x] OpenCode status/message/cancel and background advisor: 95 tests and typecheck passed. A temporary-copy ownership mutation was caught by the regression test; restored afterward.
- [x] Copilot running steering and owned cancellation: 109 scoped tests passed including installed 1.0.95 SDK dispatch over an inert transport.
- [x] Pi live controls, background advisor/evidence calls and partial output: 84 tests and typecheck passed, including waking an idle advisor to cancel blocked evidence before completion.
- [x] Shared guidance and adapter docs updated; generated briefing refreshed. `npm run check` passed: 123 Node, 95 OpenCode and 84 Pi tests, both typechecks, briefing drift and offline packaging checks. One optional SDK setup test skipped in the aggregate run passed separately with `FUSION_COPILOT_SDK` set. No live-provider inference, installed configuration changes, commits or pushes.

## Completed three-role work

- [x] Baseline: `npm run check` passed before runtime edits; source copy retained at `/tmp/opencode/fusion-three-role-before-sjaf85eo` for reviewing the initially untracked workspace.
- [x] Shared briefing + OpenCode: meaningful failing regressions, three-role state/setup/guard/picker conversion, 52 OpenCode tests and typecheck passed.
- [x] Copilot: meaningful failing regressions, three-role profiles/setup/guards/state conversion, 57 scoped tests passed.
- [x] Pi: meaningful failing regression, combined sidekick tools and lifecycle/state/viewer conversion, 44 scoped tests and typecheck passed.
- [x] Integration: regenerated briefing, updated documentation/install migration guidance, removed utility profiles and obsolete OpenCode/Pi Git-routing imports. Retained the shared Git detector because Copilot still uses it to verify sidekick identity.
- [x] Final checkpoint: `npm run check` passed (161 tests, both typechecks); independent source review found no introduced regressions, and comparison against the pre-change copy confirmed scoped changes. Briefing drift check and offline package dry-run passed. No installed settings/model choices changed; no commits or pushes. Live-host loading and inference were not tested.
