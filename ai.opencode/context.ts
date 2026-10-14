import type { Plugin } from "@opencode/plugin"
import { contextLabel, validateContext } from "../shared/context.mjs"

export function contextID(id: string, context?: number) {
  return context === undefined ? id : `${id}:fusion-context-${context / 1000}k`
}

export function baseModel(id: string) {
  const match = /:fusion-context-(\d+)k$/.exec(id)
  return match ? { id: id.slice(0, match.index), context: Number(match[1]) * 1000 } : { id }
}

/** Aliases give native compaction independent limits while retaining the API modelID. */
export async function contextModels(ctx: Plugin.Context) {
  const requested = new Map<string, { providerID: string; id: string }>()
  function remember(value: unknown) {
    if (!value || typeof value !== "object") return
    for (const ref of Object.values(value)) {
      if (ref && typeof ref === "object" && "providerID" in ref && "id" in ref
        && typeof ref.providerID === "string" && typeof ref.id === "string" && baseModel(ref.id).context) {
        requested.set(`${ref.providerID}/${ref.id}`, { providerID: ref.providerID, id: ref.id })
      }
    }
  }
  remember(await ctx.storage.get("last-setup"))
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "pair/", limit: 100, ...(after ? { after } : {}) })
    for (const entry of page.entries) remember(entry.value)
    after = page.next
  } while (after)
  await ctx.model.transform(editor => {
    for (const ref of requested.values()) {
      const { id, context } = baseModel(ref.id)
      const source = editor.get(ref.providerID, id)
      if (!source || editor.get(ref.providerID, ref.id)) continue
      try { validateContext(context, source.limit.context) } catch { continue }
      editor.update(ref.providerID, ref.id, draft => {
        Object.assign(draft, structuredClone(source), {
          id: ref.id, name: `${source.name} (Fusion ${contextLabel(context!)})`,
          limit: { ...source.limit, context: context!,
            ...(source.limit.input === undefined ? {} : { input: Math.min(source.limit.input, context!) }) },
        })
      })
    }
  })
  return async (ref: { providerID: string; id: string }) => {
    const { id, context } = baseModel(ref.id)
    if (context === undefined) return
    const source = (await ctx.model.list()).data.find(m => m.providerID === ref.providerID && m.id === id)
    validateContext(context, source?.limit.context)
    const key = `${ref.providerID}/${ref.id}`
    if (!requested.has(key)) {
      requested.set(key, ref)
      await ctx.model.reload()
    }
    const alias = (await ctx.model.list()).data.find(m => m.providerID === ref.providerID && m.id === ref.id)
    if (!alias || alias.limit.context !== context || alias.modelID !== source?.modelID) {
      throw new Error("Fusion context alias conflicts with the available catalog. Choose Default or resolve the conflicting model definition.")
    }
  }
}
