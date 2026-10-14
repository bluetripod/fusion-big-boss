import { expect, test } from "bun:test"
import fusion from "./index"
import fusionTui from "./tui"

const models = [
  { name: "Sol", providerID: "openai", id: "sol", capabilities: { tools: true, output: ["text"] }, variants: [{ id: "high" }, { id: "low" }] },
  { name: "Luna", providerID: "openai", id: "luna", capabilities: { tools: true, output: ["text"] }, variants: [] },
  { name: "Nova", providerID: "openai", id: "nova", capabilities: { tools: true, output: ["text"] }, variants: [{ id: "medium" }] },
]
for (const model of models) Object.assign(model, { limit: { context: 400000, output: 32000 } })

function ui(answers: Array<string | undefined>, initial: { current?: any; last?: any; recent?: any; active?: boolean; previous?: string } = {}, sessionID?: string, validateError?: string, catalog = models, server?: { validate: (input: any) => Promise<any>; configure: (input: any) => Promise<any> }, usageClient = {}) {
  const calls: any[] = [], configured: any[] = [], validated: any[] = [], disabled: any[] = [], created: any[] = [], navigated: any[] = [], alerts: any[] = [], toasts: any[] = [], modelSync: any[] = []
  let render: () => unknown = () => undefined
  let layer: () => any = () => undefined
  let state = initial
  const location = { directory: "/tmp/opencode" }
  fusionTui.setup({
    location,
    data: { location: { model: { sync: async () => { modelSync.push(true) }, list: () => catalog }, agent: { sync: async () => {}, list: () => [
      { id: "fusion", mode: "primary", hidden: false, name: "Fusion" },
      { id: "build", mode: "primary", hidden: false, name: "Build" },
      { id: "plan", mode: "primary", hidden: false, name: "Plan" },
      { id: "fusion-sidekick", mode: "subagent", hidden: false, name: "Sidekick" },
    ] } } },
    ui: {
      slot: (claim: any) => { render = claim.render },
      dialog: { select: async (options: any) => { calls.push(options); return answers.shift() }, alert: async (msg: any) => { alerts.push(msg) } },
      router: { current: () => sessionID ? { type: "session", sessionID } : { type: "home" }, navigate: (next: any) => navigated.push(next) },
      toast: { show: (message: any) => { toasts.push(message) } },
    },
    keymap: { layer: (callback: any) => { layer = callback } },
    client: {
       rpc: () => ({ inspect: async () => state, disable: async (input: any) => { disabled.push(input); state = { ...state, active: false }; return { agent: input.agent ?? state.previous } }, validate: async (input: any) => { validated.push(input); if (validateError) throw new Error(validateError); return server ? server.validate(input) : input }, configure: async (input: any) => {
         configured.push(input)
         const current = server ? await server.configure(input) : { ...state.current, ...input }
         delete current.sessionID
          if (current.advisor === null) delete current.advisor
          if (current.reviewer === null) delete current.reviewer
        state = { current, last: current, active: true }
        return current
      } }),
       session: { create: async (input: any) => { created.push(input); return { id: "ses_new" } } },
       ...usageClient,
    },
  } as any)
  render()
  return { run: () => layer().commands[0].run(), usage: () => layer().commands.find((command: any) => command.slash?.name === "usage").run(), calls, configured, validated, disabled, created, navigated, alerts, toasts, modelSync, get state() { return state } }
}

test("/usage displays recorded model totals without configuring a session or prompting a model", async () => {
  const h = ui([], {}, "root", undefined, models, undefined, {
    model: { list: async () => ({ data: [] }) },
    session: { list: async () => ({ data: [], cursor: {} }) },
    message: { list: async () => ({ data: [{ id: "m", type: "assistant", model: { providerID: "p", id: "a" }, tokens: { input: 1234, output: 50, cache: { read: 600, write: 30 } }, cost: 0.25 }], cursor: {} }) },
  })
  await h.usage()
  expect(h.alerts[0].message).toContain("p/a")
  expect(h.alerts[0].message).toContain("1,234")
  expect(h.alerts[0].message).toContain("$0.2500")
  expect(h.created).toEqual([])
  expect(h.configured).toEqual([])
  const home = ui([])
  await home.usage()
  expect(home.alerts.length).toBe(1)
  expect(home.created).toEqual([])
})

test("Turn Fusion off uses the previous primary agent without model catalog or configuration", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna" }
  const h = ui(["disable"], { current, active: true, previous: "build" }, "ses_existing", undefined, [])
  await h.run()
  expect(h.calls[0].options[0].title).toBe("Turn Fusion off")
  expect(h.disabled).toEqual([{ sessionID: "ses_existing" }])
  expect(h.modelSync).toEqual([])
  expect(h.configured).toEqual([])
  expect(h.created).toEqual([])
  expect(h.state.current).toEqual(current)
  expect(h.toasts.at(-1).message).toContain("background workers")
})

test("missing previous primary offers an explicit non-Fusion picker; cancel changes nothing", async () => {
  const current = { lead: "openai/missing#high", sidekick: "openai/luna" }
  const cancel = ui(["disable", undefined], { current, active: true }, "existing", undefined, [])
  await cancel.run()
  expect(cancel.calls[1].options.map((item: any) => item.value)).toEqual(["build", "plan"])
  expect(cancel.disabled).toEqual([])
  expect(cancel.modelSync).toEqual([])
  const choose = ui(["disable", "plan"], { current, active: true }, "existing", undefined, [])
  await choose.run()
  expect(choose.disabled).toEqual([{ sessionID: "existing", agent: "plan" }])
  expect(choose.configured).toEqual([])
})

test("disabled session explicitly re-enables its saved setup without creating a new session", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna" }
  const h = ui(["enable"], { current, active: false }, "existing")
  await h.run()
  expect(h.calls[0].options[0].title).toContain("Enable saved Fusion setup")
  expect(h.configured).toEqual([{ sessionID: "existing" }])
  expect(h.created).toEqual([])
  expect(h.state.active).toBe(true)
})

test("Choose new edits only sidekick while preselecting its current model", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/sol#low", advisor: "openai/nova#medium" }
  const h = ui(["sidekick", "new", "openai/nova", "default", "default", "apply"], { current, last: current }, "ses_existing")
  await h.run()
  expect(h.calls[0].options.map((item: any) => item.title).join(" ")).toContain("Lead openai/sol · high")
  expect(h.calls[0].options.map((item: any) => item.value)).toContain("sidekick")
  expect(h.calls[2].current).toBe("openai/sol")
  expect(h.calls[3].current).toBe("default")
  expect(h.configured).toEqual([{ sessionID: "ses_existing", sidekick: "openai/nova#default" }])
  expect(h.created).toEqual([])
  expect(h.state.current).toMatchObject({ lead: current.lead, advisor: current.advisor })
})

test("context-only edits preserve models, effort and other roles, and Default removes the budget", async () => {
  const current = { lead: "openai/sol#high@200k", sidekick: "openai/luna", advisor: "openai/nova#medium" }
  const h = ui(["sidekick", "context", "100000", "apply"], { current }, "existing")
  await h.run()
  expect(h.configured).toEqual([{ sessionID: "existing", sidekick: "openai/luna@100k" }])
  expect(h.state.current.lead).toBe(current.lead)
  expect(h.state.current.advisor).toBe(current.advisor)
  const reset = ui(["lead", "context", "default", "apply"], { current }, "existing")
  await reset.run()
  expect(reset.configured).toEqual([{ sessionID: "existing", lead: "openai/sol#high" }])
  const cancel = ui(["lead", "context", undefined], { current }, "existing")
  await cancel.run()
  expect(cancel.configured).toEqual([])
})

test("new models include a context step and cancellation never applies a partial choice", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna" }
  const h = ui(["lead", "new", "openai/nova", "medium", "100000", "apply"], { current }, "existing")
  await h.run()
  expect(h.configured).toEqual([{ sessionID: "existing", lead: "openai/nova#medium@100k" }])
  const cancel = ui(["lead", "new", "openai/nova", "medium", undefined], { current }, "existing")
  await cancel.run()
  expect(cancel.configured).toEqual([])
})

test("a context that exceeds refreshed capacity cannot apply until the user replaces it", async () => {
  const current = { lead: "openai/sol#high@200k", sidekick: "openai/luna" }
  const catalog = models.map(model => ({ ...model, limit: { context: 128000, output: 32000 } }))
  const h = ui(["apply", "lead", "context", "default", "apply"], { current }, "existing", undefined, catalog)
  await h.run()
  expect(h.alerts.length).toBe(1)
  expect(h.configured).toEqual([{ sessionID: "existing", lead: "openai/sol#high" }])
  const budgetMenu = h.calls.find(call => call.options.some((option: any) => option.value === "100000"))
  expect(budgetMenu.options.some((option: any) => option.value === "200000")).toBe(false)
})

test("Astra's advertised capacity offers 1M and applies it without displaying the saved 1000k form", async () => {
  const astra = { ...models[0], id: "gpt-6-astra", name: "Astra", limit: { context: 1050000, output: 128000 } }
  const current = { lead: "openai/gpt-6-astra#high@1000k", sidekick: "openai/luna" }
  const h = ui(["lead", "context", "1000000", "apply"], { current }, "existing", undefined, [...models, astra])
  await h.run()
  const budgetMenu = h.calls.find(call => call.options.some((option: any) => option.value === "1000000"))
  expect(budgetMenu.options.find((option: any) => option.value === "1000000").title).toBe("1M")
  expect(h.configured).toEqual([{ sessionID: "existing", lead: "openai/gpt-6-astra#high@1M" }])
  const capped = ui(["lead", "context", undefined], { current }, "existing", undefined, [...models, { ...astra, limit: { ...astra.limit, context: 400000 } }])
  await capped.run()
  const cappedMenu = capped.calls.find(call => call.options.some((option: any) => option.value === "400000"))
  expect(cappedMenu.options.some((option: any) => option.value === "1000000")).toBe(false)
})

test("Choose new allows changing only the effort on the same searchable model", async () => {
  const h = ui(["lead", "new", "openai/sol", "low", "default", "apply"], { current: { lead: "openai/sol#high", sidekick: "openai/luna" } }, "ses_existing")
  await h.run()
  expect(h.calls[2].title).toContain("model")
  expect(h.calls[2].current).toBe("openai/sol")
  expect(h.calls[3].current).toBe("high")
  expect(h.configured).toEqual([{ sessionID: "ses_existing", lead: "openai/sol#low" }])
})

test("reviewer model and effort can equal the lead without changing the other roles", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna", advisor: "openai/nova#medium" }
  const h = ui(["reviewer", "new", "openai/sol", "high", "default", "apply"], { current }, "existing")
  await h.run()
  expect(h.calls[2].options.find((option: any) => option.value === "openai/sol").disabled).not.toBe(true)
  expect(h.configured).toEqual([{ sessionID: "existing", reviewer: "openai/sol#high" }])
  expect(h.state.current).toMatchObject(current)
  expect(h.state.current.reviewer).toBe("openai/sol#high")
  expect(h.created).toEqual([])
  expect(h.alerts).toEqual([])

  const effort = ui(["reviewer", "new", "openai/sol", "low", "default", "apply"], { current: h.state.current }, "existing")
  await effort.run()
  expect(effort.calls[2].current).toBe("openai/sol")
  expect(effort.calls[3].current).toBe("high")
  expect(effort.configured).toEqual([{ sessionID: "existing", reviewer: "openai/sol#low" }])
  expect(effort.state.current).toMatchObject(current)
})

test("reviewer disable preserves the required pair and advisor, and cancellation preserves its selection", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna", advisor: "openai/nova#medium", reviewer: "openai/sol#low" }
  const cancel = ui(["reviewer", "off", undefined], { current }, "existing")
  await cancel.run()
  expect(cancel.state.current).toBe(current)
  expect(cancel.configured).toEqual([])
  expect(cancel.navigated).toEqual([])
  const h = ui(["reviewer", "off", "apply"], { current }, "existing")
  await h.run()
  expect(h.configured).toEqual([{ sessionID: "existing", reviewer: null }])
  expect(h.state.current).toMatchObject({ lead: current.lead, sidekick: current.sidekick, advisor: current.advisor })
  expect(h.state.current.reviewer).toBeUndefined()
  expect(h.created).toEqual([])
})

test("a kept Default effort is preselected when choosing the same model", async () => {
  const h = ui(["lead", "new", "openai/sol", "default", "default", "apply"], { current: { lead: "openai/sol#default", sidekick: "openai/luna" } }, "ses_existing")
  await h.run()
  expect(h.calls[3].current).toBe("default")
  expect(h.configured).toEqual([{ sessionID: "ses_existing", lead: "openai/sol#default" }])
})

test("escape cancels a draft or picker without creating, configuring, or navigating", async () => {
  for (const answers of [[undefined], ["advisor", undefined], ["advisor", "new", undefined], ["advisor", "new", "openai/nova", undefined], ["advisor", "new", "openai/nova", "medium", undefined], ["lead", "openai/sol#low", undefined], ["reviewer", undefined], ["reviewer", "new", undefined], ["reviewer", "new", "openai/sol", undefined], ["reviewer", "new", "openai/sol", "high", undefined], ["reviewer", "off", undefined]]) {
    const recent = { lead: ["openai/sol#low"] }
    const h = ui(answers, { current: { lead: "openai/sol#high", sidekick: "openai/luna" }, recent })
    await h.run()
    expect(h.created).toEqual([])
    expect(h.configured).toEqual([])
    expect(h.navigated).toEqual([])
    expect(h.state.recent).toBe(recent)
  }
})

test("new setup shows required missing roles and cannot apply until both are explicitly selected", async () => {
  const h = ui(["apply", "lead", "new", "openai/sol", "default", "default", "apply", "sidekick", "new", "openai/luna", "default", "apply"])
  await h.run()
  expect(h.calls[0].options.map((item: any) => item.title).join(" ")).toContain("Lead not configured")
  expect(h.alerts.map((item: any) => item.message).join(" ")).toContain("lead and sidekick")
  expect(h.created).toEqual([{ agent: "fusion", location: { directory: "/tmp/opencode" } }])
  expect(h.configured).toEqual([{ sessionID: "ses_new", lead: "openai/sol#default", sidekick: "openai/luna" }])
})

test("last setup is offered but not applied until explicitly chosen and applied; current session overrides it", async () => {
  const last = { lead: "openai/sol#default", sidekick: "openai/luna" }
  const cancel = ui(["last", undefined], { last })
  await cancel.run()
  expect(cancel.configured).toEqual([])
  expect(cancel.created).toEqual([])
  const apply = ui(["last", "apply"], { last })
  await apply.run()
  expect(apply.configured).toEqual([{ sessionID: "ses_new", ...last, advisor: null, reviewer: null }])
  const existing = ui([undefined], { last, current: { lead: "openai/nova#medium", sidekick: "openai/luna", advisor: "openai/sol#high" } }, "existing")
  await existing.run()
  expect(existing.calls[0].options.map((item: any) => item.title).join(" ")).toContain("Lead openai/nova · medium")
  expect(existing.configured).toEqual([])
  const replace = ui(["last", "apply"], { last, current: { lead: "openai/nova#medium", sidekick: "openai/luna", advisor: "openai/sol#high" } }, "existing")
  await replace.run()
  expect(replace.configured).toEqual([{ sessionID: "existing", ...last, advisor: null, reviewer: null }])
})

test("legacy last setup with an unavailable utility can Apply through the server without reviving that role", async () => {
  const legacy = {
    lead: { providerID: "openai", id: "sol", variant: "high" },
    sidekick: { providerID: "openai", id: "luna" },
    utility: { providerID: "gone", id: "obsolete" },
  }
  const store = new Map<string, unknown>([["last-setup", legacy]])
  const sessions: Record<string, any> = { ses_new: { id: "ses_new", agent: "fusion" } }
  const rpc: any = {}
  await fusion.setup({
    storage: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) }, scan: async () => ({ entries: [] }) },
    model: { list: async () => ({ data: models }), transform: async () => {}, reload: async () => {} },
    session: {
      get: async ({ sessionID }: any) => sessions[sessionID],
      switchModel: async ({ sessionID, model }: any) => { sessions[sessionID].model = model },
      switchAgent: async ({ sessionID, agent }: any) => { sessions[sessionID].agent = agent },
      hook: async () => {},
    },
    command: { transform: async (fn: any) => fn({ add: () => {} }) },
    tool: { transform: async (fn: any) => fn({ namespace: () => {}, add: () => {} }), hook: async () => {} },
    rpc: { register: async (_definition: any, handlers: any) => { Object.assign(rpc, handlers) } },
  } as any)
  const rpcContext = { error: (_name: string, message: string) => { throw new Error(message) } }
  const initial = await rpc.inspect({}, rpcContext)
  expect(store.get("last-setup")).toBe(legacy)
  expect(initial.last).not.toHaveProperty("utility")
  const h = ui(["last", "apply"], initial, undefined, undefined, models, {
    validate: (input) => rpc.validate(input, rpcContext),
    configure: (input) => rpc.configure(input, rpcContext),
  })
  await h.run()
  expect(h.alerts).toEqual([])
  expect(h.created).toEqual([{ agent: "fusion", location: { directory: "/tmp/opencode" } }])
  expect(h.validated[0]).not.toHaveProperty("utility")
  expect(h.configured[0]).not.toHaveProperty("utility")
  expect(store.get("pair/ses_new")).toMatchObject({ lead: legacy.lead, sidekick: legacy.sidekick })
  expect(store.get("pair/ses_new")).not.toHaveProperty("utility")
  expect(sessions.ses_new.model).toEqual(legacy.lead)
  expect(h.navigated).toEqual([{ type: "session", sessionID: "ses_new" }])
})

test("optional advisor can be cleared without changing the required pair", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna", advisor: "openai/sol#low", reviewer: "openai/sol#high" }
  const h = ui(["advisor", "off", "apply"], { current }, "existing")
  await h.run()
  expect(h.configured).toEqual([{ sessionID: "existing", advisor: null }])
  expect(h.state.current).not.toHaveProperty("advisor")
  expect(h.state.current).toMatchObject({ lead: current.lead, sidekick: current.sidekick })
  expect(h.state.current.reviewer).toBe(current.reviewer)
})

test("stale selections appear in the overview and cannot be applied as a last setup", async () => {
  const h = ui(["last", "apply", undefined], { last: { lead: "openai/missing#high", sidekick: "openai/luna" } })
  await h.run()
  expect(h.calls[0].options.map((item: any) => item.title).join(" ")).toContain("openai/missing · high · Default context (unavailable)")
  expect(h.alerts.map((item: any) => item.message).join(" ")).toContain("unavailable")
  expect(h.created).toEqual([])
  expect(h.configured).toEqual([])
})

test("a removed thinking effort stays visible but cannot be applied", async () => {
  const h = ui(["last", "apply", undefined], { last: { lead: "openai/sol#removed", sidekick: "openai/luna" } })
  await h.run()
  expect(h.calls[0].options.map((item: any) => item.title).join(" ")).toContain("Lead openai/sol · removed · Default context (unavailable)")
  expect(h.alerts.map((item: any) => item.message).join(" ")).toContain("Lead openai/sol · removed · Default context (unavailable)")
  expect(h.created).toEqual([])
  expect(h.configured).toEqual([])
})

test("text-only models cannot be lead but remain available to the advisor", async () => {
  const catalog = [...models, { name: "Reader", providerID: "openai", id: "reader", capabilities: { tools: false, output: ["text"] }, variants: [], limit: { context: 400000, output: 32000 } }]
  const rejected = ui(["last", "apply", undefined], { last: { lead: "openai/reader", sidekick: "openai/luna" } }, undefined, undefined, catalog)
  await rejected.run()
  expect(rejected.alerts.map((item: any) => item.message).join(" ")).toContain("Lead openai/reader · Default · Default context (unavailable)")
  expect(rejected.created).toEqual([])
  expect(rejected.configured).toEqual([])

  const accepted = ui(["advisor", "new", "openai/reader", "default", "apply"], { current: { lead: "openai/sol#high", sidekick: "openai/luna" } }, "existing", undefined, catalog)
  await accepted.run()
  expect(accepted.configured).toEqual([{ sessionID: "existing", advisor: "openai/reader" }])
  expect(accepted.alerts).toEqual([])
})

test("server preflight rejection of a new draft creates no session or persisted choice", async () => {
  const h = ui(["lead", "new", "openai/sol", "high", "default", "sidekick", "new", "openai/luna", "default", "apply"], {}, undefined, "server model unavailable")
  await h.run()
  expect(h.validated).toEqual([{ lead: "openai/sol#high", sidekick: "openai/luna" }])
  expect(h.created).toEqual([])
  expect(h.configured).toEqual([])
  expect(h.navigated).toEqual([])
})

test("every actor offers its recent model+effort choices; selecting one skips model and effort screens", async () => {
  const current = { lead: "openai/sol#high", sidekick: "openai/luna", advisor: "openai/sol#low" }
  const recent = {
    lead: ["openai/sol#default", "openai/sol#low"], sidekick: ["openai/sol#low"],
    advisor: ["openai/nova#default"], reviewer: ["openai/sol#high"],
  }
  for (const [role, chosen] of Object.entries({ lead: recent.lead[0], sidekick: recent.sidekick[0], advisor: recent.advisor[0], reviewer: recent.reviewer[0] })) {
    const h = ui([role, chosen, "apply"], { current, recent }, "existing")
    await h.run()
    const options = h.calls[1].options
    expect(options[0].title).toContain(chosen.endsWith("#default") ? "Default" : chosen.split("#").at(-1))
    expect(options.map((option: any) => option.value)).toContain("new")
    expect(options.some((option: any) => option.value === "effort" || option.value === "model")).toBe(false)
    expect(h.calls).toHaveLength(3)
    expect(h.configured).toEqual([{ sessionID: "existing", [role]: chosen }])
  }
})

test("recent menu shows at most three, disables unavailable choices and leaves optional off controls", async () => {
  const catalog = [...models, { name: "Reader", providerID: "openai", id: "reader", capabilities: { tools: false, output: ["text"] }, variants: [] }]
  const recent = { lead: ["openai/missing#high", "openai/sol#removed", "openai/reader", "openai/sol#low"], advisor: ["openai/reader"], reviewer: ["openai/missing#high", "openai/reader", "openai/sol#high"] }
  const current = { lead: "openai/sol#high", sidekick: "openai/luna" }
  const h = ui(["lead", undefined], { current, recent }, "existing", undefined, catalog)
  await h.run()
  expect(h.calls[1].options.slice(0, 3).map((option: any) => option.disabled)).toEqual([true, true, true])
  expect(h.calls[1].options.map((option: any) => option.value)).toEqual([...recent.lead.slice(0, 3), "new", "context"])
  expect(h.configured).toEqual([])
  expect(h.navigated).toEqual([])

  const advisor = ui(["advisor", "openai/reader", "apply"], { current, recent }, "existing", undefined, catalog)
  await advisor.run()
  expect(advisor.calls[1].options[0].disabled).toBe(false)
  expect(advisor.calls[1].options.map((option: any) => option.value)).toContain("off")
  expect(advisor.configured).toEqual([{ sessionID: "existing", advisor: "openai/reader" }])
  const reviewer = ui(["reviewer", "openai/sol#high", "apply"], { current, recent }, "existing", undefined, catalog)
  await reviewer.run()
  expect(reviewer.calls[1].options.slice(0, 3).map((option: any) => option.disabled)).toEqual([true, true, false])
  expect(reviewer.calls[1].options.map((option: any) => option.value)).toContain("off")
  expect(reviewer.configured).toEqual([{ sessionID: "existing", reviewer: "openai/sol#high" }])
  const sidekick = ui(["sidekick", undefined], { current }, "existing")
  await sidekick.run()
  expect(sidekick.calls[1].options.map((option: any) => option.value)).toEqual(["new", "context"])
})
