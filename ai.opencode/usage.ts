import type { Plugin } from "@opencode/plugin/tui"
import { summarizeUsage, type UsageRecord } from "../shared/usage.mjs"
import { baseModel } from "./context"

export async function collectUsage(client: Pick<Plugin.Context["client"], "session" | "message" | "model">, sessionID: string, location?: Plugin.Context["location"]) {
  const catalog = (await client.model.list({ location })).data
  const records: UsageRecord[] = []
  const sessions = new Set([sessionID])
  for (const id of sessions) {
    let cursor: string | undefined
    const messages = new Set<string>(), pages = new Set<string>()
    do {
      const page = await client.message.list({ sessionID: id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) })
      for (const message of page.data) {
        if (messages.has(message.id)) continue
        messages.add(message.id)
        if (message.type !== "assistant" && message.type !== "compaction") continue
        const tokens = "tokens" in message ? message.tokens : undefined
        const cost = "cost" in message ? message.cost : undefined
        const model = "model" in message ? message.model : undefined
        if (!tokens && cost === undefined) continue
        const native = model && baseModel(model.id).id
        const priced = model && catalog.some(item => item.providerID === model.providerID && item.id === native && item.cost.length > 0)
        records.push({ model: model ? `${model.providerID}/${native}` : "Unattributed",
          input: tokens?.input, output: tokens?.output, cacheRead: tokens?.cache.read, cacheWrite: tokens?.cache.write,
          cost: cost !== undefined && (cost > 0 || priced) ? cost : undefined })
      }
      cursor = page.cursor.next ?? undefined
      if (cursor && pages.has(cursor)) throw new Error("Usage message pagination did not advance.")
      if (cursor) pages.add(cursor)
    } while (cursor)
    pages.clear()
    do {
      const page = await client.session.list({ parentID: id, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) })
      for (const child of page.data) if (child.parentID === id) sessions.add(child.id)
      cursor = page.cursor.next ?? undefined
      if (cursor && pages.has(cursor)) throw new Error("Usage session pagination did not advance.")
      if (cursor) pages.add(cursor)
    } while (cursor)
  }
  return { sessions: sessions.size, report: summarizeUsage(records) }
}
