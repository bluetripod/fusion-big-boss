import { Rpc } from "@opencode/plugin/rpc"

const selection = {
  type: "object",
  properties: {
    lead: { type: "string" }, sidekick: { type: "string" },
    advisor: { type: "string" },
    reviewer: { type: "string" },
  },
  required: ["lead", "sidekick"],
  additionalProperties: false,
} as const

const choices = {
  type: "object",
  properties: {
    lead: { type: "string" }, sidekick: { type: "string" },
    advisor: { type: ["string", "null"] },
    reviewer: { type: ["string", "null"] },
  },
  required: ["lead", "sidekick"],
  additionalProperties: false,
} as const

const recent = {
  type: "object",
  properties: {
    lead: { type: "array", items: { type: "string" } },
    sidekick: { type: "array", items: { type: "string" } },
    advisor: { type: "array", items: { type: "string" } },
    reviewer: { type: "array", items: { type: "string" } },
  },
  required: ["lead", "sidekick", "advisor", "reviewer"],
  additionalProperties: false,
} as const

export const FusionRPC = Rpc.define({
  id: "fusion-mode",
  methods: {
    inspect: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, additionalProperties: false },
      output: {
        type: "object", properties: { current: selection, last: selection, recent, active: { type: "boolean" }, previous: { type: "string" } }, required: ["active"], additionalProperties: false,
      },
      errors: { invalid_session: { type: "object", additionalProperties: false } },
    },
    validate: {
      input: choices,
      output: selection,
      errors: { invalid_models: { type: "object", additionalProperties: false } },
    },
    configure: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          lead: { type: "string" },
          sidekick: { type: "string" },
          advisor: { type: ["string", "null"] },
          reviewer: { type: ["string", "null"] },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: selection,
      errors: {
        invalid_session: { type: "object", additionalProperties: false },
        invalid_models: { type: "object", additionalProperties: false },
      },
    },
    disable: {
      input: { type: "object", properties: { sessionID: { type: "string" }, agent: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"], additionalProperties: false },
      errors: { invalid_session: { type: "object", additionalProperties: false }, invalid_agent: { type: "object", additionalProperties: false } },
    },
  },
  events: {},
})
