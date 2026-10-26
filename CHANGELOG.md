# Changelog

## 0.2.1 — 2026-10-26

### Fixed

- Load the Pi extension on bundled Pi builds (1.4.0). The Fusion viewer no longer
  resolves `@earendil-works/pi-tui` from disk through `pi-coding-agent`; it imports
  the host-provided package directly, which works on Pi 1.3.0 and 1.4.0.
- Declare `@earendil-works/pi-tui` as an optional peer dependency.

## 0.2.0 — 2026-10-16

### Added

- Optional Pi sandbox tool handoff for new and resumed Fusion workers, including
  nested read-only evidence workers. A missing provider or incomplete tool
  replacement refuses execution rather than falling back to host tools.

### Fixed

- Register OpenCode's bundled Fusion agents when the plugin loads, so new roles
  are available after package updates without installing separate agent links.
- Use native Git package install/update instructions for OpenCode and Pi.
- Restore the selected context limit before inference with Pi 1.3.0's earlier
  busy-session state, while retaining running-turn and model-choice guards.
- Recognize tiered model pricing in usage reports without recalculating stored
  costs or treating token thresholds as prices.

### Security

- Update the plugin SDK, UI runtime and Pi development SDKs to remove the reported
  serializer, telemetry, HTTP-cache and brace-expansion dependency advisories.
