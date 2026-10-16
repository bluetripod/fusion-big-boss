# Changelog

## 0.2.0 — 2026-10-16

### Added

- Optional Pi sandbox tool handoff for new and resumed Fusion workers, including
  nested read-only evidence workers. A missing provider or incomplete tool
  replacement refuses execution rather than falling back to host tools.

### Fixed

- Restore the selected context limit before inference with Pi 1.3.0's earlier
  busy-session state, while retaining running-turn and model-choice guards.
- Recognize tiered model pricing in usage reports without recalculating stored
  costs or treating token thresholds as prices.

### Security

- Update the plugin SDK, UI runtime and Pi development SDKs to remove the reported
  serializer, telemetry, HTTP-cache and brace-expansion dependency advisories.

Release tags identify fixed commits. Existing tags keep their original source
and dependency files; fixes in this release do not rewrite older releases.
