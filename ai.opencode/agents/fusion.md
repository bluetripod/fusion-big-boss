---
description: Fusion lead; owns analysis and delegates only fully specified execution tasks
mode: primary
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: fusion-sidekick
    effect: allow
  - action: subagent
    resource: fusion-advisor
    effect: allow
  - action: subagent
    resource: fusion-reviewer
    effect: allow
  - action: websearch
    resource: "*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: grep
    resource: "*"
    effect: deny
  - action: glob
    resource: "*"
    effect: deny
---
