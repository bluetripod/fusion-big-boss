import { expect, test } from "bun:test"
import { collectUsage } from "./usage"

const tokens = (input: number) => ({ input, output: 10, reasoning: 2, cache: { read: 20, write: 5 } })

test("usage follows paginated descendants and messages, combines context aliases, and keeps missing prices unknown", async () => {
  const message = (id: string, model: string, input: number, cost?: number) => ({ id, type: "assistant", model: { providerID: "p", id: model }, tokens: tokens(input), cost })
  const messages: Record<string, any[]> = {
    root: [message("a", "a:fusion-context-100k", 100, 0.1), message("b", "a", 200, 0.2)],
    child: [message("c", "b", 300, 0), { id: "summary", type: "compaction", status: "completed", tokens: tokens(50), cost: 0.01 }],
    evidence: [message("d", "a", 400, 0.4)],
    second: [message("e", "b", 500)],
  }
  const children: Record<string, string[]> = { root: ["child", "second"], child: ["evidence"] }
  const client: any = {
    model: { list: async () => ({ data: [{ providerID: "p", id: "a", cost: [{ input: 1 }] }, { providerID: "p", id: "b", cost: [] }] }) },
    session: { list: async ({ parentID, cursor }: any) => {
      const ids = children[parentID] ?? [], index = Number(cursor ?? 0)
      return { data: ids.slice(index, index + 1).map(id => ({ id, parentID })), cursor: { next: index + 1 < ids.length ? String(index + 1) : null } }
    } },
    message: { list: async ({ sessionID, cursor }: any) => {
      const items = messages[sessionID], index = Number(cursor ?? 0)
      return { data: items.slice(index, index + 1), cursor: { next: index + 1 < items.length ? String(index + 1) : null } }
    } },
  }
  const result = await collectUsage(client, "root")
  expect(result.sessions).toBe(4)
  expect(result.report.models.find(row => row.model === "p/a")?.values.input).toBe(700)
  expect(result.report.models.find(row => row.model === "p/b")?.missing.cost).toBe(2)
  expect(result.report.models.find(row => row.model === "Unattributed")?.values.input).toBe(50)
  expect(result.report.total.values.input).toBe(1550)
  expect(result.report.total.values.cost).toBeCloseTo(0.71)
})

test("unreadable descendant usage rejects instead of presenting an incomplete total", async () => {
  const client: any = {
    model: { list: async () => ({ data: [] }) },
    session: { list: async () => ({ data: [{ id: "child", parentID: "root" }], cursor: {} }) },
    message: { list: async ({ sessionID }: any) => { if (sessionID === "child") throw new Error("session unavailable"); return { data: [], cursor: {} } } },
  }
  await expect(collectUsage(client, "root")).rejects.toThrow("session unavailable")
})
