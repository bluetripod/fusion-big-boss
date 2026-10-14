import { Plugin } from "@opencode/plugin/tui"
import { FusionRPC } from "./rpc"
import { splitContext, withContext, contextLabel, contextOptions } from "../shared/context.mjs"
import { baseModel } from "./context"
import { collectUsage } from "./usage"
import { formatUsage } from "../shared/usage.mjs"

type Role = "lead" | "sidekick" | "advisor" | "reviewer"
type Selection = { lead?: string; sidekick?: string; advisor?: string; reviewer?: string }
type Recents = Record<Role, string[]>
const roles: Role[] = ["lead", "sidekick", "advisor", "reviewer"]

function parts(value?: string) {
  if (!value) return { model: "", effort: "default", context: undefined }
  const { choice, context } = splitContext(value)
  const hash = choice.lastIndexOf("#")
  return { model: hash < 0 ? choice : choice.slice(0, hash), effort: hash < 0 ? "default" : choice.slice(hash + 1), context }
}

export default Plugin.define({
  id: "fusion-mode.tui",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "fusion.select-models",
             title: "Fusion: review or edit one role's model, thinking effort or context",
            group: "Fusion",
            palette: true,
            slash: { name: "fusion" },
            run: async () => {
              const location = context.location ?? context.data.location.default()
              try {
                const route = context.ui.router.current()
                const sessionID = route.type === "session" ? route.sessionID : undefined
                const rpc = context.client.rpc(FusionRPC)
                const saved = await rpc.inspect(sessionID ? { sessionID } : {}, { location }) as { current?: Selection; last?: Selection; recent?: Recents; active?: boolean; previous?: string }
                 const catalog = () => (context.data.location.model.list(location) ?? [])
                   .filter((model) => model.capabilities.output.includes("text"))
                   .filter((model) => baseModel(model.id).context === undefined)
                  .sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`))
                let models = catalog()
                let catalogSynced = false
                const find = (value?: string) => models.find((model) => `${model.providerID}/${model.id}` === parts(value).model)
                let draft: Selection = { ...saved.current }
                let changes: Partial<Record<Role, string | null>> = {}

                const isAvailable = (role: Role, value: string) => {
                  const available = find(value)
                   const { effort, context: budget } = parts(value)
                   return !!available && (role === "advisor" || available.capabilities.tools)
                     && (effort === "default" || available.variants.some((variant) => variant.id === effort))
                     && (budget === undefined || contextOptions(available.limit.context).includes(budget))
                }

                const title = (role: Role, value?: string) => {
                  if (!value) return `${role[0].toUpperCase()}${role.slice(1)} ${role === "advisor" || role === "reviewer" ? "disabled" : "not configured"}`
                   const { model, effort, context: budget } = parts(value)
                   return `${role[0].toUpperCase()}${role.slice(1)} ${model} · ${effort === "default" ? "Default" : effort} · ${budget === undefined ? "Default context" : `${contextLabel(budget)} context`}${isAvailable(role, value) ? "" : " (unavailable)"}`
                 }

                 const pickContext = (role: Role, window: number, current?: string) => context.ui.dialog.select({
                   title: `Fusion ${role}: context budget (local compaction target, not a pricing tier)`,
                   current: parts(current).context?.toString() ?? "default",
                   options: [
                     { title: `Default · native ${contextLabel(window)}`, value: "default", description: "Uses the host's normal context and compaction settings" },
                     ...contextOptions(window).map(value => ({ title: contextLabel(value), value: String(value), description: "Native compaction starts earlier; not a strict token or billing ceiling" })),
                   ],
                 })

                while (true) {
                  const action = await context.ui.dialog.select({
                     title: saved.current && saved.active === false ? "Fusion off · saved models, effort and context" : "Fusion models, thinking effort and context",
                    options: [
                       ...(sessionID && saved.active ? [{ title: "Turn Fusion off", value: "disable" }] : []),
                       ...(sessionID && saved.active === false && saved.current ? [{ title: "Enable saved Fusion setup", value: "enable" }] : []),
                       ...roles.map((role) => ({ title: title(role, draft[role]), value: role })),
                      ...(saved.last ? [{ title: `Use last setup · ${roles.map((role) => title(role, saved.last?.[role])).join(" · ")}`, value: "last" }] : []),
                      { title: "Apply this setup", value: "apply" },
                    ],
                  })
                  if (!action) return // Escape discards the entire draft.
                  if (action === "disable" && sessionID) {
                    let agent: string | undefined
                    if (!saved.previous) {
                      await context.data.location.agent.sync(location)
                      agent = await context.ui.dialog.select({
                        title: "Return to an ordinary primary agent",
                        options: (context.data.location.agent.list(location) ?? [])
                          .filter((item) => item.id !== "fusion" && !item.hidden && (item.mode === "primary" || item.mode === "all"))
                          .map((item) => ({ title: item.name, value: item.id })),
                      }) ?? undefined
                      if (!agent) return
                    }
                    const result = await rpc.disable({ sessionID, ...(agent ? { agent } : {}) }, { location }) as { agent: string }
                    context.ui.toast.show({ title: "Fusion off", message: `Now using ${result.agent}. Already-running background workers finish normally in this session.`, variant: "success" })
                    return
                  }
                  if (action === "enable" && sessionID) {
                    await rpc.configure({ sessionID }, { location })
                    context.ui.toast.show({ title: "Fusion ready", message: "Saved Fusion setup enabled in this session.", variant: "success" })
                    return
                  }
                  if (!catalogSynced) {
                    await context.data.location.model.sync(location)
                    models = catalog()
                    catalogSynced = true
                  }
                  if (action === "last") {
                    draft = { ...saved.last }
                    changes = { lead: draft.lead, sidekick: draft.sidekick, advisor: draft.advisor ?? null, reviewer: draft.reviewer ?? null }
                    continue
                  }
                  if (action === "apply") {
                    if (!draft.lead || !draft.sidekick) {
                      await context.ui.dialog.alert({ title: "Fusion", message: "Choose lead and sidekick models before applying." })
                      continue
                    }
                    let invalid: string | undefined
                    for (const role of roles) {
                      if (draft[role] && !isAvailable(role, draft[role])) invalid = title(role, draft[role])
                    }
                    if (invalid) {
                      await context.ui.dialog.alert({ title: "Fusion", message: `${invalid}. Choose an available model, thinking effort or context budget before applying.` })
                      continue
                    }
                    const a = parts(draft.lead), b = parts(draft.sidekick)
                    if (a.model === b.model && a.effort === b.effort) {
                      await context.ui.dialog.alert({ title: "Fusion", message: "Choose different models for lead and sidekick." })
                      continue
                    }
                    const setup = { ...(!sessionID ? { lead: draft.lead, sidekick: draft.sidekick } : {}), ...changes }
                    if (!sessionID) await rpc.validate({ lead: draft.lead, sidekick: draft.sidekick, ...changes }, { location })
                    const target = sessionID ?? (await context.client.session.create({ agent: "fusion", location })).id
                    const selected = await rpc.configure({ sessionID: target, ...setup }, { location }) as Selection
                    context.ui.router.navigate({ type: "session", sessionID: target })
                    context.ui.toast.show({
                      title: "Fusion ready",
                      message: `Lead ${selected.lead} · Sidekick ${selected.sidekick}${selected.advisor ? ` · Optional advisor ${selected.advisor}` : " · Advisor disabled"}${selected.reviewer ? ` · Optional reviewer ${selected.reviewer}` : " · Reviewer disabled"}`,
                      variant: "success",
                    })
                    return
                  }

                  const role = action as Role
                  const current = draft[role]
                  const recent = (saved.recent?.[role] ?? []).slice(0, 3)
                  const method = await context.ui.dialog.select({
                    title: `Fusion ${role}: change`,
                    options: [
                      ...recent.map((value) => ({ title: title(role, value), value, disabled: !isAvailable(role, value) })),
                      { title: "Choose new model", value: "new" },
                      ...(current && find(current) ? [{ title: "Change context budget", value: "context" }] : []),
                      ...(role === "advisor" || role === "reviewer" ? [{ title: "Disabled", value: "off" }] : []),
                    ],
                  })
                  if (!method) return
                  if (method === "off") {
                    delete draft[role]
                    changes[role] = null
                    continue
                  }
                  if (method === "context" && current) {
                    const model = find(current)
                    if (!model) continue
                    const budget = await pickContext(role, model.limit.context, current)
                    if (!budget) return
                    draft[role] = withContext(current, budget === "default" ? undefined : Number(budget))
                    changes[role] = draft[role]
                    continue
                  }
                  if (method !== "new") {
                    if (recent.includes(method) && isAvailable(role, method)) {
                      draft[role] = method
                      changes[role] = method
                    }
                    continue
                  }
                  const choices = role === "advisor" ? models : models.filter((model) => model.capabilities.tools)
                  let selectedModel = find(current)
                  const pickedModel = await context.ui.dialog.select({
                    title: role === "reviewer" ? "Fusion reviewer: prefer a different model family from the lead (suggestion only)" : `Fusion ${role}: model`,
                    placeholder: "Search models...",
                    current: parts(current).model || undefined,
                    options: [
                      ...(!selectedModel && current ? [{ title: parts(current).model, value: parts(current).model, description: "Unavailable", disabled: true }] : []),
                      ...choices.map((model) => ({ title: model.name, value: `${model.providerID}/${model.id}`, description: `${model.providerID}/${model.id}`, category: model.providerID })),
                    ],
                  })
                  if (!pickedModel) return
                  selectedModel = choices.find((model) => `${model.providerID}/${model.id}` === pickedModel)
                  if (!selectedModel) return
                  const modelKey = `${selectedModel.providerID}/${selectedModel.id}`
                  const effort = selectedModel.variants.length ? await context.ui.dialog.select({
                    title: `Fusion ${role}: thinking effort`,
                    current: parts(current).model === modelKey && selectedModel.variants.some((v) => v.id === parts(current).effort)
                      ? parts(current).effort : "default",
                    options: [
                      { title: "Default", value: "default" },
                      ...selectedModel.variants.map((variant) => ({ title: variant.id, value: variant.id })),
                    ],
                  }) : "default"
                  if (!effort) return
                  const budget = await pickContext(role, selectedModel.limit.context, parts(current).model === modelKey ? current : undefined)
                  if (!budget) return
                  draft[role] = withContext(`${modelKey}${selectedModel.variants.length ? `#${effort}` : ""}`, budget === "default" ? undefined : Number(budget))
                  changes[role] = draft[role]
                }
              } catch (error) {
                context.ui.toast.show({ title: "Fusion setup failed", message: error instanceof Error ? error.message : String(error), variant: "error" })
              }
            },
           }, {
             id: "fusion.usage",
             title: "Usage: session and subagents by model",
             group: "Fusion",
             palette: true,
             slash: { name: "usage" },
             run: async () => {
               const route = context.ui.router.current()
               if (route.type !== "session") {
                 await context.ui.dialog.alert({ title: "Usage", message: "Open a session to see its recorded usage." })
                 return
               }
               try {
                 const result = await collectUsage(context.client, route.sessionID, context.location ?? context.data.location.default())
                 await context.ui.dialog.alert({ title: "Session usage", message: formatUsage(result.report, result.sessions) })
               } catch (error) {
                 context.ui.toast.show({ title: "Usage unavailable", message: error instanceof Error ? error.message : String(error), variant: "error" })
               }
             },
           }],
        }))
        return null
      },
    })
  },
})
