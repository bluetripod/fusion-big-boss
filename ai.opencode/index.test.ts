import { describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import fusion, { parseModel, parseModelsCommand } from "./index"
import { loadBriefing } from "../shared/briefing.mjs"

function harness() {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const hooks = new Map<string, any>()
  const toolHooks = new Map<string, any>()
  const store = new Map<string, unknown>()
  const switched: Array<{ sessionID: string; model: any }> = []
  const waited: string[] = []
  const prompts: any[] = []
  const transcripts = new Map<string, any[]>()
  const running = new Set<string>()
  const inbox = new Map<string, string[]>()
  const deliveries: any[] = []
  const events: Array<{ value: any; done: () => void }> = []
  let wake = () => {}
  const emit = (value: any) => new Promise<void>(done => { events.push({ value, done }); wake() })
  const rpc: { configure?: any; inspect?: any; validate?: any } = {}
  const models = [
    { providerID: "openai", id: "gpt-6-sol", variants: [{ id: "high" }, { id: "xhigh" }], capabilities: { tools: true, output: ["text"] } },
    { providerID: "openai", id: "gpt-5.6-luna", variants: [], capabilities: { tools: true, output: ["text"] } },
    { providerID: "github-copilot", id: "claude-opus-5.5", variants: [], capabilities: { tools: true, output: ["text"] } },
  ]
  for (const model of models) Object.assign(model, { modelID: model.id, limit: { context: 400000, output: 32000 } })
  const modelTransforms: any[] = []
  const catalog = () => {
    const entries = new Map(models.map(model => [model.providerID + '/' + model.id, structuredClone(model)]))
    const editor = { list: () => [...entries.values()], get: (p: string, id: string) => entries.get(p + '/' + id),
      update: (p: string, id: string, fn: any) => { const value = entries.get(p + '/' + id) ?? { providerID: p, id }; fn(value); entries.set(p + '/' + id, value as any) } }
    for (const transform of modelTransforms) transform(editor)
    return [...entries.values()]
  }
  const sessions: Record<string, any> = {
    parent: { id: "parent", agent: "fusion", model: { providerID: "openai", id: "gpt-6-sol" } },
    fresh: { id: "fresh", agent: "build" },
    child: { id: "child", agent: "fusion-sidekick", parentID: "parent", model: { providerID: "openai", id: "gpt-6-sol" } },
    duplicate: { id: "duplicate", agent: "fusion-sidekick", parentID: "parent", model: { providerID: "openai", id: "gpt-6-sol" } },
    orphan: { id: "orphan", agent: "fusion-sidekick", parentID: "unconfigured", model: { providerID: "openai", id: "gpt-6-sol" } },
    utilityRoot: { id: "utilityRoot", agent: "fusion-utility", parentID: "parent", model: { providerID: "openai", id: "gpt-6-sol" } },
    utilityNested: { id: "utilityNested", agent: "fusion-utility", parentID: "child", model: { providerID: "openai", id: "gpt-6-sol" } },
    unrelated: { id: "unrelated", agent: "build" },
    unrelatedChild: { id: "unrelatedChild", agent: "general", parentID: "unrelated" },
    unknownFusionChild: { id: "unknownFusionChild", agent: "explore", parentID: "parent" },
    otherSidekick: { id: "otherSidekick", agent: "fusion-sidekick", parentID: "unrelated" },
    advisor: { id: "advisor", agent: "fusion-advisor", parentID: "parent", model: { providerID: "openai", id: "gpt-6-sol" } },
    otherAdvisor: { id: "otherAdvisor", agent: "fusion-advisor", parentID: "unrelated", model: { providerID: "openai", id: "gpt-6-sol" } },
    nestedAdvisor: { id: "nestedAdvisor", agent: "fusion-advisor", parentID: "child", model: { providerID: "openai", id: "gpt-6-sol" } },
    otherRoot: { id: "otherRoot", agent: "fusion" },
    foreignAdvisor: { id: "foreignAdvisor", agent: "fusion-advisor", parentID: "otherRoot" },
    reviewer: { id: "reviewer", agent: "fusion-reviewer", parentID: "parent", model: { providerID: "openai", id: "gpt-6-sol" } },
  }
  const ctx = {
    event: { subscribe: async function* ({ signal }: any) {
      signal.addEventListener("abort", () => wake(), { once: true })
      while (!signal.aborted) {
        if (!events.length) await new Promise<void>(resolve => { wake = resolve })
        const next = events.shift()
        if (next) { yield next.value; next.done() }
      }
    } },
    agent: { list: async () => ({ data: [
      { id: "fusion", mode: "primary", hidden: false },
      { id: "build", mode: "primary", hidden: false },
      { id: "plan", mode: "primary", hidden: false },
      { id: "fusion-sidekick", mode: "subagent", hidden: false },
    ] }) },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => { store.set(key, value) },
      remove: async (key: string) => { store.delete(key) },
      scan: async ({ prefix }: any) => ({ entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    },
    model: { list: async () => ({ data: catalog() }), transform: async (fn: any) => { modelTransforms.push(fn) }, reload: async () => {} },
    command: { transform: async (fn: any) => fn({ add: (command: any) => commands.set(command.name, command) }) },
    tool: {
      transform: async (fn: any) => fn({ namespace: () => {}, add: (tool: any) => tools.set(tool.name, tool) }),
      hook: async (name: string, fn: any) => { toolHooks.set(name, fn) },
    },
    session: {
      get: async ({ sessionID }: any) => sessions[sessionID],
      switchModel: async ({ sessionID, model }: any) => { switched.push({ sessionID, model }); sessions[sessionID].model = model },
      switchAgent: async ({ sessionID, agent }: any) => { sessions[sessionID].agent = agent; if (agent !== "fusion") sessions[sessionID].model = { providerID: "openai", id: "gpt-5.6-luna" } },
      prompt: async (input: any) => { prompts.push(input) },
      context: async ({ sessionID }: any) => transcripts.get(sessionID) ?? [],
      synthetic: async (input: any) => {
        const { sessionID, text, resume } = input
        deliveries.push(input)
        inbox.set(sessionID, [...inbox.get(sessionID) ?? [], text])
        if (resume !== false) running.add(sessionID)
        return { id: "message-1" }
      },
      interrupt: async ({ sessionID }: any) => ({ interrupted: running.delete(sessionID) }),
      wait: async ({ sessionID }: any) => { waited.push(sessionID) },
      hook: async (name: string, fn: any) => { hooks.set(name, fn) },
    },
    rpc: { register: async (_definition: any, handlers: any) => { Object.assign(rpc, handlers) } },
  }
  const rpcError = (_name: string, message: string) => { throw new Error(message) }
  const configure = (sessionID: string, lead: string, sidekick: string, advisor?: string | null) =>
    rpc.configure({ sessionID, lead, sidekick, ...(advisor === undefined ? {} : { advisor }) }, { error: rpcError })
  const inspect = (sessionID?: string) => rpc.inspect({ ...(sessionID ? { sessionID } : {}) }, { error: rpcError })
  const patch = (sessionID: string, changes: Record<string, string | null>) => rpc.configure({ sessionID, ...changes }, { error: rpcError })
  const validate = (changes: Record<string, string | null>) => rpc.validate(changes, { error: rpcError })
  const disable = (sessionID: string, agent?: string) => rpc.disable({ sessionID, ...(agent ? { agent } : {}) }, { error: rpcError })
  const review = (input: any = {}, sessionID = "parent") =>
    toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID,
      input: { agent: "fusion-reviewer", background: true, prompt: "Frozen source packet", ...input } })
  return { ctx, tools, commands, hooks, toolHooks, store, switched, waited, prompts, models, sessions, configure, inspect, patch, validate, disable, review,
    transcripts, running, inbox, deliveries, emit }
}

function pause() {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const completed = new Promise<void>((resolve) => { release = resolve })
  return { waiting, release, hold: async () => { entered(); await completed } }
}

async function supervisionHarness() {
  const h = harness()
  const timers = new Set<unknown>()
  let tick: (() => unknown) | undefined
  const schedule = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => unknown) => {
    tick = callback
    const timer = { unref() {} }
    timers.add(timer)
    return timer
  }) as any)
  const unschedule = spyOn(globalThis, "clearInterval").mockImplementation(((timer: unknown) => { timers.delete(timer) }) as any)
  try {
    const cleanup = await fusion.setup(h.ctx as any)
    return { ...h, timers,
      tick: async () => { expect(tick).toBeDefined(); await tick!() },
      status: (sessionID: string, type: string) => h.emit({ type: "session.status", created: Date.now(), data: { sessionID, status: { type } } }),
      context: async (sessionID = "parent") => {
        const event = { sessionID, agent: h.sessions[sessionID].agent, model: h.sessions[sessionID].model, system: [] as any[], tools: {} }
        await h.hooks.get("context")(event)
        return event.system
      },
      cleanup: async () => {
        try { await cleanup?.() }
        finally { schedule.mockRestore(); unschedule.mockRestore() }
      },
    }
  } catch (error) {
    schedule.mockRestore(); unschedule.mockRestore()
    throw error
  }
}

describe("Fusion automatic supervision", () => {
  test("groups idle-owner delivery and replaces active-owner context without queueing", async () => {
    const h = await supervisionHarness()
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      for (const sessionID of ["child", "duplicate"]) {
        await h.hooks.get("prompt")({ sessionID })
        await h.status(sessionID, "busy")
      }
      await h.status("parent", "idle")
      await h.tick()
      expect(h.deliveries).toHaveLength(1)
      expect(h.deliveries[0]).toMatchObject({ sessionID: "parent", delivery: "queue", resume: true })
      expect(h.inbox.get("parent")![0]).toContain("child")
      expect(h.inbox.get("parent")![0]).toContain("duplicate")

      await h.status("parent", "busy")
      h.transcripts.set("child", [{ type: "assistant", content: [{ type: "tool", name: "old-command", state: { status: "running" } }] }])
      await h.tick()
      h.transcripts.set("child", [{ type: "assistant", content: [{ type: "tool", name: "latest-command", state: { status: "running" } }] }])
      await h.tick()
      expect(h.inbox.get("parent")).toHaveLength(1)
      const baseline = await h.context()
      const next = await h.context()
      expect(baseline.length).toBe(next.length + 1)
      expect(baseline[0].text).toContain("latest-command")
      expect(baseline[0].text).not.toContain("old-command")
    } finally { await h.cleanup() }
  })

  test("requests quiet busy workers once per activity interval, never retry or unknown workers", async () => {
    const h = await supervisionHarness()
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.hooks.get("prompt")({ sessionID: "child" })
      await h.status("parent", "busy")
      await h.tick(); await h.tick()
      expect(h.inbox.has("child")).toBe(false)
      await h.status("child", "retry")
      await h.tick(); await h.tick()
      expect(h.inbox.has("child")).toBe(false)
      await h.status("child", "busy")
      await h.emit({ type: "session.text.delta", data: { sessionID: "child" } })
      await h.tick()
      expect(h.inbox.has("child")).toBe(false)
      await h.tick()
      expect(h.deliveries).toHaveLength(1)
      expect(h.deliveries[0]).toMatchObject({ sessionID: "child", delivery: "steer", resume: false })
      expect(h.running.has("child")).toBe(false)
      await h.tick()
      expect(h.inbox.get("child")).toHaveLength(1)
      await h.emit({ type: "session.text.delta", data: { sessionID: "child" } })
      await h.tick()
      expect(h.inbox.get("child")).toHaveLength(1)
      await h.tick()
      expect(h.inbox.get("child")).toHaveLength(2)
    } finally { await h.cleanup() }
  })

  test("drops completed summaries, clears stale idle on resume and rejects changed ownership", async () => {
    const h = await supervisionHarness()
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      const baseline = await h.context()
      for (const ending of ["session.execution.succeeded", "session.status"]) {
        await h.hooks.get("prompt")({ sessionID: "child" })
        await h.status("child", "busy")
        await h.tick()
        if (ending === "session.status") { await h.status("child", "idle"); await h.tick() }
        else await h.emit({ type: ending, data: { sessionID: "child" } })
        expect((await h.context()).length).toBe(baseline.length)
        await h.tick()
        expect(h.deliveries).toHaveLength(0)
        expect(h.timers.size).toBe(0)
      }
      await h.status("child", "idle")
      await h.hooks.get("prompt")({ sessionID: "child" })
      await h.tick(); await h.tick()
      expect(h.timers.size).toBe(1)
      expect(h.deliveries).toHaveLength(0)
      await h.status("child", "busy")
      await h.tick(); await h.tick()
      expect(h.deliveries[0]).toMatchObject({ sessionID: "child", resume: false })

      h.deliveries.length = 0
      h.sessions.child.parentID = "unrelated"
      await h.status("parent", "idle")
      await h.status("otherSidekick", "busy")
      await h.status("foreignAdvisor", "busy")
      await h.tick(); await h.tick()
      expect(h.deliveries).toHaveLength(0)
      expect(h.timers.size).toBe(0)
    } finally { await h.cleanup() }
  })

  test("routes advisor and reviewer evidence to their own owner, separately from lead summaries", async () => {
    const h = await supervisionHarness()
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
      await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      for (const sessionID of ["advisor", "reviewer"]) {
        await h.hooks.get("prompt")({ sessionID })
        h.sessions[`${sessionID}-evidence`] = { ...h.sessions.child, id: `${sessionID}-evidence`, parentID: sessionID }
        await h.hooks.get("prompt")({ sessionID: `${sessionID}-evidence` })
        await h.status(sessionID, "busy")
        await h.status(`${sessionID}-evidence`, "busy")
      }
      await h.status("parent", "idle")
      await h.tick()
      expect(h.deliveries).toHaveLength(1)
      expect(h.deliveries[0]).toMatchObject({ sessionID: "parent", resume: true })
      expect(h.deliveries[0].text).not.toContain("-evidence")
      for (const sessionID of ["advisor", "reviewer"]) {
        const summary = (await h.context(sessionID))[0].text
        expect(summary).toContain(`${sessionID}-evidence`)
        expect(summary).not.toContain(`${sessionID === "advisor" ? "reviewer" : "advisor"}-evidence`)
        expect(h.inbox.has(sessionID)).toBe(false)
      }
      for (const sessionID of ["advisor", "reviewer"]) await h.status(sessionID, "idle")
      await h.tick()
      for (const sessionID of ["advisor", "reviewer"]) {
        expect(h.deliveries.some(item => item.sessionID === sessionID && item.resume === true
          && item.text.includes(`${sessionID}-evidence`))).toBe(true)
      }
    } finally { await h.cleanup() }
  })

  test("cleanup clears the interval and prevents deferred samples delivering or restarting workers", async () => {
    const h = await supervisionHarness()
    const barrier = pause()
    let sampling: Promise<void> | undefined
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.hooks.get("prompt")({ sessionID: "child" })
      await h.status("child", "busy")
      await h.status("parent", "idle")
      h.ctx.session.context = async () => { await barrier.hold(); return [] }
      sampling = h.tick()
      await barrier.waiting
      await h.cleanup()
      expect(h.timers.size).toBe(0)
      barrier.release()
      await sampling
      await h.tick()
      expect(h.deliveries).toHaveLength(0)
      expect(h.running.size).toBe(0)
    } finally { barrier.release(); await sampling; await h.cleanup() }
  })
})

describe("Fusion sessions", () => {
  test("live controls report partial output, steer without restarting and cancel only the owned worker", async () => {
    const h = harness(); const cleanup = await fusion.setup(h.ctx as any)
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      for (const sessionID of ["child", "duplicate"]) await h.hooks.get("prompt")({ sessionID })
      const control = (action: string, message?: string) => h.tools.get("fusion_worker").execute(
        { action, sessionID: "child", ...(message ? { message } : {}) }, { sessionID: "parent", agent: "fusion" })
      // The worker remains blocked/running throughout status and messaging.
      h.running.add("child"); h.running.add("duplicate")
      h.transcripts.set("child", [{ type: "assistant", content: [
        { type: "reasoning", text: "private reasoning" }, { type: "text", text: "Updated parser; tests still running" },
        { type: "tool", name: "shell", state: { status: "running", metadata: { title: "npm test" } } },
      ] }])
      expect(h.tools.get("fusion_worker")).toBeDefined()
      await h.emit({ type: "session.status", created: 100, data: { sessionID: "child", status: { type: "busy" } } })
      const progress = JSON.parse((await control("status")).content)
      expect(progress.status).toBe("busy")
      expect(progress.recentOutput).toContain("Updated parser")
      expect(progress.recentOutput).toContain("shell: running")
      expect(progress.recentOutput).not.toContain("private reasoning")
      await control("message", "Wrap up now with findings and unfinished checks")
      expect(h.inbox.get("child")).toEqual(["Wrap up now with findings and unfinished checks"])
      expect(h.running.has("child")).toBe(true)
      expect(h.waited).toEqual([])
      await control("cancel")
      expect(h.running.has("child")).toBe(false)
      expect(h.running.has("duplicate")).toBe(true)
      expect(JSON.parse((await control("status")).content).recentOutput).toContain("Updated parser")
      await h.emit({ type: "session.status", created: 200, data: { sessionID: "child", status: { type: "idle" } } })
      await control("message", "Do not start a new task")
      expect(h.running.has("child")).toBe(false)
      expect(h.inbox.get("child")).toHaveLength(1)
    } finally { await cleanup?.() }
  })

  test("controls enforce direct ownership for all roles and cancel advisor evidence descendants", async () => {
    const h = harness(); const cleanup = await fusion.setup(h.ctx as any)
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
      h.sessions.evidence = { ...h.sessions.child, id: "evidence", parentID: "advisor" }
      for (const sessionID of ["child", "advisor", "evidence"]) await h.hooks.get("prompt")({ sessionID })
      const control = (caller: string, target: string, action = "cancel", extra = {}) => h.tools.get("fusion_worker").execute(
        { action, sessionID: target, ...extra }, { sessionID: caller, agent: h.sessions[caller].agent })
      expect(h.tools.get("fusion_worker")).toBeDefined()
      for (const [caller, target] of [["parent", "foreignAdvisor"], ["parent", "evidence"], ["advisor", "child"], ["child", "duplicate"], ["unrelated", "child"]]) {
        await expect(control(caller, target)).rejects.toThrow()
      }
      await expect(control("parent", "child", "message", { message: " " })).rejects.toThrow()
      await expect(control("parent", "child", "status", { model: "other/model" })).rejects.toThrow()
      await control("advisor", "evidence", "status")
      h.store.set("sidekick-owner/otherSidekick", "advisor")
      h.running.add("advisor"); h.running.add("evidence"); h.running.add("child")
      h.running.add("otherSidekick")
      const cancelled = JSON.parse((await control("parent", "advisor")).content)
      expect(h.running.has("advisor")).toBe(false)
      expect(h.running.has("evidence")).toBe(false)
      expect(h.running.has("child")).toBe(true)
      expect(h.running.has("otherSidekick")).toBe(true)
      expect(cancelled.unconfirmedDescendants).toEqual(["otherSidekick"])
    } finally { await cleanup?.() }
  })

  test("cancellation returns while interruption is pending and preserves a later stop failure", async () => {
    const h = harness(); const cleanup = await fusion.setup(h.ctx as any)
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.hooks.get("prompt")({ sessionID: "child" })
      const barrier = pause()
      h.ctx.session.interrupt = async () => { await barrier.hold(); throw new Error("provider refused interruption") }
      const control = (action: string) => h.tools.get("fusion_worker").execute({ action, sessionID: "child" }, { sessionID: "parent", agent: "fusion" })
      const cancel = control("cancel")
      await barrier.waiting
      expect(JSON.parse((await cancel).content).cancellation.state).toBe("requested")
      await expect(h.hooks.get("prompt")({ sessionID: "child" })).rejects.toThrow("cancellation")
      barrier.release()
      const progress = JSON.parse((await control("status")).content)
      expect(progress.cancellation.state).toBe("failed")
      expect(progress.cancellation.error).toContain("provider refused")
    } finally { await cleanup?.() }
  })

  test("unknown status is explicit and steering cannot restart an idle worker even across a race", async () => {
    const h = harness(); const cleanup = await fusion.setup(h.ctx as any)
    try {
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.hooks.get("prompt")({ sessionID: "child" })
      h.transcripts.set("child", [{ type: "assistant", content: [{ type: "text", text: "earlier ".repeat(4000) + "latest finding" }] }])
      const control = (action: string, message?: string) => h.tools.get("fusion_worker").execute({ action, sessionID: "child", ...(message ? { message } : {}) }, { sessionID: "parent", agent: "fusion" })
      const progress = JSON.parse((await control("status")).content)
      expect(progress.status).toBe("unknown")
      expect(progress.truncated).toBe(true)
      expect(progress.recentOutput.length).toBeLessThanOrEqual(16000)
      expect(progress.recentOutput).toEndWith("latest finding")
      await control("message", "/skill:not-a-command report progress")
      expect(h.running.has("child")).toBe(false)
      expect(h.inbox.get("child")).toEqual(["/skill:not-a-command report progress"])
      await h.emit({ type: "session.status", created: 100, data: { sessionID: "child", status: { type: "busy" } } })
      await h.emit({ type: "server.connected" })
      expect(JSON.parse((await control("status")).content).status).toBe("unknown")
    } finally { await cleanup?.() }
  })

  for (const caller of ["parent", "advisor"]) test(`${caller} can start independent sidekicks and resume each owned conversation`, async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    if (caller === "advisor") await h.hooks.get("prompt")({ sessionID: caller })
    for (const id of ["child", "duplicate"]) h.sessions[id].parentID = caller
    const delegate = (input: any) => h.toolHooks.get("execute.before")({ tool: "subagent", agent: h.sessions[caller].agent, sessionID: caller, input })
    await Promise.all(["child", "duplicate"].map(async sessionID => {
      await delegate({ agent: "fusion-sidekick", background: true, prompt: "independent check" })
      await h.hooks.get("prompt")({ sessionID })
    }))
    for (const sessionID of ["child", "duplicate"]) {
      expect(h.sessions[sessionID].model.id).toBe("gpt-5.6-luna")
      await delegate({ agent: "fusion-sidekick", background: true, sessionID })
    }
    const fresh: any = { agent: "fusion-sidekick", background: true }
    await delegate(fresh)
    expect(fresh.sessionID).toBeUndefined()
    await fusion.setup(h.ctx as any)
    for (const sessionID of ["child", "duplicate"]) await delegate({ ...fresh, sessionID })
    await expect(delegate({ ...fresh, sessionID: "otherSidekick" })).rejects.toThrow()
    const busy = pause()
    h.ctx.session.wait = busy.hold
    let admitted = false
    const continuation = delegate({ ...fresh, sessionID: "child" }).then(() => { admitted = true })
    await busy.waiting
    expect(admitted).toBe(false)
    busy.release(); await continuation
    await h.disable("parent", "build")
    for (const sessionID of ["child", "duplicate"]) {
      await h.toolHooks.get("execute.before")({ tool: "shell", agent: "fusion-sidekick", sessionID, input: {} })
      if (caller === "advisor") await expect(h.toolHooks.get("execute.before")({ tool: "edit", agent: "fusion-sidekick", sessionID, input: {} })).rejects.toThrow()
    }
  })

  test("legacy sidekick histories remain explicitly resumable alongside new workers", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    h.store.set("sidekick/parent", "child")
    const resume = (sessionID: string) => h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent",
      input: { agent: "fusion-sidekick", background: true, sessionID } })
    await resume("child")
    await h.hooks.get("prompt")({ sessionID: "duplicate" })
    await resume("duplicate")
    await h.disable("parent", "build")
    await h.hooks.get("context")({ agent: "fusion-sidekick", sessionID: "child", system: [], tools: {} })
  })

  test("per-role context budgets use native model limits without changing API identity or other sessions", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high@200k", "openai/gpt-5.6-luna@100k", "openai/gpt-6-sol#high@100k")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5@100k" })
    h.sessions.evidence = { id: "evidence", agent: "fusion-sidekick", parentID: "advisor", model: h.sessions.advisor.model }
    for (const sessionID of ["child", "advisor", "reviewer", "evidence"]) await h.hooks.get("prompt")({ sessionID })
    const catalog = (await h.ctx.model.list()).data
    for (const [sessionID, window] of [["parent", 200000], ["child", 100000], ["advisor", 100000], ["reviewer", 100000], ["evidence", 100000]] as const) {
      const selected = catalog.find(m => m.id === h.sessions[sessionID].model.id) as any
      expect(selected.limit.context).toBe(window)
      if (selected.limit.input !== undefined) expect(selected.limit.input).toBeLessThanOrEqual(window)
      expect(selected.modelID).toBe(["child", "evidence"].includes(sessionID) ? "gpt-5.6-luna" : sessionID === "reviewer" ? "claude-opus-5.5" : "gpt-6-sol")
    }
    expect((catalog.find(m => m.id === "gpt-6-sol") as any).limit.context).toBe(400000)
    expect((await h.inspect("parent")).current.lead).toBe("openai/gpt-6-sol#high@200k")
    expect((await h.inspect()).recent.sidekick).toEqual(["openai/gpt-5.6-luna@100k"])
    await h.review()
    await h.patch("parent", { lead: "openai/gpt-6-sol#high" })
    expect(h.sessions.parent.model.id).toBe("gpt-6-sol")
  })

  test("invalid contexts fail before switching; context alone does not make two models different", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    for (const sidekick of ["openai/gpt-5.6-luna@1000k", "openai/gpt-5.6-luna@99k"]) {
      await expect(h.configure("parent", "openai/gpt-6-sol#high", sidekick)).rejects.toThrow(/context/i)
    }
    await expect(h.configure("parent", "openai/gpt-6-sol#high@100k", "openai/gpt-6-sol#high@200k")).rejects.toThrow("different models")
    expect(h.switched).toEqual([])
  })

  test("million-token choices retain saved alias identities and display M units after reload", async () => {
    const h = harness()
    Object.assign(h.models[0], { name: "Astra", limit: { context: 1050000, input: 922000, output: 128000 } })
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high@1000k", "openai/gpt-5.6-luna")
    const selected = h.sessions.parent.model
    expect(parseModel("openai/gpt-6-sol#high@1M")).toEqual(selected)
    h.store.set("recent-models", { lead: ["openai/gpt-6-sol#high@1000k"], sidekick: [], advisor: [], reviewer: [] })
    const next = harness()
    Object.assign(next.models[0], h.models[0])
    for (const [key, value] of h.store) next.store.set(key, value)
    await fusion.setup(next.ctx as any)
    const inspected = await next.inspect("parent")
    expect(inspected.current.lead).toBe("openai/gpt-6-sol#high@1M")
    expect(inspected.recent.lead).toEqual(["openai/gpt-6-sol#high@1M"])
    await next.patch("parent", { lead: inspected.recent.lead[0] })
    expect(next.sessions.parent.model).toEqual(selected)
    const alias = (await next.ctx.model.list()).data.find(model => model.id === selected.id) as any
    expect(alias.name).toBe("Astra (Fusion 1M)")
    expect(alias.limit.context).toBe(1000000)
    expect(alias.limit.input).toBe(922000)
    expect(alias.limit.output).toBe(128000)
    expect(alias.modelID).toBe("gpt-6-sol")
    expect((next.store.get("recent-models") as any).lead).toEqual(["openai/gpt-6-sol#high@1M"])
    await expect(next.patch("parent", { lead: "openai/gpt-6-sol#unavailable@1000k" })).rejects.toThrow(/@1M/)
  })

  test("a conflicting catalog alias cannot silently replace the requested context or API model", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    h.models.push({ ...h.models[1], id: "gpt-5.6-luna:fusion-context-100k", modelID: "other-api-model", limit: { context: 400000, output: 32000 } } as any)
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna@100k")).rejects.toThrow(/context.*conflict/i)
    expect(h.switched).toEqual([])
  })

  test("persisted context aliases are rebuilt when the plugin reloads", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high@100k", "openai/gpt-5.6-luna@200k")
    const next = harness()
    for (const [key, value] of h.store) next.store.set(key, value)
    next.store.set("recent-models", { lead: ["openai/gpt-6-sol@200k"], sidekick: [], advisor: [], reviewer: [] })
    await fusion.setup(next.ctx as any)
    const model = (await next.ctx.model.list()).data.find(m => m.id === h.sessions.parent.model.id) as any
    expect(model.limit.context).toBe(100000)
    await next.patch("parent", {})
    expect(next.sessions.parent.model).toEqual(h.sessions.parent.model)
    const recent = (await next.inspect()).recent.lead[0]
    await next.patch("parent", { lead: recent })
    expect(next.sessions.parent.model.variant).toBeUndefined()
    expect(((await next.ctx.model.list()).data.find(m => m.id === next.sessions.parent.model.id) as any).limit.context).toBe(200000)
  })

  test("directReviewWithoutCommand starts the native reviewer on its user-selected model", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer", prompt: { text: "Frozen source packet" } })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
    expect((h.store.get("reviewer/reviewer") as any).root).toBe("parent")
  })

  test("reviewer invocation and admission reject external lead model or effort changes until setup is reapplied", async () => {
    for (const model of [
      { providerID: "openai", id: "gpt-5.6-luna" },
      { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" },
      undefined,
    ]) {
      const h = harness(); await fusion.setup(h.ctx as any)
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      h.sessions.parent.model = model
      await expect(h.review()).rejects.toThrow("lead model")
      await expect(h.hooks.get("prompt")({ sessionID: "reviewer", prompt: { text: "Frozen source packet" } })).rejects.toThrow("lead model")
      expect(h.store.has("reviewer/reviewer")).toBe(false)
      expect(h.sessions.reviewer.model.id).toBe("gpt-6-sol")
      await h.patch("parent", { lead: "openai/gpt-6-sol#high" })
      await h.review()
      await h.hooks.get("prompt")({ sessionID: "reviewer", prompt: { text: "Frozen source packet" } })
      expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
      expect((h.store.get("reviewer/reviewer") as any).root).toBe("parent")
    }
  })

  test("native reviewer prompts pass through unchanged and the lead can choose same-change or fresh conversations", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    const text = "### Frozen snapshot A\n  exact source\n\n### Missing caller evidence\n    nested text"
    const call = { agent: "fusion-reviewer", background: true, prompt: text }
    const before = (input: any) => h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent", input })
    await before(call)
    expect(call.prompt).toBe(text)
    const admission = { sessionID: "reviewer", prompt: { text } }
    await h.hooks.get("prompt")(admission)
    expect(admission.prompt.text).toBe(text)
    await before({ ...call, sessionID: "reviewer", prompt: "Missing caller evidence for the same review" })
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.waited).toEqual(["reviewer"])
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
    await before(call)
    h.sessions.freshReview = { id: "freshReview", agent: "fusion-reviewer", parentID: "parent", model: h.sessions.parent.model }
    await h.hooks.get("prompt")({ sessionID: "freshReview" })
    expect(h.sessions.freshReview.model.id).toBe("claude-opus-5.5")
    expect((h.store.get("reviewer/freshReview") as any).root).toBe("parent")
  })

  test("reviewer selection is optional, user-validated, and may equal the lead model and effort", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    await expect(h.review()).rejects.toThrow("unconfigured")
    for (const reviewer of ["openai/absent", "openai/gpt-6-sol", "openai/gpt-6-sol#max"]) {
      await expect(h.patch("parent", { reviewer })).rejects.toThrow()
    }
    h.models.push({ providerID: "openai", id: "text-only", variants: [], capabilities: { tools: false, output: ["text"] } })
    await expect(h.patch("parent", { reviewer: "openai/text-only" })).rejects.toThrow("must support tools")
    await h.patch("parent", { reviewer: "openai/gpt-6-sol#high" })
    await h.patch("parent", { advisor: null })
    expect((await h.inspect("parent")).current).toMatchObject({
      lead: "openai/gpt-6-sol#high", sidekick: "openai/gpt-5.6-luna", reviewer: "openai/gpt-6-sol#high",
    })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "high" })
    await h.patch("parent", { reviewer: null })
    await expect(h.review()).rejects.toThrow("unconfigured")
    expect((await h.inspect()).recent.reviewer).toEqual(["openai/gpt-6-sol#high"])
    expect((await h.inspect("parent")).current.sidekick).toBe("openai/gpt-5.6-luna")
  })

  test("old saved selections and recents remain usable without selecting a reviewer", async () => {
    const h = harness()
    const pair = { lead: { providerID: "openai", id: "gpt-6-sol", variant: "high" },
      sidekick: { providerID: "openai", id: "gpt-5.6-luna" }, advisor: { providerID: "github-copilot", id: "claude-opus-5.5" } }
    const recent = { lead: ["openai/gpt-6-sol#high"], sidekick: ["openai/gpt-5.6-luna"], advisor: ["github-copilot/claude-opus-5.5"] }
    h.store.set("pair/parent", pair)
    h.store.set("last-setup", pair)
    h.store.set("recent-models", recent)
    await fusion.setup(h.ctx as any)
    const saved = await h.inspect("parent")
    expect(saved.current).toMatchObject({ lead: recent.lead[0], sidekick: recent.sidekick[0], advisor: recent.advisor[0] })
    expect(saved.recent).toMatchObject({ ...recent, reviewer: [] })
    expect(h.store.get("recent-models")).toBe(recent)
    await h.patch("parent", {})
    await h.hooks.get("prompt")({ sessionID: "child" })
    expect(h.sessions.child.model.id).toBe("gpt-5.6-luna")
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent",
      input: { agent: "fusion-advisor", background: false, prompt: "Discuss the contract" } })
    await expect(h.review()).rejects.toThrow("unconfigured")
    expect((await h.inspect("parent")).recent).toMatchObject({ ...recent, reviewer: [] })
  })

  test("reviewer context exposes executable bounded reads and skills, and denies all other capabilities", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    const executed: string[] = []
    const denied = ["shell", "write", "edit", "patch", "grep", "glob", "search", "websearch", "webfetch", "agents", "todowrite", "mcp_unknown"]
    const native = Object.fromEntries(["read", "skill", ...denied].map((tool) => [tool, {
      execute: async (input: any) => {
        await h.toolHooks.get("execute.before")({ tool, agent: "fusion-reviewer", sessionID: "reviewer", input })
        executed.push(tool)
        if (tool === "read") return ["before", "changed branch", "caller"].slice(input.offset, input.offset + input.limit).join("\n")
        if (tool === "skill") {
          if (input.id !== "code-review-and-quality") throw new Error("Skill is not installed")
          return { loaded: input.id }
        }
        throw new Error("Forbidden native capability executed")
      },
    }]))
    const context = { agent: "fusion-reviewer", sessionID: "reviewer", system: [] as any[], tools: { ...native } }
    await h.hooks.get("context")(context)
    expect(await context.tools.read.execute({ path: "snapshot.ts", offset: 1, limit: 2 })).toBe("changed branch\ncaller")
    expect(await context.tools.skill.execute({ id: "code-review-and-quality" })).toEqual({ loaded: "code-review-and-quality" })
    await expect(context.tools.skill.execute({ id: "missing-review-skill" })).rejects.toThrow("not installed")
    for (const tool of denied) {
      expect(context.tools[tool]).toBeUndefined()
      await expect(native[tool].execute({ path: "snapshot.ts", offset: 0, limit: 1 })).rejects.toThrow("read-only")
      expect(executed).not.toContain(tool)
    }
    for (const input of [{}, { offset: 0 }, { limit: 1 }, { offset: -1, limit: 1 }, { offset: 0.5, limit: 1 },
      { offset: "0", limit: 1 }, { offset: 0, limit: 0 }, { offset: 0, limit: 351 }, { offset: 0, limit: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1, limit: 1 }]) {
      await expect(context.tools.read.execute({ path: "snapshot.ts", ...input })).rejects.toThrow("explicit offset and limit")
    }
    expect(await context.tools.read.execute({ path: "snapshot.ts", offset: 0, limit: 350 })).toBe("before\nchanged branch\ncaller")
  })

  for (const caller of ["reviewer", "advisor"]) test(`${caller} owns a reusable evidence-only sidekick without borrowing the lead's coding child`, async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.hooks.get("prompt")({ sessionID: "child" })
    if (caller === "reviewer") await h.review()
    await h.hooks.get("prompt")({ sessionID: caller })
    h.sessions.evidence = { id: "evidence", agent: "fusion-sidekick", parentID: caller, model: h.sessions[caller].model }
    const delegate = (input: any) => h.toolHooks.get("execute.before")({ tool: "subagent", agent: `fusion-${caller}`, sessionID: caller, input })
    await delegate({ agent: "fusion-sidekick", background: true, prompt: "Find parseModel in ai.opencode/index.ts; return location only" })
    await h.hooks.get("prompt")({ sessionID: "evidence" })
    expect(h.sessions.evidence.model.id).toBe("gpt-5.6-luna")
    const next = { agent: "fusion-sidekick", background: true, sessionID: "evidence", prompt: "Run git diff -- ai.opencode/index.ts" }
    await delegate(next)
    expect((next as any).sessionID).toBe("evidence")
    const independent: any = { agent: "fusion-sidekick", background: true, prompt: "Independent check" }
    await delegate(independent)
    expect(independent.sessionID).toBe(caller === "reviewer" ? "evidence" : undefined)
    await expect(delegate({ ...next, sessionID: "child" })).rejects.toThrow()
    await expect(delegate({ agent: "fusion-advisor", background: false, prompt: "analyze" })).rejects.toThrow()
    const call = (tool: string) => h.toolHooks.get("execute.before")({ tool, agent: "fusion-sidekick", sessionID: "evidence", input: {} })
    for (const tool of ["shell", "read", "grep", "glob"]) await call(tool)
    for (const tool of ["edit", "write", "patch", "subagent", "webfetch", "mcp_unknown"]) await expect(call(tool)).rejects.toThrow("evidence")
    await h.toolHooks.get("execute.before")({ tool: "edit", agent: "fusion-sidekick", sessionID: "child", input: {} })
    const context = { agent: "fusion-sidekick", sessionID: "evidence", system: [] as any[], tools: { shell: {}, read: {}, edit: {}, subagent: {} } as any }
    await h.hooks.get("context")(context)
    expect(context.tools.edit).toBeUndefined()
    expect(context.tools.subagent).toBeUndefined()
    expect(context.tools.shell).toBeDefined()
  })

  test("unconfirmed, foreign, nested, orphan and unknown reviewers cannot get context or run tools", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    h.sessions.foreignReviewer = { id: "foreignReviewer", agent: "fusion-reviewer", parentID: "otherRoot" }
    h.sessions.nestedReviewer = { id: "nestedReviewer", agent: "fusion-reviewer", parentID: "child" }
    h.sessions.orphanReviewer = { id: "orphanReviewer", agent: "fusion-reviewer", parentID: "missing" }
    h.sessions.misownedReviewer = { id: "misownedReviewer", agent: "fusion-reviewer", parentID: "parent" }
    h.store.set("reviewer/foreignReviewer", { root: "parent", request: "forged ownership" })
    h.store.set("reviewer/nestedReviewer", { root: "parent", request: "forged ownership" })
    h.store.set("reviewer/misownedReviewer", { root: "otherRoot" })
    for (const sessionID of ["reviewer", "foreignReviewer", "nestedReviewer", "orphanReviewer", "misownedReviewer", "unknownFusionChild", "missing"]) {
      await expect(h.hooks.get("context")({ agent: "fusion-reviewer", sessionID, system: [], tools: {} })).rejects.toThrow()
      for (const tool of ["read", "skill", "mcp_unknown"]) {
        await expect(h.toolHooks.get("execute.before")({ tool, agent: "fusion-reviewer", sessionID,
          input: { path: "snapshot.ts", offset: 0, limit: 1 } })).rejects.toThrow()
      }
    }
    for (const sessionID of ["foreignReviewer", "nestedReviewer", "orphanReviewer", "misownedReviewer"]) {
      await expect(h.hooks.get("prompt")({ sessionID })).rejects.toThrow()
    }
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("reviewer delegation validates native inputs and rejects model overrides and child delegation", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    for (const root of ["parent", "otherRoot"]) {
      await h.configure(root, "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.patch(root, { reviewer: "github-copilot/claude-opus-5.5" })
    }
    await expect(h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion-sidekick", sessionID: "child",
      input: { agent: "fusion-reviewer", background: true } })).rejects.toThrow("Fusion delegation")
    for (const input of [{ background: false }, { background: undefined }, { model: "openai/gpt-6-sol#high" },
      { model: null }, { reasoning_effort: "xhigh" }, { context_tier: "long" }, { contextWindow: 200000 }, { contextBudget: 200000 }, { sessionID: "" },
      { prompt: "" }, { prompt: "  " }, { prompt: null }]) {
      await expect(h.review(input)).rejects.toThrow()
    }
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
    await h.review({}, "otherRoot")
  })

  test("reviewer continuations require persisted direct-root ownership", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    h.sessions.unconfirmedReview = { id: "unconfirmedReview", agent: "fusion-reviewer", parentID: "parent" }
    h.sessions.foreignReview = { id: "foreignReview", agent: "fusion-reviewer", parentID: "otherRoot" }
    h.store.set("reviewer/foreignReview", { root: "otherRoot", request: "Foreign review" })
    h.sessions.nestedReview = { id: "nestedReview", agent: "fusion-reviewer", parentID: "child" }
    h.store.set("reviewer/nestedReview", { root: "parent", request: "Forged nested review" })
    for (const target of ["missing", "child", "unconfirmedReview", "foreignReview", "nestedReview"]) {
      await expect(h.review({ sessionID: target })).rejects.toThrow("confirmed direct review child")
    }
    await h.review({ sessionID: "reviewer" })
    expect(h.waited).toEqual(["reviewer"])
  })

  test("resuming waits for the prior turn, retains history and ID, and honors the current reviewer effort", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    const history = [{ text: "Finding from snapshot A" }]
    h.sessions.reviewer.messages = history
    await h.patch("parent", { reviewer: "openai/gpt-6-sol#xhigh" })
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const completed = new Promise<void>((resolve) => { release = resolve })
    h.ctx.session.wait = async ({ sessionID }: any) => { h.waited.push(sessionID); entered(); await completed }
    let ready = false
    const continuation = h.review({ sessionID: "reviewer" }).then(() => { ready = true })
    await waiting
    expect(ready).toBe(false)
    release()
    await continuation
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.waited).toEqual(["reviewer"])
    expect(h.sessions.reviewer.id).toBe("reviewer")
    expect(h.sessions.reviewer.messages).toBe(history)
    expect(h.sessions.reviewer.model).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "xhigh" })
    h.ctx.session.wait = async ({ sessionID }: any) => { h.waited.push(sessionID) }
    await h.review({ sessionID: "reviewer" })
  })

  test("model correction failure leaves the reviewer unconfirmed and a later native retry can succeed", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    const switchModel = h.ctx.session.switchModel
    h.ctx.session.switchModel = async () => { throw new Error("provider switch failed") }
    await h.review()
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("provider switch failed")
    expect(h.store.get("reviewer/reviewer")).toBeUndefined()
    expect(h.sessions.reviewer.model.id).toBe("gpt-6-sol")
    h.ctx.session.switchModel = switchModel
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("a reviewer model disappearing before invocation or admission never falls back", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    const [selected] = h.models.splice(h.models.findIndex((model) => model.id === "claude-opus-5.5"), 1)
    await expect(h.review()).rejects.toThrow("not available")
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("not available")
    expect(h.sessions.reviewer.model.id).toBe("gpt-6-sol")
    expect(h.store.get("reviewer/reviewer")).toBeUndefined()
    h.models.push(selected)
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("restart preserves owned reviewer history and accepts legacy records with an ignored request", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    const owner = { root: "parent", request: "Historical command request" }
    h.store.set("reviewer/reviewer", owner)
    const history = [{ text: "Prior review" }]
    h.sessions.reviewer.messages = history
    await fusion.setup(h.ctx as any)
    expect(h.store.get("reviewer/reviewer")).toBe(owner)
    expect(h.sessions.reviewer.messages).toBe(history)
    await h.toolHooks.get("execute.before")({ tool: "skill", agent: "fusion-reviewer", sessionID: "reviewer", input: { id: "code-review-and-quality" } })
    await h.review({ sessionID: "reviewer" })
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.messages).toBe(history)
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("setup and off retain owned read-only conversations while off prevents new reviewer turns", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    const owner = h.store.get("reviewer/reviewer")
    await h.patch("parent", {})
    await h.review({ sessionID: "reviewer" })
    await h.disable("parent", "build")
    await expect(h.review()).rejects.toThrow("delegation is off")
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("delegation is off")
    await h.hooks.get("context")({ sessionID: "reviewer", agent: "fusion-reviewer", system: [], tools: { read: {}, skill: {} } })
    await h.toolHooks.get("execute.before")({ tool: "read", agent: "fusion-reviewer", sessionID: "reviewer",
      input: { path: "snapshot.ts", offset: 0, limit: 1 } })
    expect(h.store.get("reviewer/reviewer")).toBe(owner)
    await h.patch("parent", {})
    await h.review({ sessionID: "reviewer" })
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("reviewer invocation rechecks its selected model and active root after a delayed availability lookup", async () => {
    for (const action of ["setup", "off"]) {
      const h = harness(); await fusion.setup(h.ctx as any)
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      const pending = pause(), list = h.ctx.model.list
      let blocked = false
      h.ctx.model.list = async () => {
        if (!blocked) { blocked = true; await pending.hold() }
        return list()
      }
      const invocation = h.review()
      await pending.waiting
      if (action === "setup") await h.patch("parent", { reviewer: "openai/gpt-6-sol#xhigh" })
      else await h.disable("parent", "build")
      pending.release()
      await expect(invocation).rejects.toThrow("setup changed or delegation is off")
      expect(h.store.get("reviewer/reviewer")).toBeUndefined()
    }
  })

  test("reviewer invocation and prompt wait until a pending setup model switch completes", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    const pending = pause(), switchModel = h.ctx.session.switchModel
    h.ctx.session.switchModel = async (input: any) => {
      if (input.sessionID === "parent") await pending.hold()
      await switchModel(input)
    }
    const setup = h.patch("parent", { lead: "openai/gpt-6-sol#xhigh" })
    await pending.waiting
    await expect(h.review()).rejects.toThrow("being applied")
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("being applied")
    await expect(h.disable("parent", "build")).rejects.toThrow("already being changed")
    pending.release()
    await setup
    expect(h.sessions.parent.model.variant).toBe("xhigh")
    await h.review()
    await h.hooks.get("prompt")({ sessionID: "reviewer" })
    expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
  })

  test("reviewer model correction verifies the current setup, active root, and actual switched model", async () => {
    for (const action of ["changed reviewer", "same reviewer", "off", "substituted model"]) {
      const h = harness(); await fusion.setup(h.ctx as any)
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      await h.review()
      const pending = pause(), switchModel = h.ctx.session.switchModel
      h.ctx.session.switchModel = async (input: any) => {
        if (input.sessionID === "reviewer") await pending.hold()
        await switchModel(action === "substituted model" ? { ...input, model: h.sessions.parent.model } : input)
      }
      const admission = h.hooks.get("prompt")({ sessionID: "reviewer" })
      await pending.waiting
      if (action === "changed reviewer") await h.patch("parent", { reviewer: "openai/gpt-6-sol#xhigh" })
      if (action === "same reviewer") await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      if (action === "off") await h.disable("parent", "build")
      pending.release()
      if (action === "same reviewer") {
        await admission
        expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
        expect((h.store.get("reviewer/reviewer") as any).root).toBe("parent")
      } else {
        await expect(admission).rejects.toThrow(action === "substituted model" ? "could not be confirmed" : "setup changed or delegation is off")
        expect(h.store.get("reviewer/reviewer")).toBeUndefined()
      }
    }
  })

  test("pending off serializes setup changes and prevents a new reviewer turn", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    const pending = pause(), list = h.ctx.agent.list
    h.ctx.agent.list = async () => { await pending.hold(); return list() }
    const off = h.disable("parent", "build")
    await pending.waiting
    await expect(h.patch("parent", {})).rejects.toThrow("already being applied")
    await expect(h.disable("parent", "build")).rejects.toThrow("already being changed")
    await expect(h.review()).rejects.toThrow("being applied")
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("being applied")
    pending.release()
    await off
    await expect(h.hooks.get("prompt")({ sessionID: "reviewer" })).rejects.toThrow("delegation is off")
    expect(h.store.get("reviewer/reviewer")).toBeUndefined()
  })

  test("a reviewer continuation rechecks model setup and root activity after waiting for the prior turn", async () => {
    for (const action of ["setup", "off"]) {
      const h = harness(); await fusion.setup(h.ctx as any)
      await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
      await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
      await h.review()
      await h.hooks.get("prompt")({ sessionID: "reviewer" })
      const pending = pause()
      h.ctx.session.wait = async () => { await pending.hold() }
      const continuation = h.review({ sessionID: "reviewer" })
      await pending.waiting
      if (action === "setup") await h.patch("parent", { reviewer: "openai/gpt-6-sol#xhigh" })
      else await h.disable("parent", "build")
      pending.release()
      await expect(continuation).rejects.toThrow("setup changed or delegation is off")
      expect(h.sessions.reviewer.model.id).toBe("claude-opus-5.5")
    }
  })

  test("sidekick runs independent Git and source retrieval jobs directly without another worker", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.hooks.get("prompt")({ sessionID: "child" })
    const before = h.toolHooks.get("execute.before")
    await Promise.all([
      before({ tool: "shell", agent: "fusion-sidekick", sessionID: "child", input: { command: "git status --short" } }),
      before({ tool: "websearch", agent: "fusion-sidekick", sessionID: "child", input: { query: "official source" } }),
      before({ tool: "webfetch", agent: "fusion-sidekick", sessionID: "child", input: { url: "https://example.com/docs" } }),
    ])
    await expect(before({ tool: "subagent", agent: "fusion-sidekick", sessionID: "child",
      input: { agent: "general", background: true } })).rejects.toThrow("Fusion delegation allows")
  })

  test("obsolete saved utility choices do not block remaining models or replace the persistent sidekick", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const legacy = {
      lead: { providerID: "openai", id: "gpt-6-sol", variant: "high" },
      sidekick: { providerID: "openai", id: "gpt-5.6-luna" },
      utility: { providerID: "gone", id: "obsolete" },
      advisor: { providerID: "github-copilot", id: "claude-opus-5.5" },
    }
    h.store.set("pair/parent", legacy)
    h.store.set("last-setup", legacy)
    h.store.set("sidekick/parent", "child")
    await h.patch("parent", {})
    const current = (await h.inspect("parent")).current
    expect(current.sidekick).toBe("openai/gpt-5.6-luna")
    expect(current.advisor).toBe("github-copilot/claude-opus-5.5")
    await h.hooks.get("prompt")({ sessionID: "child" })
    expect(h.sessions.child.model.id).toBe("gpt-5.6-luna")
    expect(h.store.get("sidekick/parent")).toBe("child")
  })

  test("turning Fusion off switches the same root to its prior primary agent without losing model, history, or child guards", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("fresh", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    h.sessions.fresh.messageCount = 12
    h.sessions.fresh.model = { providerID: "openai", id: "gpt-6-sol", variant: "high" }
    h.sessions.child.parentID = "fresh"
    h.sessions.utilityRoot.parentID = "fresh"
    h.sessions.advisor.parentID = "fresh"
    h.sessions.utilityRoot.messageCount = 4
    const oldUtilityModel = h.sessions.utilityRoot.model
    h.sessions.ordinaryChild = { id: "ordinaryChild", agent: "general", parentID: "fresh" }
    await h.hooks.get("prompt")({ sessionID: "child" })
    expect((await h.inspect("fresh")).active).toBe(true)
    await h.disable("fresh")
    expect(h.sessions.fresh.agent).toBe("build")
    expect(h.sessions.fresh.model).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "high" })
    expect(h.sessions.fresh.messageCount).toBe(12)
    expect((await h.inspect("fresh")).active).toBe(false)
    expect((await h.inspect("fresh")).current?.lead).toBe("openai/gpt-6-sol#high")
    expect(h.store.get("pair/fresh")).toBeDefined()
    expect(h.store.get("last-setup")).toBeDefined()
    await h.hooks.get("prompt")({ sessionID: "child" })
    await expect(h.hooks.get("prompt")({ sessionID: "utilityRoot" })).rejects.toThrow("removed")
    await expect(h.hooks.get("prompt")({ sessionID: "utilityNested" })).rejects.toThrow("removed")
    expect(h.sessions.child.model.id).toBe("gpt-5.6-luna")
    expect(h.sessions.utilityRoot.model).toBe(oldUtilityModel)
    expect(h.sessions.utilityRoot.messageCount).toBe(4)
    const root = { agent: "build", sessionID: "fresh", system: [] as any[], tools: { shell: {}, websearch: {} } as any }
    await h.hooks.get("context")(root)
    expect(root.system).toEqual([])
    expect(Object.keys(root.tools)).toEqual(["shell", "websearch"])
    const utility = { agent: "fusion-utility", sessionID: "utilityNested", system: [] as any[], tools: {} as any }
    await expect(h.hooks.get("context")(utility)).rejects.toThrow("removed")
    const advisor = { agent: "fusion-advisor", sessionID: "advisor", system: [] as any[], tools: { shell: {} } as any }
    await h.hooks.get("context")(advisor)
    expect(Object.keys(advisor.tools)).toEqual([])
    await expect(h.toolHooks.get("execute.before")({ tool: "shell", agent: "fusion-advisor", sessionID: "advisor", input: {} })).rejects.toThrow("read-only")
    await h.toolHooks.get("execute.before")({ tool: "shell", agent: "fusion-sidekick", sessionID: "child",
      input: { command: "git status" } })
    await expect(h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion-sidekick", sessionID: "child",
      input: { agent: "fusion-advisor", background: false, sessionID: "advisor" } })).rejects.toThrow("Fusion delegation allows")
    const ordinary = { agent: "general", prompt: "normal work" }
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "build", sessionID: "fresh", input: ordinary })
    await h.toolHooks.get("execute.before")({ tool: "shell", agent: "build", sessionID: "fresh", input: { command: "pwd" } })
    await h.toolHooks.get("execute.before")({ tool: "shell", agent: "general", sessionID: "ordinaryChild", input: { command: "pwd" } })
    await expect(h.toolHooks.get("execute.before")({ tool: "subagent", agent: "build", sessionID: "fresh",
      input: { agent: "fusion-sidekick", background: true, prompt: "start new protected work" } })).rejects.toThrow("Fusion delegation")
    h.sessions.duplicate.parentID = "fresh"
    await expect(h.hooks.get("prompt")({ sessionID: "duplicate" })).rejects.toThrow("protected Fusion child ownership")
    h.sessions.foreignNested = { id: "foreignNested", agent: "fusion-advisor", parentID: "ordinaryChild" }
    await expect(h.hooks.get("prompt")({ sessionID: "foreignNested" })).rejects.toThrow("protected Fusion child ownership")
    await expect(h.hooks.get("context")({ agent: "fusion-advisor", sessionID: "foreignNested", system: [], tools: {} })).rejects.toThrow("protected Fusion child ownership")
    await expect(h.toolHooks.get("execute.before")({ tool: "websearch", agent: "fusion-sidekick", sessionID: "duplicate", input: {} })).rejects.toThrow("protected Fusion child ownership")
    await h.configure("fresh", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    expect(h.sessions.fresh.agent).toBe("fusion")
    expect((await h.inspect("fresh")).active).toBe(true)
  })

  test("off needs an available ordinary primary agent, but not available saved models", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    expect((await h.inspect("parent")).previous).toBeUndefined()
    await expect(h.disable("parent")).rejects.toThrow("Choose an available non-Fusion primary agent")
    await expect(h.disable("parent", "fusion-sidekick")).rejects.toThrow("non-Fusion primary")
    h.models.splice(0)
    await h.disable("parent", "plan")
    expect(h.sessions.parent.agent).toBe("plan")
    expect(h.sessions.parent.model).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "high" })
    expect((await h.inspect("parent")).current?.lead).toBe("openai/gpt-6-sol#high")
    await expect(h.hooks.get("prompt")({ sessionID: "otherSidekick" })).rejects.toThrow("protected Fusion child ownership")
    const unowned = { id: "unowned", agent: "fusion-utility", parentID: "unrelated" }
    h.sessions.unowned = unowned
    await expect(h.hooks.get("prompt")({ sessionID: "unowned" })).rejects.toThrow("protected Fusion child ownership")
  })
  test("parses provider/model, optional thinking, and command arguments", () => {
    expect(parseModel("openai/gpt-6-sol#high")).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "high" })
    expect(parseModel("openrouter/anthropic/claude-sonnet-5")).toEqual({ providerID: "openrouter", id: "anthropic/claude-sonnet-5" })
    expect(parseModel("invalid")).toBeUndefined()
    expect(parseModelsCommand("  a/b#x  c/d  fix the bug ")).toEqual({ lead: "a/b#x", sidekick: "c/d", task: "fix the bug" })
    expect(parseModelsCommand("a/b")).toEqual({ lead: "a/b", sidekick: undefined, task: "" })
    for (const option of ["utility=a/b#high", "utility=not-a-model", "adhoc=c/d"]) {
      expect(() => parseModelsCommand(`a/b c/d ${option} change code`)).toThrow()
      expect(() => parseModelsCommand(`a/b c/d advisor=off ${option} change code`)).toThrow()
    }
    expect(parseModelsCommand("a/b c/d fix utility=preserve text").task).toBe("fix utility=preserve text")
    expect(parseModelsCommand("a/b c/d advisor=off do work")).toEqual({
      lead: "a/b", sidekick: "c/d", advisor: null, task: "do work",
    })
    expect(parseModelsCommand("a/b c/d advisor=a/b#high check").advisor).toBe("a/b#high")
    expect(parseModelsCommand("a/b c/d think advisor=off").task).toBe("think advisor=off")
  })

  test("reviewer model options preserve literal and multiline task text after the option prefix", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    const task = "  Check this branch.\n    reviewer=literal task data\n  advisor=also literal"
    for (const options of ["advisor=off reviewer=openai/gpt-6-sol#high", "reviewer=openai/gpt-6-sol#high advisor=off"]) {
      const text = `openai/gpt-6-sol#high openai/gpt-5.6-luna ${options}\n${task}`
      const parsed = parseModelsCommand(text)
      expect(parsed.task).toBe(task)
      expect(parsed.reviewer).toBe("openai/gpt-6-sol#high")
      expect(parsed.advisor).toBeNull()
      await h.commands.get("fusion-models").execute({ sessionID: "parent", prompt: { text }, delivery: "steer" })
      expect(h.prompts.at(-1).text.split("\n\n").slice(1).join("\n\n")).toBe(task)
    }
    expect((await h.inspect("parent")).current.reviewer).toBe("openai/gpt-6-sol#high")
    expect(parseModelsCommand("a/b c/d reviewer=off do work").reviewer).toBeNull()
    expect(parseModelsCommand("a/b c/d do work reviewer=off").task).toBe("do work reviewer=off")
    await h.commands.get("fusion-models").execute({ sessionID: "parent", delivery: "steer",
      prompt: { text: "openai/gpt-6-sol#high openai/gpt-5.6-luna reviewer=off" } })
    await expect(h.review()).rejects.toThrow("unconfigured")
    expect((await h.inspect("parent")).current.lead).toBe("openai/gpt-6-sol#high")
  })

  test("the model has no tool to choose or change models", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.hooks.get("prompt")({ sessionID: "child" })
    await expect(h.tools.get("fusion_worker").execute({ action: "message", sessionID: "child", message: "hello", model: "other/model" },
      { sessionID: "parent", agent: "fusion" })).rejects.toThrow()
    expect(h.sessions.child.model.id).toBe("gpt-5.6-luna")
  })

  test("user choice requires available models and an explicit thinking effort", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/unknown")).rejects.toThrow("sidekick model openai/unknown is not available")
    await expect(h.configure("parent", "openai/missing", "openai/gpt-5.6-luna")).rejects.toThrow("lead model openai/missing is not available")
    await expect(h.configure("parent", "openai/gpt-6-sol", "openai/gpt-5.6-luna")).rejects.toThrow("Choose the lead thinking effort")
    await expect(h.configure("parent", "openai/gpt-6-sol#max", "openai/gpt-5.6-luna")).rejects.toThrow("Thinking effort max is not available")
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-6-sol#high")).rejects.toThrow("different models")
    expect(h.switched).toHaveLength(0)
    expect(h.store.size).toBe(0)

    const chosen = await h.configure("parent", "openai/gpt-6-sol#default", "openai/gpt-5.6-luna")
    expect(chosen).toEqual({ lead: "openai/gpt-6-sol", sidekick: "openai/gpt-5.6-luna" })
    expect(h.store.get("pair/parent")).toEqual({
      lead: { providerID: "openai", id: "gpt-6-sol" },
      sidekick: { providerID: "openai", id: "gpt-5.6-luna" },
    })
  })

  test("read-only inspect reports current and last, while partial changes preserve omitted fields and adhoc", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    expect(await h.inspect("parent")).toEqual({ active: false, recent: { lead: [], sidekick: [], advisor: [], reviewer: [] } })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    ;(h.store.get("pair/parent") as any).adhoc = { providerID: "github-copilot", id: "claude-opus-5.5" }
    const first = await h.inspect("parent")
    expect(first.current).toEqual({ lead: "openai/gpt-6-sol#high", sidekick: "openai/gpt-5.6-luna", advisor: "github-copilot/claude-opus-5.5" })
    expect(first.last).toEqual(first.current)
    expect((await h.inspect()).last).toEqual(first.last)
    const before = h.store.get("pair/parent") as any
    const updated = await h.patch("parent", { advisor: "openai/gpt-6-sol#high" })
    expect(updated).toMatchObject({ lead: first.current.lead, sidekick: first.current.sidekick, advisor: "openai/gpt-6-sol#high" })
    expect((h.store.get("pair/parent") as any).lead).toBe(before.lead)
    expect((h.store.get("pair/parent") as any).sidekick).toBe(before.sidekick)
    expect((h.store.get("pair/parent") as any).adhoc).toBe(before.adhoc)
    expect((await h.inspect()).last).not.toHaveProperty("adhoc")
    expect(h.switched).toHaveLength(1)
    await h.patch("parent", { advisor: null })
    expect(await h.inspect("parent")).toMatchObject({ current: { lead: first.current.lead, sidekick: first.current.sidekick }, last: { lead: first.current.lead, sidekick: first.current.sidekick } })
  })

  test("effort-only edits, kept defaults, missing required roles, and stale restored choices fail before effects", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await expect(h.patch("fresh", { advisor: "openai/gpt-6-sol#high" })).rejects.toThrow("lead and sidekick")
    expect(h.sessions.fresh.agent).toBe("build")
    expect(h.store.size).toBe(0)
    await h.configure("parent", "openai/gpt-6-sol#default", "openai/gpt-5.6-luna")
    expect(await h.inspect("parent")).toMatchObject({ current: { lead: "openai/gpt-6-sol#default" } })
    await h.patch("parent", { lead: "openai/gpt-6-sol#high" })
    await h.patch("parent", { lead: "openai/gpt-6-sol#default" })
    const previous = h.store.get("pair/parent")
    const count = h.switched.length
    await expect(h.patch("parent", { sidekick: "openai/absent" })).rejects.toThrow("sidekick model openai/absent is not available")
    expect(h.store.get("pair/parent")).toBe(previous)
    expect(h.switched).toHaveLength(count)
    h.models.splice(h.models.findIndex((model) => model.id === "gpt-6-sol"), 1)
    await expect(h.patch("fresh", { lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna" })).rejects.toThrow("lead model openai/gpt-6-sol#default is not available")
    expect(h.sessions.fresh.agent).toBe("build")
    expect(h.store.get("pair/fresh")).toBeUndefined()
  })

  test("last applied setup survives plugin setup and text command, without applying itself to a new session", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.commands.get("fusion-models")!.execute({ sessionID: "parent", prompt: { text: "openai/gpt-6-sol#default openai/gpt-5.6-luna advisor=openai/gpt-6-sol#high" }, delivery: "steer" })
    await fusion.setup(h.ctx as any)
    const available = await h.inspect("fresh")
    expect(available.last).toEqual({ lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna", advisor: "openai/gpt-6-sol#high" })
    expect(h.sessions.fresh.agent).toBe("build")
    expect(h.store.get("pair/fresh")).toBeUndefined()
    const restored = await h.patch("fresh", available.last)
    expect(restored).toEqual({ ...available.last, lead: "openai/gpt-6-sol" })
    expect((await h.inspect("fresh")).current).toEqual(available.last)
    expect(h.sessions.fresh.agent).toBe("fusion")
    expect(h.store.get("pair/fresh")).toMatchObject({ lead: { id: "gpt-6-sol" }, advisor: { variant: "high" } })
  })

  test("recent model and effort choices are capped, deduplicated and persist for every role across setup", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#default", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna#default", "openai/gpt-6-sol#default")
    await h.patch("parent", { reviewer: "openai/gpt-6-sol#default" })
    await h.configure("parent", "openai/gpt-5.6-luna", "openai/gpt-6-sol#default", "openai/gpt-6-sol#high")
    await h.patch("parent", { reviewer: "openai/gpt-6-sol#high" })
    await h.configure("parent", "openai/gpt-6-sol#default", "github-copilot/claude-opus-5.5", "github-copilot/claude-opus-5.5")
    await h.patch("parent", { reviewer: "github-copilot/claude-opus-5.5" })
    expect((await h.inspect()).recent.lead).toEqual(["openai/gpt-6-sol#default", "openai/gpt-5.6-luna", "openai/gpt-6-sol#high"])
    await h.patch("parent", { lead: "openai/gpt-6-sol#xhigh" })
    await h.patch("parent", { reviewer: "openai/gpt-6-sol#xhigh" })
    await fusion.setup(h.ctx as any)
    expect((await h.inspect("fresh")).recent).toEqual({
      lead: ["openai/gpt-6-sol#xhigh", "openai/gpt-6-sol#default", "openai/gpt-5.6-luna"],
      sidekick: ["github-copilot/claude-opus-5.5", "openai/gpt-6-sol#default", "openai/gpt-5.6-luna"],
      advisor: ["github-copilot/claude-opus-5.5", "openai/gpt-6-sol#high", "openai/gpt-6-sol#default"],
      reviewer: ["openai/gpt-6-sol#xhigh", "github-copilot/claude-opus-5.5", "openai/gpt-6-sol#high"],
    })
    await h.patch("parent", { lead: "openai/gpt-6-sol#default" })
    expect((await h.inspect()).recent.lead).toEqual(["openai/gpt-6-sol#default", "openai/gpt-6-sol#xhigh", "openai/gpt-5.6-luna"])
  })

  test("only explicitly selected roles reorder history; clearing a role retains its recents", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "github-copilot/claude-opus-5.5")
    await h.patch("parent", { lead: "openai/gpt-6-sol#default", advisor: "openai/gpt-6-sol#xhigh" })
    await h.configure("fresh", "openai/gpt-5.6-luna", "openai/gpt-6-sol#high")
    const before = (await h.inspect()).recent
    expect(before.lead).toEqual(["openai/gpt-5.6-luna", "openai/gpt-6-sol#default", "openai/gpt-6-sol#high"])
    await h.patch("parent", { sidekick: "openai/gpt-5.6-luna", advisor: null })
    const after = (await h.inspect()).recent
    expect(after.lead).toEqual(before.lead)
    expect(after.advisor).toEqual(before.advisor)
    expect(after.sidekick).toEqual(["openai/gpt-5.6-luna", "openai/gpt-6-sol#high"])
    expect((await h.inspect("parent")).current).toEqual({ lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna" })
  })

  test("concurrent successful setups from separate sessions retain both recent choices", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await Promise.all([
      h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna"),
      h.configure("fresh", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh"),
    ])
    const { recent } = await h.inspect()
    expect(new Set(recent.lead)).toEqual(new Set(["openai/gpt-6-sol#high", "openai/gpt-5.6-luna"]))
    expect(new Set(recent.sidekick)).toEqual(new Set(["openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh"]))
  })

  test("inspect and validate do not persist recents, and failed selection or model switch does not add them", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    expect((await h.inspect()).recent).toEqual({ lead: [], sidekick: [], advisor: [], reviewer: [] })
    expect(h.store.size).toBe(0)
    await h.validate({ lead: "openai/gpt-6-sol#high", sidekick: "openai/gpt-5.6-luna" })
    await expect(h.configure("parent", "openai/unknown", "openai/gpt-5.6-luna")).rejects.toThrow("not available")
    expect(h.store.size).toBe(0)
    h.ctx.session.switchModel = async () => { throw new Error("switch failed") }
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")).rejects.toThrow("switch failed")
    expect(h.store.size).toBe(0)
    expect((await h.inspect()).recent).toEqual({ lead: [], sidekick: [], advisor: [], reviewer: [] })
  })

  test("failed agent switch or stale recent choice leaves successful history unchanged", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    const before = (await h.inspect()).recent
    const saved = h.store.get("recent-models")
    h.ctx.session.switchAgent = async () => { throw new Error("agent switch failed") }
    await expect(h.patch("parent", { lead: "openai/gpt-6-sol#default" })).rejects.toThrow("agent switch failed")
    expect(h.store.get("recent-models")).toBe(saved)
    h.models.splice(h.models.findIndex((model) => model.id === "gpt-5.6-luna"), 1)
    await expect(h.patch("parent", { sidekick: "openai/gpt-5.6-luna" })).rejects.toThrow("not available")
    expect((await h.inspect()).recent).toEqual(before)
  })

  test("legacy last setup seeds recent choices without an inspect write or loss of saved settings", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    const last = {
      lead: { providerID: "openai", id: "gpt-6-sol" }, sidekick: { providerID: "openai", id: "gpt-5.6-luna" },
      utility: { providerID: "gone", id: "obsolete" },
      advisor: { providerID: "openai", id: "gpt-6-sol", variant: "high" },
    }
    h.store.set("last-setup", last)
    expect((await h.inspect()).recent).toEqual({
      lead: ["openai/gpt-6-sol#default"], sidekick: ["openai/gpt-5.6-luna"],
      advisor: ["openai/gpt-6-sol#high"],
      reviewer: [],
    })
    expect(h.store.size).toBe(1)
    expect(h.store.get("last-setup")).toBe(last)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    expect((await h.inspect()).recent).toEqual({
      lead: ["openai/gpt-6-sol#high", "openai/gpt-6-sol#default"],
      sidekick: ["openai/gpt-5.6-luna"], advisor: ["openai/gpt-6-sol#high"], reviewer: [],
    })
  })

  test("legacy stored pairs show Default immediately and a partial update keeps their other refs", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    const lead = { providerID: "openai", id: "gpt-6-sol" }
    const sidekick = { providerID: "openai", id: "gpt-5.6-luna" }
    const adhoc = { providerID: "github-copilot", id: "claude-opus-5.5" }
    h.store.set("pair/parent", { lead, sidekick, adhoc })
    expect(await h.inspect("parent")).toEqual({ active: true, current: { lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna" }, recent: { lead: [], sidekick: [], advisor: [], reviewer: [] } })
    expect(await h.inspect()).toEqual({ active: false, recent: { lead: [], sidekick: [], advisor: [], reviewer: [] } })
    await h.patch("parent", { advisor: "openai/gpt-6-sol#high" })
    expect(h.store.get("pair/parent")).toMatchObject({ lead, sidekick, adhoc, advisor: { variant: "high" } })
    expect((h.store.get("pair/parent") as any).lead).toBe(lead)
    expect((await h.inspect()).last).toEqual({ lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna", advisor: "openai/gpt-6-sol#high" })
    h.models.splice(h.models.findIndex((model) => model.id === "gpt-5.6-luna"), 1)
    const prior = h.store.get("pair/parent")
    const switchCount = h.switched.length
    await expect(h.patch("parent", { advisor: "openai/gpt-6-sol#xhigh" })).rejects.toThrow("sidekick model openai/gpt-5.6-luna chosen by the user is not available")
    expect(h.store.get("pair/parent")).toBe(prior)
    expect(h.switched).toHaveLength(switchCount)
  })

  test("new-session preflight validates choices without switching an agent, writing storage, or creating a session", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    const before = h.sessions.fresh.agent
    await expect(h.validate({ lead: "openai/gpt-6-sol#high", sidekick: "openai/unknown" })).rejects.toThrow("sidekick model openai/unknown is not available")
    await expect(h.validate({ lead: "openai/gpt-6-sol#max", sidekick: "openai/gpt-5.6-luna" })).rejects.toThrow("Thinking effort max is not available")
    const result = await h.validate({ lead: "openai/gpt-6-sol#default", sidekick: "openai/gpt-5.6-luna", advisor: null })
    expect(result).toEqual({ lead: "openai/gpt-6-sol", sidekick: "openai/gpt-5.6-luna" })
    expect(h.switched).toEqual([])
    expect(h.store.size).toBe(0)
    expect(h.sessions.fresh.agent).toBe(before)
  })

  test("/fusion-models sets the pair and forwards the task", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const command = h.commands.get("fusion-models")!
    await expect(command.execute({ sessionID: "fresh", prompt: { text: "openai/gpt-6-sol#high" }, delivery: "steer" }))
      .rejects.toThrow("Usage: /fusion-models")
    await command.execute({
      sessionID: "fresh",
      prompt: { text: "openai/gpt-6-sol#xhigh openai/gpt-5.6-luna Implement the change" },
      delivery: "steer",
    })
    expect(h.sessions.fresh.agent).toBe("fusion")
    expect(h.sessions.fresh.model).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "xhigh" })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].text).toContain("lead openai/gpt-6-sol#xhigh, sidekick openai/gpt-5.6-luna")
    expect(h.prompts[0].text).toContain("Implement the change")
    const saved = h.store.get("pair/fresh")
    for (const option of ["utility=openai/gpt-6-sol#high", "adhoc=github-copilot/claude-opus-5.5"]) {
      await expect(command.execute({ sessionID: "fresh",
        prompt: { text: `openai/gpt-6-sol#xhigh openai/gpt-5.6-luna ${option} Check status` },
        delivery: "steer" })).rejects.toThrow()
      expect(h.store.get("pair/fresh")).toBe(saved)
      expect(h.prompts).toHaveLength(1)
    }
  })

  test("/fusion-models forwards multiline task content with indentation after optional model tokens", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const task = "  ### Objective\n  Trace the reported branch.\n\n    - Keep nested indentation\n  utility=literal task text"
    const commandText = `openai/gpt-6-sol#high openai/gpt-5.6-luna advisor=openai/gpt-6-sol#xhigh\n${task}`
    expect(parseModelsCommand(commandText)).toEqual({
      lead: "openai/gpt-6-sol#high", sidekick: "openai/gpt-5.6-luna",
      advisor: "openai/gpt-6-sol#xhigh", task,
    })
    await h.commands.get("fusion-models")!.execute({
      sessionID: "fresh", prompt: { text: commandText }, delivery: "steer",
    })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].text.split("\n\n").slice(1).join("\n\n")).toBe(task)
    expect(h.store.get("pair/fresh")).toMatchObject({
      lead: { id: "gpt-6-sol", variant: "high" },
      advisor: { id: "gpt-6-sol", variant: "xhigh" },
    })
  })

  test("lead instructions demand a user choice when models are missing or not in use", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const context = (model: any) => {
      const event = { agent: "fusion", sessionID: "parent", model, system: [] as any[] }
      return h.hooks.get("context")(event).then(() => {
        for (const part of event.system) expect(typeof part.text).toBe("string")
        return event.system.map((part) => part.text).join("\n")
      })
    }
    const unconfigured = await context({ providerID: "openai", id: "gpt-6-sol" })
    expect(unconfigured).toContain("Only the user chooses")
    expect(unconfigured).toContain("No Fusion models are configured")

    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    expect(await context({ providerID: "openai", id: "gpt-6-sol", variant: "high" })).toContain("chosen by the user: lead openai/gpt-6-sol#high")
    expect(await context({ providerID: "github-copilot", id: "claude-opus-5.5" })).toContain("not running on the lead model the user chose")

    const other = { agent: "build", sessionID: "parent", model: {}, system: [] as any[] }
    await h.hooks.get("context")(other)
    expect(other.system).toHaveLength(0)
  })

  test("Fusion context delivers the full briefing while native multiline prompts pass through", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    const guidance = await loadBriefing()
    const lead = { agent: "fusion", sessionID: "parent", model: h.sessions.parent.model, system: [] as any[] }
    await h.hooks.get("context")(lead)
    expect(lead.system.map((part) => part.text)).toContain(guidance.full)
    expect(guidance.full).toContain("\n- **Objective:**")
    expect(guidance.full).toContain("\n- **Return:**")

    const unrelated = { agent: "fusion-sidekick", sessionID: "otherSidekick", system: [] as any[], tools: {} as any }
    await expect(h.hooks.get("context")(unrelated)).rejects.toThrow("protected Fusion child ownership")
    const prompt = "### Objective\nTrace the failure.\n\n### Guidance\n- First check\n  - Keep indentation"
    const input = { agent: "fusion-sidekick", background: true, prompt }
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent", input })
    expect(input.prompt).toBe(prompt)
  })

  test("coding agents get stable minimal-solution guidance before the briefing, not advisor", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    const context = async (agent: string, sessionID: string) => {
      const event = { agent, sessionID, model: h.sessions.parent.model, system: [] as any[], tools: {} as any }
      await h.hooks.get("context")(event)
      return event.system.map((part) => part.text as string)
    }

    const lead = await context("fusion", "parent")
    const again = await context("fusion", "parent")
    const sidekick = await context("fusion-sidekick", "child")
    expect(lead[0]).toContain("## Minimal solutions")
    expect(sidekick[0]).toContain("## Minimal solutions")
    expect(lead[0]).toBe(again[0])
    expect(lead[1]).toBe((await loadBriefing()).full)
    expect((await context("fusion-advisor", "advisor")).join("\n")).not.toContain("## Minimal solutions")
  })

  test("sidekick delegation never falls back to another model", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const delegate = (input: any) => h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent", input })

    await expect(delegate({ agent: "fusion-sidekick", prompt: "task" })).rejects.toThrow("No Fusion models are configured")
    await expect(h.hooks.get("prompt")({ sessionID: "orphan" })).rejects.toThrow("Cannot verify Fusion session ancestry")

    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await expect(delegate({ agent: "fusion-sidekick", prompt: "task", model: "github-copilot/claude-opus-5.5" }))
      .rejects.toThrow("Do not override the user-selected subagent model")

    await h.hooks.get("prompt")({ sessionID: "child" })
    expect(h.switched.at(-1)).toEqual({ sessionID: "child", model: { providerID: "openai", id: "gpt-5.6-luna" } })
    const next = { agent: "fusion-sidekick", background: true, prompt: "next task" }
    await delegate(next)
    expect(next).toEqual({ agent: "fusion-sidekick", background: true, prompt: "next task" })
    await h.hooks.get("prompt")({ sessionID: "duplicate" })
    expect(h.sessions.duplicate.model.id).toBe("gpt-5.6-luna")
    const unrelated = { agent: "explore", prompt: "look" }
    await expect(delegate(unrelated)).rejects.toThrow("Fusion delegation allows")
    expect(unrelated).toEqual({ agent: "explore", prompt: "look" })

    h.models.splice(h.models.findIndex((model) => model.id === "gpt-5.6-luna"), 1)
    await expect(delegate({ agent: "fusion-sidekick", background: true, prompt: "task" })).rejects.toThrow("sidekick model openai/gpt-5.6-luna chosen by the user is not available")
    await expect(h.hooks.get("prompt")({ sessionID: "child" })).rejects.toThrow("Ask the user to choose")
  })

  test("lead reads require an explicit bounded range; sidekick reads remain unrestricted", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const read = (agent: string, sessionID: string, input: any) =>
      h.toolHooks.get("execute.before")({ tool: "read", agent, sessionID, input })
    for (const input of [{ path: "src/large.ts" }, { path: "src/large.ts", offset: 0 }, { path: "src/large.ts", limit: 200 },
      { path: "src/large.ts", offset: 0, limit: 351 }, { path: "src/large.ts", offset: 0, limit: 0 },
      { path: "src/large.ts", offset: 0, limit: 2.5 }, { path: "src/large.ts", offset: -1, limit: 1 }]) {
      await expect(read("fusion", "parent", input)).rejects.toThrow("explicit offset and limit")
    }
    await read("fusion", "parent", { path: "src/large.ts", offset: 0, limit: 201 })
    await read("fusion", "parent", { path: "src/large.ts", offset: 0, limit: 350 })
    await read("fusion-sidekick", "child", { path: "src/large.ts" })
  })

  test("changing lead or sidekick selection retains the coding child and switches its model in place", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.hooks.get("prompt")({ sessionID: "child" })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.configure("parent", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    expect(h.sessions.parent.model).toEqual({ providerID: "openai", id: "gpt-5.6-luna" })
    await h.hooks.get("prompt")({ sessionID: "child" })
    expect(h.switched.at(-1)).toEqual({ sessionID: "child", model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } })
    const next = { agent: "fusion-sidekick", background: true, sessionID: "child", prompt: "continue same task" }
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent", input: next })
    expect(next.sessionID).toBe("child")
  })

  test("only the lead delegates to sidekick or advisor; unrelated agents remain unaffected and identity fails closed", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const before = (agent: string, sessionID: string, input: any) =>
      h.toolHooks.get("execute.before")({ tool: "subagent", agent, sessionID, input })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await before("fusion", "parent", { agent: "fusion-sidekick", background: true, prompt: "work" })
    await expect(before("fusion", "parent", { agent: "fusion-utility", prompt: "git status", background: true })).rejects.toThrow()
    for (const target of ["general", "fusion-sidekick", "fusion-advisor", "fusion-utility"]) {
      await expect(before("fusion-sidekick", "child", { agent: target, background: true, prompt: "work" })).rejects.toThrow()
    }
    for (const unsafe of [
      { agent: "fusion-sidekick", background: false },
      { agent: "fusion-sidekick" },
      { agent: "fusion-sidekick", model: null, background: true },
      { agent: "fusion-sidekick", reasoning_effort: null, background: true },
      { agent: "fusion-sidekick", context_tier: "long", background: true },
      { agent: "fusion-sidekick", sessionID: "missing", background: true },
    ]) await expect(before("fusion", "parent", unsafe)).rejects.toThrow()
    await h.hooks.get("prompt")({ sessionID: "child" })
    for (const sessionID of ["utilityNested", "otherSidekick", "missing"]) {
      await expect(before("fusion", "parent", { agent: "fusion-sidekick", sessionID, background: true })).rejects.toThrow()
    }
    await expect(before("explore", "unknownFusionChild", { agent: "fusion-sidekick", prompt: "work" })).rejects.toThrow("Fusion delegation allows")
    const unrelated = { agent: "general", prompt: "work", model: "user-selected" }
    await before("build", "unrelated", unrelated)
    await before("general", "unrelatedChild", unrelated)
    expect(unrelated.model).toBe("user-selected")
    await expect(before("fusion", "missing", { agent: "fusion-sidekick", background: true })).rejects.toThrow("Cannot verify Fusion session identity")
    delete h.sessions.unrelated.agent
    await before("build", "unrelated", unrelated)
    await h.toolHooks.get("execute.before")({ tool: "websearch", agent: "build", sessionID: "unrelated", input: { query: "docs" } })
    h.sessions.unrelated.agent = "plan"
    await before("build", "unrelated", unrelated)
    await h.toolHooks.get("execute.before")({ tool: "webfetch", agent: "build", sessionID: "unrelated", input: { url: "https://example.test" } })
    await expect(before("build", "parent", { agent: "fusion-sidekick", prompt: "work", background: true })).rejects.toThrow("Cannot verify Fusion caller identity")
    delete h.sessions.parent.agent
    await expect(before("fusion", "parent", { agent: "fusion-sidekick", background: true })).rejects.toThrow()
  })

  test("retired utility conversations are refused without changing models or deleting their history", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.hooks.get("prompt")({ sessionID: "child" })
    for (const sessionID of ["utilityRoot", "utilityNested"]) {
      const session = h.sessions[sessionID]
      session.messages = [{ text: "previous work" }]
      const model = session.model
      await expect(h.hooks.get("prompt")({ sessionID })).rejects.toThrow("removed")
      await expect(h.hooks.get("context")({ agent: "fusion-utility", sessionID, system: [], tools: {} })).rejects.toThrow("removed")
      await expect(h.toolHooks.get("execute.before")({ tool: "shell", agent: "fusion-utility", sessionID, input: { command: "git status" } })).rejects.toThrow("removed")
      expect(h.sessions[sessionID]).toBe(session)
      expect(session.model).toBe(model)
      expect(session.messages).toEqual([{ text: "previous work" }])
    }
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent",
      input: { agent: "fusion-sidekick", background: true, sessionID: "child" } })
    expect(h.store.get("sidekick/utilityNested")).toBeUndefined()
  })

  test("sidekick keeps native web tools while lead retrieval is denied and unrelated agents stay unchanged", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const before = (agent: string, sessionID: string, tool: string) =>
      h.toolHooks.get("execute.before")({ tool, agent, sessionID, input: { query: "docs" } })
    for (const tool of ["websearch", "webfetch"]) {
      await expect(before("fusion", "parent", tool)).rejects.toThrow()
      await before("fusion-sidekick", "child", tool)
      await before("build", "unrelated", tool)
    }
    for (const [agent, sessionID, hidden] of [["fusion", "parent", true], ["fusion-sidekick", "child", false], ["build", "unrelated", false]] as const) {
      const event = { agent, sessionID, model: { providerID: "openai", id: "gpt-6-sol" }, system: [] as any[], tools: { websearch: {}, webfetch: {}, shell: {}, grep: {}, glob: {}, edit: {} } as any }
      await h.hooks.get("context")(event)
      expect("websearch" in event.tools).toBe(!hidden)
      expect("webfetch" in event.tools).toBe(!hidden)
      for (const tool of ["shell", "grep", "glob"]) expect(tool in event.tools).toBe(true)
      expect("edit" in event.tools).toBe(true)
    }
    const outside = { agent: "fusion-sidekick", sessionID: "otherSidekick", model: {}, system: [] as any[], tools: { websearch: {}, webfetch: {} } as any }
    await expect(h.hooks.get("context")(outside)).rejects.toThrow("protected Fusion child ownership")
  })

  test("root lead shell, grep, and glob are denied without restricting sidekick or unrelated agents", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const before = (agent: string, sessionID: string, tool: string) =>
      h.toolHooks.get("execute.before")({ tool, agent, sessionID, input: {} })
    for (const tool of ["shell", "grep", "glob"]) {
      await expect(before("fusion", "parent", tool)).rejects.toThrow()
      await before("fusion-sidekick", "child", tool)
      await before("build", "unrelated", tool)
    }
  })

  test("sidekick can run Git and checks directly, but a foreign child cannot use its shell", async () => {
    const h = harness()
    await fusion.setup(h.ctx as any)
    const shell = (agent: string, sessionID: string, command: unknown) =>
      h.toolHooks.get("execute.before")({ tool: "shell", agent, sessionID, input: { command } })
    for (const command of ["git status --short", "bun test"]) {
      await shell("fusion-sidekick", "child", command)
      await expect(shell("fusion-sidekick", "otherSidekick", command)).rejects.toThrow("protected Fusion child ownership")
    }
    await expect(shell("fusion", "parent", "git status")).rejects.toThrow("Fusion lead cannot use shell")
    await shell("build", "unrelated", "git status")
  })

  test("staged agent permissions allow optional review without restricting sidekick host tools", () => {
    const agent = (name: string) => {
      const body = readFileSync(resolvePath(import.meta.dir, "agents", `${name}.md`), "utf8")
      return Bun.YAML.parse(body.split("---")[1]) as any
    }
    const lead = agent("fusion")
    const sidekick = agent("fusion-sidekick")
    const advisor = agent("fusion-advisor")
    expect(lead.permissions.filter((rule: any) => rule.action === "subagent" && rule.effect === "allow").map((rule: any) => rule.resource))
      .toEqual(["fusion-sidekick", "fusion-advisor", "fusion-reviewer"])
    for (const action of ["shell", "grep", "glob", "websearch", "webfetch"]) {
      expect(lead.permissions).toContainEqual({ action, resource: "*", effect: "deny" })
    }
    expect(lead.permissions.some((rule: any) => rule.action === "edit" && rule.effect === "deny")).toBe(false)
    for (const action of ["shell", "grep", "glob", "websearch", "webfetch", "edit", "read", "mcp_anything"]) {
      expect(sidekick.permissions.some((rule: any) => (rule.action === action || rule.action === "*") && rule.effect === "deny")).toBe(false)
    }
    expect(sidekick.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(sidekick.permissions.some((rule: any) => rule.action === "subagent" && rule.effect === "allow")).toBe(false)
    expect(advisor.model).toBeUndefined()
    expect(advisor.mode).toBe("subagent")
  })

  test("advisor choice is optional, preserved, explicitly clearable, and validates the user-chosen model", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    await h.hooks.get("prompt")({ sessionID: "child" })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    expect((h.store.get("pair/parent") as any).advisor?.variant).toBe("xhigh")
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    expect((h.store.get("pair/parent") as any).advisor?.variant).toBe("xhigh")
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/no-such-model"))
      .rejects.toThrow("advisor model")
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", null)
    expect((h.store.get("pair/parent") as any).advisor).toBeUndefined()
    expect(Object.hasOwn(h.store.get("pair/parent") as object, "advisor")).toBe(false)
    await h.toolHooks.get("execute.before")({ tool: "subagent", agent: "fusion", sessionID: "parent",
      input: { agent: "fusion-sidekick", background: true, sessionID: "child" } })
    h.models.push({ providerID: "openai", id: "no-tools", variants: [], capabilities: { tools: false, output: ["text"] } })
    await expect(h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/no-tools")).rejects.toThrow("must support tools")
    expect((h.store.get("pair/parent") as any).advisor).toBeUndefined()
    await expect(h.configure("parent", "openai/no-tools", "openai/gpt-5.6-luna")).rejects.toThrow("must support tools")
  })

  test("lead-only advisor consultation can resume only verified same-root direct advisor sessions", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna")
    const run = (agent: string, sessionID: string, input: any) =>
      h.toolHooks.get("execute.before")({ tool: "subagent", agent, sessionID, input })
    await expect(run("fusion", "parent", { agent: "fusion-advisor", background: false, prompt: "critique" })).rejects.toThrow("not configured")
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#xhigh")
    for (const input of [{ agent: "fusion-advisor", background: false, prompt: "first" }, { agent: "fusion-advisor", background: false, prompt: "more evidence", sessionID: "advisor" },
      { agent: "fusion-advisor", background: true, prompt: "independent consultation" }, { agent: "fusion-advisor", prompt: "native default" }]) await run("fusion", "parent", input)
    for (const input of [
      { agent: "fusion-advisor", background: false, sessionID: "child" },
      { agent: "fusion-advisor", background: false, sessionID: "utilityRoot" },
      { agent: "fusion-advisor", background: false, sessionID: "nestedAdvisor" },
      { agent: "fusion-advisor", background: false, sessionID: "foreignAdvisor" },
      { agent: "fusion-advisor", background: false, sessionID: "missing" },
      { agent: "fusion-advisor", background: false, model: null },
      { agent: "fusion-advisor", background: false, reasoning_effort: "high" },
    ]) await expect(run("fusion", "parent", input)).rejects.toThrow()
    await expect(run("fusion-sidekick", "child", { agent: "fusion-advisor", background: false })).rejects.toThrow("Fusion delegation")
    await expect(run("fusion-advisor", "advisor", { agent: "fusion-sidekick", background: true })).rejects.toThrow()
    await run("build", "unrelated", { agent: "fusion-advisor", background: true })
    await h.hooks.get("prompt")({ sessionID: "advisor" })
    expect(h.switched.at(-1)).toEqual({ sessionID: "advisor", model: { providerID: "openai", id: "gpt-6-sol", variant: "xhigh" } })
    await h.configure("parent", "openai/gpt-6-sol#high", "openai/gpt-5.6-luna", "openai/gpt-6-sol#high")
    await h.hooks.get("prompt")({ sessionID: "advisor" })
    expect(h.switched.at(-1)).toEqual({ sessionID: "advisor", model: { providerID: "openai", id: "gpt-6-sol", variant: "high" } })
    await expect(h.hooks.get("prompt")({ sessionID: "nestedAdvisor" })).rejects.toThrow("ancestry")
  })

  test("advisor context permits bounded reads and evidence delegation but no direct execution or mutation", async () => {
    const h = harness(); await fusion.setup(h.ctx as any)
    const event = { agent: "fusion-advisor", sessionID: "advisor", system: [] as any[], tools: { shell: {}, read: {}, websearch: {}, subagent: {} } as any }
    await h.hooks.get("context")(event)
    expect(event.tools.shell).toBeUndefined()
    expect(event.tools.websearch).toBeUndefined()
    await h.toolHooks.get("execute.before")({ tool: "read", agent: "fusion-advisor", sessionID: "advisor", input: { path: "src/large.ts", offset: 0, limit: 350 } })
    await expect(h.toolHooks.get("execute.before")({ tool: "read", agent: "fusion-advisor", sessionID: "advisor", input: { path: "src/large.ts", offset: 0, limit: 351 } })).rejects.toThrow("explicit offset and limit")
    for (const tool of ["shell", "edit", "write", "websearch", "mcp_anything"]) {
      await expect(h.toolHooks.get("execute.before")({ tool, agent: "fusion-advisor", sessionID: "advisor", input: {} })).rejects.toThrow("read-only")
    }
    const meta = Bun.YAML.parse(readFileSync(resolvePath(import.meta.dir, "agents/fusion-advisor.md"), "utf8").split("---")[1]) as any
    expect(meta.model).toBeUndefined()
    expect(meta.mode).toBe("subagent")
  })
})
