import { Plugin } from "@opencode/plugin"
import { FusionRPC } from "./rpc"
import { loadBriefing } from "../shared/briefing.mjs"
import { splitContext, withContext } from "../shared/context.mjs"
import { baseModel, contextID, contextModels } from "./context"
import { createSupervisor } from "../shared/supervision.mjs"

type ModelRef = { providerID: string; id: string; variant?: string }
type Pair = { lead: ModelRef; sidekick: ModelRef; advisor?: ModelRef; reviewer?: ModelRef; adhoc?: ModelRef }
type Choices = Pick<Pair, "lead" | "sidekick" | "advisor" | "reviewer">
type Role = keyof Choices
type Recents = Record<Role, string[]>
const roles: Role[] = ["lead", "sidekick", "advisor", "reviewer"]

const key = (sessionID: string) => `pair/${sessionID}`
const lastKey = "last-setup"
const recentsKey = "recent-models"
const childKey = (sessionID: string) => `sidekick/${sessionID}`
const sidekickOwnerKey = (sessionID: string) => `sidekick-owner/${sessionID}`
const previousKey = (sessionID: string) => `previous/${sessionID}`
const reviewKey = (sessionID: string) => `reviewer/${sessionID}`
const chooseAgain = "Ask the user to choose the lead, sidekick, optional advisor/reviewer models, thinking effort and context budget with /fusion " +
  "(or /fusion-models <lead> <sidekick> [advisor=<model>] [reviewer=<model>]). Never choose, change, or substitute a model yourself."

const minimalSolutions = [
  "## Minimal solutions",
  "For implementation, understand the request and trace the relevant code before choosing a solution. Build only what the user needs: reuse existing code first, then standard-library or native platform features, then an installed dependency; add new code or dependencies only when necessary.",
  "Prefer the smallest clear change at the root cause, not clever one-liners or speculative abstractions. Never omit requested behavior, trust-boundary validation, data-loss protection, security, accessibility, or a useful regression check just to reduce code.",
].join("\n\n")

const leadInstructions = [
  "## Fusion lead: authority and models",
  "You are the lead coding agent in Fusion mode. Only the user chooses the lead, persistent sidekick, optional advisor/reviewer, and their thinking effort and context budgets, with /fusion or /fusion-models. You cannot configure models or context budgets, and you must never choose, change, or substitute any model yourself, including through a subagent `model` argument.",
  "If required Fusion lead/coding models are missing or unavailable, stop and ask the user to choose with /fusion. The optional advisor is never required for normal work: if unconfigured, disabled, or its selected model unavailable, skip or decline that consultation, do not substitute a model, and continue ordinary work.",
  "## Delegation and review",
  "Own the plan, ambiguous requirements, architectural and security decisions, final review, and the user-facing answer.",
  "Assess source-reading needs before choosing an implementation approach, following Evidence before implementation in the briefing. Read and interpret source yourself. Use fusion-sidekick only for a precise file-location lookup with known search roots and filenames/symbols/patterns; it returns paths and line ranges, not source analysis or excerpts.",
  "Use multiple persistent sidekick sessions in parallel for independent, fully specified tasks. Start and resume them with background: true; omit sessionID to create a worker and retain its confirmed ID for related follow-ups. Allow only one active task per session. Delegate only fully specified coding changes, file-location lookups, exact Git/check commands, or precise websearch/webfetch retrieval jobs within supplied scope and approvals. Supply inputs, exact actions, acceptance criteria and stop conditions; keep ambiguous exploration and diagnosis here. Give workers non-conflicting scope and coordinate conflicting writes and stable-tree checks.",
  "Invoke the optional fusion-reviewer ONLY WHEN THE USER ASKS for Fusion reviewer code review, never automatically after coding or fixing. Follow User-requested code review to prepare a neutral frozen source-backed packet, then use native subagent with background: true, omitting model. Choose a retained same-change review conversation yourself with its confirmed direct-child sessionID; unrelated changes start fresh. Wait for the prior turn before continuing. Missing-evidence follow-ups may complete the requested review; a separate review or re-review requires another user request. The reviewer is read-only with skill access, not a planner or fixer. Suggest a different model family from the lead/author, without selecting or enforcing one.",
  "Optionally consult fusion-advisor sparingly for material uncertainty, difficult tradeoffs, or consequential design decisions; absence/disablement is not a blocker. Prefer subagent(agent: fusion-advisor, background: true) so you can inspect progress, message or cancel it; background: false remains available when you choose to wait. Omit sessionID and model for a new consultation. Supply the precise question, exact evidence, constraints, attempted approaches/results, options, and desired decision. The advisor can read focused source and use its own evidence-only sidekicks in parallel for independent precise locations or specified Git/test checks, but cannot code. Continue the SAME consultation with its confirmed direct-child sessionID after its prior turn finishes. New unrelated decisions start fresh. The advisor can disagree, but you own the decision and final answer.",
  "Use fusion_worker with an owned sessionID to inspect status/recent output, send a message while work runs, or cancel. To ask for progress or a quick wrap-up/summary, send an ordinary message; inspect available output and cancel separately when appropriate. Messages are queued steering, not proof the worker has read or obeyed them. Cancellation preserves output/history and existing file changes; it is not rollback. Do not poll routinely; inspect when there is a concrete need, such as a slow task or changed instructions.",
  "You may implement directly, including multi-file changes. Delegate coding only when target files/symbols, the desired change, constraints, and checks are already precise; file count alone does not require delegation. Interpret failures and specify the next action yourself rather than delegating debugging or repair loops.",
  "Keep delicate judgment in the lead session. Delegate only when it is likely to save time or cost.",
  "Stay on the lead model in this session; keep consequential decisions and final review here.",
  "## Tool boundaries",
  "Shell, grep, and glob are denied for the lead. Use bounded read for decision-relevant understanding, with explicit offset and limit of at most 350 lines per call. Delegate exact shell/Git/check commands and scoped file-location lookups, not broad discovery or file analysis. Read located source yourself and request further precise locations only when needed.",
  minimalSolutions,
].join("\n\n")

const sidekickInstructions = [
  "## Fusion coding sidekick",
  "Execute only a fully specified coding change, file-location lookup, or exact command/retrieval job. For coding, use the lead's target files/symbols, exact desired change, constraints, acceptance criteria and specified checks. Read project instructions; report changed paths, factual outcomes and blockers.",
  "Return ambiguity, consequential choices, unexpected source/Git state, or command/check failures to the caller and stop affected work. Keep analysis, diagnosis and approach selection with the caller; no autonomous debugging, repair loops or scope expansion. Do not commit without explicit user approval through the lead. Do not delegate to agents.",
  "Run only specified Git/check commands, scoped lookups, or lead-supplied websearch queries/webfetch URLs within scope and approvals. Preserve complete factual outcomes and requested raw logs/diffs or source passages; cite exact URLs without independent interpretation. Independent tools/jobs may run concurrently where supported; coordinate conflicting writes and stable-tree checks.",
  "For file-location jobs, search and read only enough to match the supplied filenames/symbols/patterns. Return only paths, line numbers/ranges and matched symbols, or factual not-found/ambiguity status. Matching locations completes the task; do not analyze behavior, trace code flow, recommend changes or return source dumps. The caller reads and interprets the located files.",
  minimalSolutions,
].join("\n\n")

const advisorInstructions = "Advise only the lead on its precise question and constraints. Read and interpret focused source yourself with explicit offset and limit of at most 350 lines. Use your own persistent fusion-sidekick sessions only for precise file-location lookups, read-only Git inspection and specified test/check commands; supply scope, exact actions and stop conditions. Independent, fully specified jobs may use separate sidekicks in parallel; allow one active task per session and coordinate checks that need a stable tree. Sidekick location jobs return paths/ranges/symbols only, which you read yourself. Keep diagnosis and judgment here; no ambiguous exploration or worker-led analysis. You and these evidence sidekicks cannot edit source, stage, commit, push or fix failures. No direct shell/web or other agents. Challenge assumptions, give a recommendation or provisional assessment, strongest risks and specific missing information. Distinguish supplied evidence from your sidekicks' checks. The lead owns consequential decisions and the final answer; no user-facing questions or unsolicited follow-ups."
const evidenceTools = new Set(["read", "grep", "glob", "shell"])
const evidenceInstructions = "This sidekick belongs to a read-only advisor/reviewer, not the lead's coding worker. Execute only precisely specified file-location lookups, read-only Git inspection or test/check commands. Return locations or factual command output directly to the caller. Preserve source and any reviewed snapshot: no source edits, staging, commits, pushes, repairs or nested agents. Requested logs/test artifacts are allowed within the brief. Report failures or ambiguity and stop affected work."

function sameModel(a: ModelRef, b: ModelRef): boolean {
  const variant = (ref: ModelRef) => ref.variant && ref.variant !== "default" ? ref.variant : undefined
  return a.providerID === b.providerID && a.id === b.id && variant(a) === variant(b)
}

function modelLabel(ref: ModelRef): string {
  const base = baseModel(ref.id)
  return withContext(`${ref.providerID}/${base.id}${ref.variant ? `#${ref.variant}` : ""}`, base.context)
}

const normalizedLabel = (ref: ModelRef) => modelLabel(ref.variant === "default" ? { ...ref, variant: undefined } : ref)

function selectedLabels(pair: Choices) {
  return { lead: modelLabel(pair.lead), sidekick: modelLabel(pair.sidekick),
    ...(pair.advisor ? { advisor: modelLabel(pair.advisor) } : {}),
    ...(pair.reviewer ? { reviewer: modelLabel(pair.reviewer) } : {}) }
}

export function parseModel(value: string): ModelRef | undefined {
  const { choice, context } = splitContext(value)
  value = choice
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  const providerID = value.slice(0, slash)
  const [id, variant, ...extra] = value.slice(slash + 1).split("#")
  if (!id || extra.length || (variant !== undefined && !variant)) return
  return { providerID, id: contextID(id, context), ...(variant ? { variant } : {}) }
}

/** Split `/fusion-models <lead> <sidekick> [advisor=<model>|advisor=off] [reviewer=<model>|reviewer=off] [task...]`. */
export function parseModelsCommand(text: string): { lead?: string; sidekick?: string; advisor?: string | null; reviewer?: string | null; task: string } {
  const tokens = /\S+/g
  const lead = tokens.exec(text)?.[0]
  const sidekickToken = tokens.exec(text)
  const sidekick = sidekickToken?.[0]
  let advisor: string | null | undefined
  let reviewer: string | null | undefined
  let prefixEnd = sidekickToken ? sidekickToken.index + sidekickToken[0].length : 0
  let next = sidekickToken ? tokens.exec(text) : null
  while (next && /^(advisor|reviewer)=/.test(next[0])) {
    const token = next[0]
    if (token.startsWith("advisor=")) advisor = token === "advisor=off" ? null : token.slice("advisor=".length)
    else reviewer = token === "reviewer=off" ? null : token.slice("reviewer=".length)
    prefixEnd = next.index + token.length
    next = tokens.exec(text)
  }
  if (next && /^(utility|adhoc)=/.test(next[0])) {
    throw new Error("Fusion supports lead, sidekick, optional advisor and reviewer; remove the obsolete role option.")
  }
  const separator = next ? text.slice(prefixEnd, next.index) : ""
  const newline = separator.indexOf("\n")
  const task = next ? text.slice(newline < 0 ? next.index : prefixEnd + newline + 1).trimEnd() : ""
  return { lead, sidekick, ...(advisor === undefined ? {} : { advisor }), ...(reviewer === undefined ? {} : { reviewer }), task }
}

export default Plugin.define({
  id: "fusion-mode",
  async setup(ctx) {
    const briefing = await loadBriefing()
    const ensureContext = await contextModels(ctx)
    const claimedChild = new Map<string, string>()
    const configuring = new Set<string>()
    const workerStatus = new Map<string, { status: string; observedAt: number }>()
    const cancellations = new Map<string, { state: string; error?: string }>()
    const watched = new Map<string, { owner: string; startedAt: number; revision: number }>()
    const pendingProgress = new Map<string, string>()
    let disposed = false
    let recentWrite = Promise.resolve()

    async function recentsFor(last?: Choices): Promise<Recents> {
      const stored = await ctx.storage.get(recentsKey) as Recents | undefined
      if (stored) return { lead: stored.lead, sidekick: stored.sidekick, advisor: stored.advisor, reviewer: stored.reviewer ?? [] }
      return {
        lead: last?.lead ? [normalizedLabel(last.lead)] : [],
        sidekick: last?.sidekick ? [normalizedLabel(last.sidekick)] : [],
        advisor: last?.advisor ? [normalizedLabel(last.advisor)] : [],
        reviewer: last?.reviewer ? [normalizedLabel(last.reviewer)] : [],
      }
    }

    async function recordRecents(input: Changes, pair: Pair, previousLast?: Choices) {
      const write = recentWrite.then(async () => {
        const recent = { ...await recentsFor(previousLast) }
        for (const role of roles) {
          const chosen = pair[role]
          if (!chosen || input[role] == null) continue
          const value = normalizedLabel(chosen)
          recent[role] = [value, ...recent[role].filter((entry) => {
            const ref = parseModel(entry)
            return !ref || !sameModel(ref, chosen)
          })].slice(0, 3)
        }
        await ctx.storage.set(recentsKey, recent)
      })
      recentWrite = write.catch(() => {})
      await write
    }

    async function pairFor(sessionID: string): Promise<Pair | undefined> {
      const value = await ctx.storage.get(key(sessionID))
      if (!value || typeof value !== "object" || Array.isArray(value)) return
      const pair = value as Record<string, unknown>
      if (!pair.lead || !pair.sidekick) return
      // Ignore retired role choices without replacing models or deleting history.
      const { utility: _retired, ...current } = pair
      return current as Pair
    }

    async function describe(pair: Choices) {
      const available = (await ctx.model.list()).data
      const label = (ref: ModelRef) => {
        const model = available.find((item) => item.providerID === ref.providerID && item.id === baseModel(ref.id).id)
        return modelLabel(!ref.variant && model?.variants.length ? { ...ref, variant: "default" } : ref)
      }
      return { lead: label(pair.lead), sidekick: label(pair.sidekick),
        ...(pair.advisor ? { advisor: label(pair.advisor) } : {}),
        ...(pair.reviewer ? { reviewer: label(pair.reviewer) } : {}) }
    }

    async function describeRecents(recent: Recents): Promise<Recents> {
      const available = (await ctx.model.list()).data
      const labels = (values: string[]) => values.map((value) => {
        const ref = parseModel(value)
        const model = ref && available.find((item) => item.providerID === ref.providerID && item.id === baseModel(ref.id).id)
        return ref ? modelLabel(!ref.variant && model?.variants.length ? { ...ref, variant: "default" } : ref) : value
      })
      return { lead: labels(recent.lead), sidekick: labels(recent.sidekick), advisor: labels(recent.advisor), reviewer: labels(recent.reviewer) }
    }

    // Only public SessionInfo.parentID links are used; a tool call ID is not a session ID.
    async function fusionTree(sessionID: string, reportedAgent?: string) {
      const caller = await ctx.session.get({ sessionID })
      if (!caller) {
        if (["fusion", "fusion-sidekick", "fusion-utility", "fusion-advisor", "fusion-reviewer"].includes(reportedAgent ?? "")) {
          throw new Error("Cannot verify Fusion session identity; retry after session metadata recovers.")
        }
        return
      }
      let root = caller
      const seen = new Set<string>()
      while (root.parentID) {
        if (seen.has(root.id)) throw new Error("Invalid Fusion session ancestry: cycle detected.")
        seen.add(root.id)
        const parent = await ctx.session.get({ sessionID: root.parentID })
        if (!parent) {
          if (["fusion", "fusion-sidekick", "fusion-utility", "fusion-advisor", "fusion-reviewer"].includes(caller.agent ?? "")) {
            throw new Error("Cannot verify Fusion session ancestry; retry when session metadata is available.")
          }
          return
        }
        root = parent
      }
      if (root.agent !== "fusion") {
        if (caller.id === root.id || !["fusion-sidekick", "fusion-utility", "fusion-advisor", "fusion-reviewer"].includes(caller.agent ?? "")) return
        if (!await pairFor(root.id)) throw new Error("Cannot verify protected Fusion child ownership under this ordinary root.")
        const sidekickOwner = caller.agent === "fusion-sidekick" ? await sidekickParent(caller, root.id) : root.id
        if (caller.agent === "fusion-sidekick" && !await isOwnedSidekick(caller.id, sidekickOwner)
          || ["fusion-advisor", "fusion-reviewer"].includes(caller.agent ?? "") && caller.parentID !== root.id) {
          throw new Error("Cannot verify protected Fusion child ownership under this ordinary root.")
        }
      }
      if (caller.agent === "fusion-utility") {
        throw new Error("Fusion utility was removed; continue this work through the persistent sidekick.")
      }
      if (reportedAgent && caller.agent !== reportedAgent) {
        throw new Error("Cannot verify Fusion caller identity; retry after session metadata recovers.")
      }
      return { root, caller }
    }

    /** Validate a user-chosen model. Thinking effort must be chosen explicitly when the model offers it. */
    async function resolve(value: string, role: Role): Promise<ModelRef> {
      const ref = parseModel(value)
      if (!ref) throw new Error(`Expected ${role} as provider/model[#thinking], got ${JSON.stringify(value)}.`)
      await ensureContext(ref)
      const models = await ctx.model.list()
      const model = models.data.find((item) => item.providerID === ref.providerID && item.id === ref.id)
      if (!model) {
        throw new Error(`The ${role} model ${modelLabel(ref)} is not available. Choose another ${role} model with /fusion.`)
      }
      if (!model.capabilities.tools || !model.capabilities.output.includes("text")) {
        throw new Error(`The ${role} model ${modelLabel(ref)} must support tools and text output. Choose another ${role} model with /fusion.`)
      }
      const variants = model.variants.map((item) => item.id)
      if (ref.variant === "default") return { providerID: ref.providerID, id: ref.id }
      if (ref.variant && !variants.includes(ref.variant)) {
        throw new Error(
          `Thinking effort ${ref.variant} is not available for ${modelLabel(ref)}. ` +
          `Choose one of: default, ${variants.join(", ")}.`,
        )
      }
      if (!ref.variant && variants.length) {
        throw new Error(
          `Choose the ${role} thinking effort for ${modelLabel(ref)}: ` +
          `add #default or one of #${variants.join(", #")}.`,
        )
      }
      return ref
    }

    /** Fail when a stored, user-chosen model has since become unavailable. */
    async function requireAvailable(ref: ModelRef, role: Role): Promise<void> {
      await ensureContext(ref)
      const models = await ctx.model.list()
      const model = models.data.find((item) => item.providerID === ref.providerID && item.id === ref.id)
      const variantOk = !ref.variant || ref.variant === "default" || model?.variants.some((item) => item.id === ref.variant)
      if (!model || !variantOk || !model.capabilities.output.includes("text") || !model.capabilities.tools) {
        throw new Error(`The ${role} model ${modelLabel(ref)} chosen by the user is not available. ${chooseAgain}`)
      }
    }

    async function ownedReviewer(sessionID: string, root: string) {
      const child = await ctx.session.get({ sessionID })
      const saved = await ctx.storage.get(reviewKey(sessionID)) as { root?: string } | undefined
      if (!child || child.agent !== "fusion-reviewer" || child.parentID !== root || saved?.root !== root) {
        throw new Error("Reviewer sessionID must identify a confirmed direct review child of this Fusion root.")
      }
    }

    async function sidekickParent(child: { parentID?: string }, root: string) {
      if (child.parentID === root) return root
      if (!child.parentID) throw new Error("Cannot verify Fusion evidence sidekick ownership.")
      const parent = await ctx.session.get({ sessionID: child.parentID })
      if (parent?.agent === "fusion-reviewer") await ownedReviewer(child.parentID, root)
      else if (parent?.agent !== "fusion-advisor" || parent.parentID !== root) throw new Error("Cannot verify Fusion evidence sidekick ownership.")
      return child.parentID
    }

    async function isOwnedSidekick(sessionID: string, owner: string) {
      const child = await ctx.session.get({ sessionID })
      if (child?.agent !== "fusion-sidekick" || child.parentID !== owner) return false
      const recorded = await ctx.storage.get(sidekickOwnerKey(sessionID))
      // Existing singleton histories remain resumable without rewriting them.
      return recorded === owner || recorded === undefined && await ctx.storage.get(childKey(owner)) === sessionID
    }

    async function ownedWorker(callerID: string, agent: string, sessionID: string) {
      const tree = await fusionTree(callerID, agent)
      if (!tree || !await pairFor(tree.root.id)) throw new Error("Cannot verify Fusion worker controller.")
      const lead = tree.caller.id === tree.root.id && tree.caller.agent === "fusion"
      const evidenceCaller = ["fusion-advisor", "fusion-reviewer"].includes(tree.caller.agent ?? "") && tree.caller.parentID === tree.root.id
      if (!lead && !evidenceCaller) throw new Error("Only the Fusion lead or an advisor/reviewer can control their own workers.")
      if (tree.caller.agent === "fusion-reviewer") await ownedReviewer(callerID, tree.root.id)
      const child = await ctx.session.get({ sessionID })
      if (!child || child.parentID !== callerID) throw new Error("Worker must be a direct child owned by this caller.")
      if (child.agent === "fusion-sidekick") {
        if (!await isOwnedSidekick(sessionID, callerID)) throw new Error("Cannot verify owned sidekick.")
      } else if (lead && child.agent === "fusion-reviewer") await ownedReviewer(sessionID, tree.root.id)
      else if (!(lead && child.agent === "fusion-advisor")) throw new Error("Worker role is not controlled by this caller.")
      return { ...tree, child }
    }

    async function workerSnapshot(sessionID: string) {
      const child = await ctx.session.get({ sessionID })
      const messages = await ctx.session.context({ sessionID })
      const output: string[] = []
      for (const message of messages.slice(-12)) {
        if (message.type !== "assistant") continue
        for (const part of message.content) {
          if (part.type === "text") output.push(part.text)
          if (part.type !== "tool") continue
          output.push(`${part.name}: ${part.state.status}`)
          if (part.state.status === "running") output.push(JSON.stringify(part.state.metadata))
          if (part.state.status === "completed" || part.state.status === "error") {
            for (const content of part.state.content ?? []) if (content.type === "text") output.push(content.text)
            if (part.state.status === "error") output.push(JSON.stringify(part.state.error))
          }
        }
      }
      const text = output.join("\n")
      return { sessionID, ...workerStatus.get(sessionID), status: workerStatus.get(sessionID)?.status ?? "unknown",
        lastOutcome: child?.outcome, cancellation: cancellations.get(sessionID),
        recentOutput: text.slice(-16000), truncated: messages.length > 12 || text.length > 16000 }
    }

    function requestCancel(sessionID: string) {
      if (cancellations.get(sessionID)?.state === "requested") return
      const result: { state: string; error?: string } = { state: "requested" }
      cancellations.set(sessionID, result)
      // Do not make the controller wait for a tool/provider that is slow to abort.
      void ctx.session.interrupt({ sessionID, resume: false }).then(reply => {
        result.state = reply.interrupted ? "interrupted" : "idle"
      }, error => { result.state = "failed"; result.error = error instanceof Error ? error.message : String(error) })
    }

    function forgetWorker(id: string) {
      const worker = watched.get(id)
      if (worker) pendingProgress.delete(worker.owner)
      watched.delete(id)
      pendingProgress.delete(id)
      if (!watched.size) supervision.stop()
    }

    const hasWorkers = (owner: string) => [...watched.values()].some(worker => worker.owner === owner)

    async function progressOwner(owner: string) {
      if (disposed || cancellations.has(owner) && cancellations.get(owner)?.state !== "failed") return false
      const session = await ctx.session.get({ sessionID: owner })
      if (!session || !["fusion", "fusion-advisor", "fusion-reviewer"].includes(session.agent ?? "")) return false
      if (session.agent !== "fusion" && !watched.has(owner)) return false
      for (const [id, worker] of watched) {
        if (worker.owner !== owner) continue
        try {
          const { root } = await ownedWorker(owner, session.agent!, id)
          if (!disposed && watched.get(id) === worker && root.agent === "fusion") return true
        } catch { /* Missing ownership never authorizes delivery. */ }
      }
      return false
    }

    const supervision = createSupervisor({
      sample: async () => {
        const rows = []
        for (const [id, worker] of watched) {
          const owner = await ctx.session.get({ sessionID: worker.owner })
          if (disposed || watched.get(id) !== worker) continue
          if (!owner || !await progressOwner(worker.owner)) { forgetWorker(id); continue }
          try { await ownedWorker(worker.owner, owner.agent!, id) }
          catch { forgetWorker(id); continue }
          const state = workerStatus.get(id)?.status
          if (state === "idle" && !hasWorkers(id)) { forgetWorker(id); continue }
          const messages = await ctx.session.context({ sessionID: id })
          if (disposed || watched.get(id) !== worker) continue
          const recent = messages.slice(-12).filter(message => message.type === "assistant")
          const last = recent.at(-1)
          const tool = last && [...last.content].reverse().find(part => part.type === "tool")
          const cancelling = cancellations.has(id) && cancellations.get(id)?.state !== "failed"
          rows.push({ id, owner: worker.owner, startedAt: worker.startedAt,
            status: cancelling ? "cancellation pending" : state === "busy" ? "running" : state === "idle" ? "waiting for workers" : state ?? "unknown",
            activity: tool?.type === "tool" ? `${tool.name}: ${tool.state.status}` : recent.length ? "responding" : "starting",
            version: state ? `${worker.revision}:${JSON.stringify(recent)}` : undefined,
            requestable: state === "busy" && !cancelling })
        }
        return rows
      },
      notify: async (owner: string, text: string) => {
        if (!await progressOwner(owner) || disposed) return false
        if (workerStatus.get(owner)?.status !== "idle") {
          // Replace, rather than queue, summaries while the owner is busy.
          pendingProgress.set(owner, text)
          return false
        }
        pendingProgress.delete(owner)
        await ctx.session.synthetic({ sessionID: owner, text, description: "Fusion worker progress", delivery: "queue", resume: true })
        return true
      },
      request: async (row: { id: string; owner: string }, text: string) => {
        const worker = watched.get(row.id)
        if (!worker || worker.owner !== row.owner || !await progressOwner(row.owner)) return false
        const owner = await ctx.session.get({ sessionID: row.owner })
        if (!owner) return false
        await ownedWorker(row.owner, owner.agent!, row.id)
        if (disposed || watched.get(row.id) !== worker || workerStatus.get(row.id)?.status !== "busy"
          || cancellations.has(row.id) && cancellations.get(row.id)?.state !== "failed") return false
        await ctx.session.synthetic({ sessionID: row.id, text, description: "Fusion progress request", delivery: "steer", resume: false })
        return true
      },
    })

    function watchWorker(id: string, owner: string) {
      if (disposed || watched.has(id)) return
      workerStatus.delete(id)
      watched.set(id, { owner, startedAt: Date.now(), revision: 0 })
      supervision.start()
    }

    await ctx.tool.transform(editor => editor.add({
      name: "fusion_worker",
      description: "Inspect status and recent output, message, or cancel one owned Fusion worker. Messages steer running work; use ordinary text to request progress or wrap-up. Cancellation preserves history and files. No model overrides. Status is last observed (unknown if not observed); cancellation requested is not guaranteed termination.",
      input: { type: "object", properties: { action: { type: "string", enum: ["status", "message", "cancel"] },
        sessionID: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 } },
        required: ["action", "sessionID"], additionalProperties: false },
      options: { permission: "fusion_worker" },
      execute: async (value, context) => {
        const input = value as { action?: string; sessionID?: string; message?: string } | null
        if (!input || !["status", "message", "cancel"].includes(input.action ?? "")
          || typeof input.sessionID !== "string" || !input.sessionID.trim()
          || Object.keys(input).some(key => !["action", "sessionID", "message"].includes(key))
          || (input.action === "message" ? typeof input.message !== "string" || !input.message.trim() : input.message !== undefined)) {
          throw new Error("Supply action status/message/cancel and one worker sessionID; message text is required only for message.")
        }
        const sessionID = input.sessionID
        const { root, child } = await ownedWorker(context.sessionID, context.agent, sessionID)
        let delivery: string | undefined
        const stopped: string[] = []
        const unconfirmed: string[] = []
        if (input.action === "message") {
          if (root.agent !== "fusion") throw new Error("Fusion is off; live steering is disabled.")
          if (workerStatus.get(sessionID)?.status === "idle" || cancellations.has(sessionID) && cancellations.get(sessionID)?.state !== "failed") delivery = "not sent: worker idle or cancellation requested"
          else {
            await ctx.session.synthetic({ sessionID, text: input.message!, delivery: "steer", resume: false,
              description: "Fusion caller message" })
            delivery = "queued; consumed at a steering boundary if still running; does not restart an idle worker"
          }
        }
        if (input.action === "cancel") {
          requestCancel(sessionID)
          stopped.push(sessionID)
          if (["fusion-advisor", "fusion-reviewer"].includes(child.agent ?? "")) {
            const ids = new Set<string>()
            const legacy = await ctx.storage.get(childKey(sessionID))
            if (typeof legacy === "string") ids.add(legacy)
            let after: string | undefined
            do {
              const page = await ctx.storage.scan({ prefix: "sidekick-owner/", after })
              for (const entry of page.entries) if (entry.value === sessionID) ids.add(entry.key.slice("sidekick-owner/".length))
              after = page.next
            } while (after)
            for (const id of ids) {
              if (await isOwnedSidekick(id, sessionID)) { requestCancel(id); stopped.push(id) }
              else unconfirmed.push(id)
            }
          }
        }
        return { content: JSON.stringify({ ...await workerSnapshot(sessionID), ...(delivery ? { delivery } : {}),
          ...(stopped.length ? { cancellations: stopped.map(id => ({ sessionID: id, ...cancellations.get(id) })), unconfirmedDescendants: unconfirmed } : {}) }) }
      },
    }))

    async function requireReviewerSetup(rootID: string, reviewer: ModelRef) {
      const root = await ctx.session.get({ sessionID: rootID })
      const current = await pairFor(rootID)
      if (configuring.has(rootID) || !root || root.parentID || root.agent !== "fusion"
        || !current?.reviewer || !sameModel(current.reviewer, reviewer)) {
        throw new Error("Fusion reviewer setup changed or delegation is off; reapply the user choices before invoking review.")
      }
      if (!root.model || !sameModel(root.model, current.lead)) {
        throw new Error("Reapply the user-selected lead model and effort with /fusion before invoking review.")
      }
    }

    type Changes = { lead?: string; sidekick?: string; advisor?: string | null; reviewer?: string | null }

    async function selectModels(input: Changes, previous?: Pair): Promise<Pair> {
      if ((!input.lead && !previous?.lead) || (!input.sidekick && !previous?.sidekick)) {
        throw new Error("Choose lead and sidekick models before applying Fusion setup.")
      }
      const lead = input.lead === undefined ? previous!.lead : await resolve(input.lead, "lead")
      const sidekick = input.sidekick === undefined ? previous!.sidekick : await resolve(input.sidekick, "sidekick")
      if (sameModel({ ...lead, id: baseModel(lead.id).id }, { ...sidekick, id: baseModel(sidekick.id).id })) throw new Error("Choose different models for lead and sidekick.")
      const advisor = input.advisor === undefined ? previous?.advisor : input.advisor === null ? undefined : await resolve(input.advisor, "advisor")
      const reviewer = input.reviewer === undefined ? previous?.reviewer : input.reviewer === null ? undefined : await resolve(input.reviewer, "reviewer")
      for (const [role, ref] of Object.entries({ lead, sidekick, advisor, reviewer }) as Array<[Role, ModelRef | undefined]>) {
        if (ref) await requireAvailable(ref, role)
      }
      const pair = { ...previous, lead, sidekick, ...(advisor ? { advisor } : {}), ...(reviewer ? { reviewer } : {}) }
      if (input.advisor === null) delete pair.advisor
      if (input.reviewer === null) delete pair.reviewer
      return pair
    }

    async function configure(sessionID: string, input: Changes): Promise<Pair> {
      if (configuring.has(sessionID)) throw new Error("Fusion setup is already being applied; wait before applying another setup.")
      configuring.add(sessionID)
      try {
        const pair = await selectModels(input, await pairFor(sessionID))
        const session = await ctx.session.get({ sessionID })
        if (!session) throw new Error("Session not found")
        const previousLast = await ctx.storage.get(lastKey) as Choices | undefined
        if (session.agent && session.agent !== "fusion") {
          const agents = (await ctx.agent.list()).data
          if (agents.some((agent) => agent.id === session.agent && (agent.mode === "primary" || agent.mode === "all"))) {
            await ctx.storage.set(previousKey(sessionID), session.agent)
          }
        }
        if (!session.model || !sameModel(session.model, pair.lead)) {
          await ctx.session.switchModel({ sessionID, model: pair.lead })
        }
        await ctx.session.switchAgent({ sessionID, agent: "fusion" })
        await ctx.storage.set(key(sessionID), pair)
        await ctx.storage.set(lastKey, { lead: pair.lead, sidekick: pair.sidekick,
          ...(pair.advisor ? { advisor: pair.advisor } : {}), ...(pair.reviewer ? { reviewer: pair.reviewer } : {}) })
        await recordRecents(input, pair, previousLast)
        return pair
      } finally {
        configuring.delete(sessionID)
      }
    }

    // The only ways to set models are user actions: the /fusion picker (RPC) and
    // the /fusion-models command below. No model-callable tool can configure them.
    await ctx.rpc.register(FusionRPC, {
      inspect: async (input, rpcContext) => {
        const { sessionID } = input as { sessionID?: string }
        if (sessionID && !(await ctx.session.get({ sessionID }))) return rpcContext.error("invalid_session", "Session not found", {})
        const current = sessionID ? await pairFor(sessionID) : undefined
        const session = sessionID ? await ctx.session.get({ sessionID }) : undefined
        const previous = sessionID ? await ctx.storage.get(previousKey(sessionID)) : undefined
        const agents = typeof previous === "string" ? (await ctx.agent.list()).data : []
        const availablePrevious = agents.some((agent) => agent.id === previous && agent.id !== "fusion"
          && (agent.mode === "primary" || agent.mode === "all")) ? previous : undefined
        const last = await ctx.storage.get(lastKey) as Choices | undefined
        return { active: !!current && session?.agent === "fusion", ...(availablePrevious ? { previous: availablePrevious } : {}),
          ...(current ? { current: await describe(current) } : {}),
          ...(last?.lead && last.sidekick ? { last: await describe(last) } : {}),
          recent: await describeRecents(await recentsFor(last)) }
      },
      validate: async (input, rpcContext) => {
        try {
          const pair = await selectModels(input as Changes)
          return selectedLabels(pair)
        } catch (error) {
          return rpcContext.error("invalid_models", error instanceof Error ? error.message : "Invalid Fusion models", {})
        }
      },
      configure: async (input, rpcContext) => {
        const { sessionID, ...changes } = input as { sessionID: string } & Changes
        const session = await ctx.session.get({ sessionID })
        if (!session) return rpcContext.error("invalid_session", "Session not found", {})
        try {
          const pair = await configure(sessionID, changes)
          return selectedLabels(pair)
        } catch (error) {
          return rpcContext.error("invalid_models", error instanceof Error ? error.message : "Invalid Fusion models", {})
        }
      },
      disable: async (input, rpcContext) => {
        const { sessionID, agent } = input as { sessionID: string; agent?: string }
        if (configuring.has(sessionID)) return rpcContext.error("invalid_session", "Fusion setup is already being changed; wait before turning it off.", {})
        configuring.add(sessionID)
        try {
          const session = await ctx.session.get({ sessionID })
          if (!session || session.parentID || session.agent !== "fusion" || !await pairFor(sessionID)) {
            return rpcContext.error("invalid_session", "An active Fusion root session is required.", {})
          }
          const previous = await ctx.storage.get(previousKey(sessionID))
          const target = agent ?? previous
          const agents = (await ctx.agent.list()).data
          if (typeof target !== "string" || target === "fusion"
            || !agents.some((item) => item.id === target && (item.mode === "primary" || item.mode === "all"))) {
            return rpcContext.error("invalid_agent", "Choose an available non-Fusion primary agent to turn Fusion off.", {})
          }
          if (!session.model) return rpcContext.error("invalid_session", "Cannot preserve the current model: session model is unavailable.", {})
          const model = { ...session.model }
          try {
            await ctx.session.switchAgent({ sessionID, agent: target })
            const after = await ctx.session.get({ sessionID })
            if (!after || after.agent !== target) throw new Error("Agent switch could not be confirmed.")
            if (!after.model || !sameModel(after.model, model)) {
              await ctx.session.switchModel({ sessionID, model })
              const restored = await ctx.session.get({ sessionID })
              if (!restored?.model || !sameModel(restored.model, model)) throw new Error("Current model was not preserved.")
            }
            return { agent: target }
          } catch (error) {
            return rpcContext.error("invalid_session", `Could not safely finish turning Fusion off: ${String(error)}`, {})
          }
        } finally {
          configuring.delete(sessionID)
        }
      },
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "fusion-models",
        description: "Choose Fusion models/effort/context: /fusion-models <lead> <sidekick> [advisor=<model>|advisor=off] [reviewer=<model>|reviewer=off] [task]; append @100k for a local context budget",
        execute: async ({ sessionID, prompt, delivery }) => {
          const { lead, sidekick, advisor, reviewer, task } = parseModelsCommand(prompt.text)
          if (!lead || !sidekick) {
            throw new Error(
              "Usage: /fusion-models <lead> <sidekick> [advisor=<provider/model#thinking>|advisor=off] [reviewer=<provider/model#thinking>|reviewer=off] [task], each model as provider/model#thinking " +
              "(for example openai/gpt-6-sol#xhigh@100k; omit @100k for native context). Use /fusion to pick from a list.",
            )
          }
          const pair = await configure(sessionID, { lead, sidekick, advisor, reviewer })
          const ready = `Fusion models chosen by the user: lead ${modelLabel(pair.lead)}, sidekick ${modelLabel(pair.sidekick)}${pair.advisor ? `, optional advisor ${modelLabel(pair.advisor)}` : ""}${pair.reviewer ? `, optional reviewer ${modelLabel(pair.reviewer)}` : ""}.`
          if (task) await ctx.session.prompt({ ...prompt, sessionID, text: `${ready}\n\n${task}`, delivery })
        },
      })
    })

    // Native subagent accepts background (default false) and optional sessionID.
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool === "fusion_worker") {
        const sessionID = (event.input as { sessionID?: string } | null)?.sessionID
        if (typeof sessionID !== "string") throw new Error("Supply an owned worker sessionID.")
        await ownedWorker(event.sessionID, event.agent, sessionID)
        return
      }
      if (event.tool === "subagent" && ["fusion-sidekick", "fusion-utility", "fusion-advisor", "fusion-reviewer"].includes((event.input as { agent?: string } | null)?.agent ?? "")) {
        const caller = await ctx.session.get({ sessionID: event.sessionID })
        if (caller && !caller.parentID && caller.agent !== "fusion" && await pairFor(caller.id)) {
          throw new Error("Fusion delegation is off for this root; enable saved Fusion setup with /fusion before starting protected workers.")
        }
      }
      if (event.tool !== "subagent" && event.tool !== "websearch" && event.tool !== "webfetch"
        && event.agent !== "fusion-advisor" && event.agent !== "fusion-utility" && event.agent !== "fusion-reviewer"
        && !(event.agent === "fusion" && ["read", "shell", "grep", "glob"].includes(event.tool))
        && event.agent !== "fusion-sidekick") return
      const tree = await fusionTree(event.sessionID, event.agent)
      if (!tree) return
      const role = tree.caller.agent
      if (role === "fusion-sidekick" && tree.caller.parentID !== tree.root.id) {
        const owner = await sidekickParent(tree.caller, tree.root.id)
        if (!await isOwnedSidekick(tree.caller.id, owner) || !evidenceTools.has(event.tool)) {
          throw new Error("Fusion evidence sidekick permits only reads, location lookups and specified shell checks; no edits or further delegation.")
        }
        return
      }
      if (role === "fusion-reviewer" || role === "fusion-advisor") {
        if (role === "fusion-reviewer") await ownedReviewer(tree.caller.id, tree.root.id)
        else if (tree.caller.parentID !== tree.root.id) throw new Error("Advisor must be a direct Fusion lead child.")
        if (role === "fusion-reviewer" && event.tool === "skill") return
        if (event.tool === "read") {
          const input = event.input as { offset?: unknown; limit?: unknown } | null
          if (!Number.isSafeInteger(input?.offset) || !Number.isSafeInteger(input?.limit)
            || (input!.offset as number) < 0 || (input!.limit as number) < 1 || (input!.limit as number) > 350) {
            throw new Error(`Fusion ${role === "fusion-reviewer" ? "reviewer" : "advisor"} read requires explicit offset and limit of at most 350 lines.`)
          }
          return
        }
        if (event.tool !== "subagent") throw new Error("Fusion advisor/reviewer is read-only: use bounded read or its evidence sidekick; no direct execution or edits.")
      }
      if (["shell", "grep", "glob"].includes(event.tool)) {
        if (role === "fusion" && tree.caller.id === tree.root.id) {
          throw new Error("Fusion lead cannot use shell, grep, or glob. Delegate exact Git/check commands or scoped file-location lookups to fusion-sidekick; read and interpret the located source yourself.")
        }
        return
      }
      if (event.tool === "read") {
        if (tree.caller.id !== tree.root.id) return
        const input = event.input as { offset?: unknown; limit?: unknown } | null
        if (!Number.isSafeInteger(input?.offset) || !Number.isSafeInteger(input?.limit)
          || (input!.offset as number) < 0 || (input!.limit as number) < 1 || (input!.limit as number) > 350) {
          throw new Error("Fusion lead read requires explicit offset and limit of at most 350 lines. Use focused ranges to read and interpret source yourself; sidekick file lookups return locations only.")
        }
        return
      }
      if (event.tool !== "subagent" && event.tool !== "websearch" && event.tool !== "webfetch") return
      if (event.tool === "websearch" || event.tool === "webfetch") {
        if (role !== "fusion-sidekick") {
          throw new Error(`Route native ${event.tool} through the persistent fusion-sidekick.`)
        }
        return
      }
      const input = event.input as { agent?: string; sessionID?: string; model?: string; background?: boolean; prompt?: string } | null
      if (!input || typeof input.agent !== "string") throw new Error("Choose an explicit Fusion subagent role.")
      const lead = tree.caller.id === tree.root.id && role === "fusion"
      const evidenceCaller = ["fusion-reviewer", "fusion-advisor"].includes(role ?? "") && input.agent === "fusion-sidekick"
      if (!(lead && ["fusion-sidekick", "fusion-advisor", "fusion-reviewer"].includes(input.agent) || evidenceCaller)) {
        throw new Error("Fusion delegation allows lead → sidekick, advisor or user-requested reviewer, and advisor/reviewer → evidence sidekick only.")
      }
      if (["model", "reasoning_effort", "context_tier", "context", "contextWindow", "contextTokens", "contextBudget"].some((key) => Object.hasOwn(input, key))) {
        throw new Error(`Do not override the user-selected subagent model, effort, or context. ${chooseAgain}`)
      }
      const pair = await pairFor(tree.root.id)
      if (!pair) throw new Error(`No Fusion models are configured for this session. ${chooseAgain}`)
      if (evidenceCaller) {
        const cancellation = cancellations.get(tree.caller.id)
        if (cancellation && cancellation.state !== "failed") throw new Error("Caller cancellation was requested; do not start further evidence work.")
        const ref = role === "fusion-reviewer" ? pair.reviewer : pair.advisor
        if (!ref || tree.root.agent !== "fusion") throw new Error("Evidence caller is unconfigured or Fusion is off; reapply Fusion setup.")
        await requireAvailable(ref, role === "fusion-reviewer" ? "reviewer" : "advisor")
        if (role === "fusion-reviewer") await requireReviewerSetup(tree.root.id, ref)
        if (!tree.caller.model || !sameModel(tree.caller.model, ref)) throw new Error("Evidence caller model no longer matches the user-selected setup.")
      }
      if (input.agent === "fusion-reviewer") {
        if (configuring.has(tree.root.id)) throw new Error("Fusion setup is being applied; wait before invoking review.")
        if (input.background !== true) throw new Error("fusion-reviewer requires background: true.")
        if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Supply the source-backed review packet as the reviewer prompt.")
        if (!pair.reviewer) throw new Error("Reviewer is optional and unconfigured; ask the user to choose its model and effort with /fusion.")
        await requireAvailable(pair.reviewer, "reviewer")
        if (Object.hasOwn(input, "sessionID")) {
          if (typeof input.sessionID !== "string" || !input.sessionID) throw new Error("Specify a confirmed review sessionID.")
          await ownedReviewer(input.sessionID, tree.root.id)
          // Native wait serializes a same-change continuation with its prior turn.
          await ctx.session.wait({ sessionID: input.sessionID })
        }
        await requireReviewerSetup(tree.root.id, pair.reviewer)
        return
      }
      if (input.agent === "fusion-advisor") {
        if (!pair.advisor) throw new Error("fusion-advisor is not configured; skip consultation or ask the user to choose a model and effort with /fusion.")
        await requireAvailable(pair.advisor, "advisor")
        if (Object.hasOwn(input, "sessionID")) {
          if (typeof input.sessionID !== "string" || !input.sessionID) throw new Error("Specify a known advisor sessionID for the same consultation.")
          const previous = await ctx.session.get({ sessionID: input.sessionID })
          if (!previous || previous.agent !== "fusion-advisor" || previous.parentID !== tree.root.id) {
            throw new Error("Advisor sessionID must identify a direct advisor child of this Fusion root; omit it for a new consultation.")
          }
          await ctx.session.wait({ sessionID: input.sessionID })
        }
        return
      }
      if (input.background !== true) throw new Error("fusion-sidekick requires background: true.")
      await requireAvailable(pair.sidekick, "sidekick")
      const owner = evidenceCaller ? tree.caller.id : tree.root.id
      const previous = role === "fusion-reviewer" ? await ctx.storage.get(childKey(owner)) : undefined
      if (typeof previous === "string") {
        if (Object.hasOwn(input, "sessionID") && input.sessionID !== previous) {
          throw new Error(`Resume Fusion sidekick session ${previous} rather than replacing its conversation.`)
        }
        input.sessionID = previous
      }
      if (Object.hasOwn(input, "sessionID")) {
        if (typeof input.sessionID !== "string" || !input.sessionID || !await isOwnedSidekick(input.sessionID, owner)) {
          throw new Error("Sidekick sessionID must identify a confirmed worker owned by this caller; omit it to start a new worker.")
        }
        await ctx.session.wait({ sessionID: input.sessionID })
      }
    })

    // Preserve OpenCode's normal coding prompt; a nonempty agent.system would replace it.
    await ctx.session.hook("context", async (event) => {
      const progress = pendingProgress.get(event.sessionID)
      if (progress) {
        pendingProgress.delete(event.sessionID)
        if (await progressOwner(event.sessionID) && !disposed) event.system.push({ type: "text", text: progress })
      }
      if (!["fusion", "fusion-advisor", "fusion-reviewer"].includes(event.agent)) delete event.tools?.fusion_worker
      if (event.agent === "fusion-sidekick") {
        const tree = await fusionTree(event.sessionID, event.agent)
        event.system.push({ type: "text", text: sidekickInstructions })
        if (tree) {
          event.system.push({ type: "text", text: briefing.completion })
          delete event.tools?.subagent
          if (tree.caller.parentID !== tree.root.id) {
            const owner = await sidekickParent(tree.caller, tree.root.id)
            if (!await isOwnedSidekick(tree.caller.id, owner)) throw new Error("Cannot verify Fusion evidence sidekick ownership.")
            event.system.push({ type: "text", text: evidenceInstructions })
            for (const tool of Object.keys(event.tools ?? {})) if (!evidenceTools.has(tool)) delete event.tools[tool]
          }
        }
        return
      }
      if (event.agent === "fusion-utility") {
        await fusionTree(event.sessionID, event.agent)
        return
      }
      if (event.agent === "fusion-advisor") {
        const tree = await fusionTree(event.sessionID, event.agent)
        if (!tree || tree.caller.parentID !== tree.root.id) throw new Error("Advisor must be a direct Fusion lead child.")
        event.system.push({ type: "text", text: advisorInstructions })
        event.system.push({ type: "text", text: "Use native subagent(agent: fusion-sidekick, background: true) only for precise evidence jobs. Omit sessionID for each independent worker, retain each confirmed ID for related follow-ups, and never borrow another caller's worker." })
        event.system.push({ type: "text", text: "Act on automatic updates from your evidence workers; use fusion_worker for detail or intervention. Quiet activity alone is not a hang. Keep progress replies concise, including the detail needed to understand progress and blockers." })
        for (const tool of Object.keys(event.tools ?? {})) if (!["read", "subagent", "fusion_worker"].includes(tool)) delete event.tools[tool]
        return
      }
      if (event.agent === "fusion-reviewer") {
        const tree = await fusionTree(event.sessionID, event.agent)
        if (!tree) throw new Error("Reviewer must be a direct Fusion lead child.")
        await ownedReviewer(event.sessionID, tree.root.id)
        event.system.push({ type: "text", text: briefing.reviewer })
        event.system.push({ type: "text", text: "Use native subagent(agent: fusion-sidekick, background: true) only for precise evidence jobs. Retain the returned reviewer-owned sidekick sessionID for follow-ups, never borrow the lead's worker. You have no coding authority." })
        event.system.push({ type: "text", text: "Use fusion_worker only for your own evidence sidekick: inspect status, send a steering message, or cancel while it runs. Wrap-up is an ordinary message, not a separate task." })
        for (const tool of Object.keys(event.tools ?? {})) if (!["read", "skill", "subagent", "fusion_worker"].includes(tool)) delete event.tools[tool]
        return
      }
      if (event.agent !== "fusion") return
      const tree = await fusionTree(event.sessionID, event.agent)
      if (!tree || tree.caller.id !== tree.root.id) return
      event.system.push({ type: "text", text: leadInstructions })
      event.system.push({ type: "text", text: briefing.full })
      delete event.tools?.websearch
      delete event.tools?.webfetch
      const pair = await pairFor(event.sessionID)
      if (!pair) {
        event.system.push({
          type: "text",
          text: `No Fusion models are configured for this session. Do no other work: ${chooseAgain}`,
        })
      } else if (!sameModel(event.model, pair.lead)) {
        event.system.push({
          type: "text",
          text: `This session is not running on the lead model the user chose (${modelLabel(pair.lead)}). Do no other work: tell the user and ${chooseAgain.charAt(0).toLowerCase()}${chooseAgain.slice(1)}`,
        })
      } else {
        event.system.push({
          type: "text",
          text: `Fusion models chosen by the user: lead ${modelLabel(pair.lead)}, sidekick ${modelLabel(pair.sidekick)}${pair.advisor ? `; optional advisor ${modelLabel(pair.advisor)}` : "; advisor disabled/unconfigured; continue normal work"}${pair.reviewer ? `; optional user-requested reviewer ${modelLabel(pair.reviewer)}` : "; reviewer disabled/unconfigured; continue normal work"}.`,
        })
      }
    })

    // Built-in subagents inherit the parent's model. Correct that before the child prompt
    // is admitted, when model resolution has not yet occurred. Never fall back to the
    // inherited model: without a user-chosen, available sidekick the delegation fails.
    await ctx.session.hook("prompt", async (event) => {
      const child = await ctx.session.get({ sessionID: event.sessionID })
      if (!child || !child.parentID || typeof child.agent !== "string"
        || !["fusion-sidekick", "fusion-utility", "fusion-advisor", "fusion-reviewer"].includes(child.agent)) return
      const tree = await fusionTree(child.id)
      if (!tree) return
      if (cancellations.get(child.id)?.state === "requested") throw new Error("Worker cancellation is still pending; wait before resuming it.")
      const ownerCancellation = cancellations.get(child.parentID)
      if (ownerCancellation && ownerCancellation.state !== "failed") throw new Error("Worker owner cancellation was requested; no further child prompts are admitted.")
      cancellations.delete(child.id)
      if (child.parentID !== tree.root.id && child.agent !== "fusion-sidekick") {
        throw new Error("Invalid Fusion delegation ancestry; workers must be direct lead children.")
      }
      const pair = await pairFor(tree.root.id)
      if (!pair) throw new Error(`No Fusion models are configured for this session. ${chooseAgain}`)
      if (child.agent === "fusion-reviewer") {
        if (configuring.has(tree.root.id)) throw new Error("Fusion setup is being applied; wait before invoking review.")
        if (!pair.reviewer) throw new Error("Reviewer is unconfigured; ask the user to choose its model and effort.")
        if (await ctx.storage.get(reviewKey(child.id))) await ownedReviewer(child.id, tree.root.id)
        await requireAvailable(pair.reviewer, "reviewer")
        await requireReviewerSetup(tree.root.id, pair.reviewer)
        if (!child.model || !sameModel(child.model, pair.reviewer)) await ctx.session.switchModel({ sessionID: child.id, model: pair.reviewer })
        const after = await ctx.session.get({ sessionID: child.id })
        if (after?.agent !== "fusion-reviewer" || after.parentID !== tree.root.id || !after.model || !sameModel(after.model, pair.reviewer)) {
          throw new Error("Reviewer ownership or model could not be confirmed; reapply the user choices before invoking review.")
        }
        await requireReviewerSetup(tree.root.id, pair.reviewer)
        await ctx.storage.set(reviewKey(child.id), { root: tree.root.id })
        await requireReviewerSetup(tree.root.id, pair.reviewer)
        watchWorker(child.id, child.parentID)
        return
      }
      if (child.agent === "fusion-advisor") {
        if (!pair.advisor) throw new Error("fusion-advisor is not configured; skip consultation or ask the user to choose a model and effort with /fusion.")
        await requireAvailable(pair.advisor, "advisor")
        if (!child.model || !sameModel(child.model, pair.advisor)) {
          await ctx.session.switchModel({ sessionID: child.id, model: pair.advisor })
        }
        watchWorker(child.id, child.parentID)
        return
      }
      await requireAvailable(pair.sidekick, "sidekick")
      const parent = await sidekickParent(child, tree.root.id)
      let singleton = false
      if (parent !== tree.root.id) {
        const caller = await ctx.session.get({ sessionID: parent })
        singleton = caller?.agent === "fusion-reviewer"
        if (singleton) {
          if (!pair.reviewer) throw new Error("Reviewer is unconfigured; reapply Fusion setup.")
          await requireReviewerSetup(tree.root.id, pair.reviewer)
        } else if (!pair.advisor || tree.root.agent !== "fusion") throw new Error("Advisor is unconfigured or Fusion is off; reapply Fusion setup.")
      }
      const previous = singleton ? await ctx.storage.get(childKey(parent)) : undefined
      const owner = singleton ? (typeof previous === "string" ? previous : claimedChild.get(parent)) : undefined
      if (owner && owner !== child.id) {
        throw new Error(`Resume Fusion sidekick session ${owner} instead of starting a new one.`)
      }
      if (singleton && !owner) claimedChild.set(parent, child.id)
      try {
        const recorded = await ctx.storage.get(sidekickOwnerKey(child.id))
        if (recorded !== undefined && recorded !== parent) throw new Error("Cannot verify Fusion sidekick ownership.")
        if (!child.model || !sameModel(child.model, pair.sidekick)) {
          await ctx.session.switchModel({ sessionID: event.sessionID, model: pair.sidekick })
        }
        if (singleton) {
          if (typeof previous !== "string") await ctx.storage.set(childKey(parent), child.id)
        } else await ctx.storage.set(sidekickOwnerKey(child.id), parent)
        const cancellation = cancellations.get(parent)
        if (cancellation && cancellation.state !== "failed") throw new Error("Worker owner cancellation was requested during admission.")
        watchWorker(child.id, parent)
      } catch (error) {
        if (singleton && !owner) claimedChild.delete(parent)
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not start the sidekick on ${modelLabel(pair.sidekick)} (${reason}). ${chooseAgain}`)
      }
    })
    const events = new AbortController()
    const observing = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "server.connected") workerStatus.clear()
          if (event.type === "session.status") {
            workerStatus.set(event.data.sessionID, { status: event.data.status.type, observedAt: event.created })
            if (event.data.status.type === "idle" && !hasWorkers(event.data.sessionID)) forgetWorker(event.data.sessionID)
          }
          if (event.type === "session.text.delta" || event.type === "session.reasoning.delta"
            || event.type === "session.tool.input.delta" || event.type === "session.tool.progress") {
            const worker = watched.get(event.data.sessionID)
            if (worker) worker.revision++
          }
          if (event.type === "session.execution.succeeded" && !hasWorkers(event.data.sessionID)) forgetWorker(event.data.sessionID)
          if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
            forgetWorker(event.data.sessionID)
            for (const [id, worker] of watched) if (worker.owner === event.data.sessionID) forgetWorker(id)
          }
          if (event.type === "session.deleted") {
            workerStatus.delete(event.data.sessionID); cancellations.delete(event.data.sessionID)
            forgetWorker(event.data.sessionID)
            for (const [id, worker] of watched) if (worker.owner === event.data.sessionID) forgetWorker(id)
          }
        }
      } finally {
        // A disconnected stream cannot establish current status from old observations.
        workerStatus.clear()
        supervision.stop(); watched.clear(); pendingProgress.clear()
      }
    })().catch(() => { workerStatus.clear() })
    return async () => { disposed = true; supervision.stop(); watched.clear(); pendingProgress.clear(); events.abort(); await observing }
  },
})
