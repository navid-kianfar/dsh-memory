/**
 * One project's memory as a working object: the store, the cached rule block the system prompt reads
 * on every request, the ranker, and the background pass that keeps embeddings current.
 *
 * This is where a write becomes more than a row. Storing a memory derives its summary, its entities,
 * and its retention date, records provenance, invalidates the rule cache when the write was a rule,
 * and schedules the vector the next semantic search will need. Callers — the model-facing tools and
 * the browser's RPC endpoints alike — get the same behaviour because they share this object rather
 * than each assembling those steps themselves.
 *
 * @module @achasoft/dsh-memory/host/memory
 */

import { randomUUID } from 'node:crypto'
import { MemoryStore, type EmbeddingIdentity, type StoredMemory } from './store.ts'
import { blendSimilarity, relevance, scoreLexical, type RelevanceWeights } from '../domain/score.ts'
import { embeddingText, estimateTokens, extractEntities, projectSlug, queryTerms, summarize } from '../domain/text.ts'
import { asOf, effectiveStatus, expiresAt } from '../domain/retention.ts'
import { renderRules } from '../domain/rules.ts'
import { MemoryNotFoundError } from '../domain/validate.ts'
import {
  AGENT_SOURCE, MemoryForbiddenError, assertAgentMayChange, assertAgentMayCreate, isRuleCategory,
  type WriteOrigin,
} from '../domain/authorship.ts'
import {
  RULE_MIN_PRIORITY,
  type CreateMemoryInput, type ListMemoriesQuery, type Memory, type MemoryCategory, type MemoryPage,
  type MemorySession, type MemoryStats, type ProvenanceEntry, type ProvenanceOperation,
  type RuleSet, type SearchHit, type SearchIndexEntry, type SearchQuery, type SearchResult,
  type SessionContext, type UpdateMemoryInput,
} from '../domain/types.ts'

/**
 * Summary written onto a session that was never ended.
 *
 * Recognisable on sight and excluded when the next session asks for the last real summary, so a
 * crash does not become the thing the project claims happened last.
 */
export const ORPHAN_SUMMARY = '[auto-closed: this session never ended — context overflow, crash, or shutdown]'

/** How many sprint goals a session opens with. */
const SPRINT_LIMIT = 10

/** How many recent decisions a session opens with. */
const DECISION_LIMIT = 20

/** How far back "recent" reaches for the decisions a session opens with. */
const DECISION_WINDOW_DAYS = 7

/** Milliseconds in a day. */
const DAY_MS = 86_400_000

/**
 * The session owner for a caller that names none.
 *
 * Sessions are keyed by the harness session of the agent that owns them, because one project is
 * worked on by several agents at once — a parent and its subagents, or two top-level sessions in one
 * Web Client. A same-process caller with no agent (a test, a script) gets this one key, which keeps
 * the single-session behaviour such callers were written against.
 */
export const HOST_SESSION_OWNER = 'host'

/** Everything one project's memory needs beyond its store. */
export interface ProjectMemoryOptions {
  /** Absolute path of the project directory this memory belongs to. */
  readonly projectRoot: string
  /** Absolute path of the database file, for surfaces that tell the user where their memory lives. */
  readonly databasePath: string
  /** Rows either search probe may return before the tail is left unconsidered. */
  readonly candidateLimit: number
  /** Default similarity floor for a search that does not name one. */
  readonly minSimilarity: number
  /** The vector signal's share of a blended similarity, `0`–`1`. */
  readonly vectorWeight: number
  /** How the match, recency, and access signals are weighted against each other. */
  readonly relevanceWeights: RelevanceWeights
  /** Per-category retention in days; `null` means a category never expires. */
  readonly retentionDays: Readonly<Partial<Record<MemoryCategory, number | null>>>
  /** Memories embedded per background pass. */
  readonly embedBatch: number
}

/** A memory session an agent in this process currently owns. */
interface OpenSession {
  readonly id: string
  /** Memories this session's agent wrote; mutable because it is a running tally. */
  created: number
  /** Memories this session's agent read. */
  accessed: number
}

/** The embedding side of the plugin, as this object needs it. */
export interface Embedder {
  /**
   * The model's real identity, stored beside each vector so a model change is detectable.
   *
   * Must be the provider's own answer, never a placeholder: a vector stamped with a stand-in name
   * reads as "another model's" once the real name is known, and everything gets embedded again.
   */
  readonly model: string
  /**
   * The vector length the provider emits, when it is known without a call.
   *
   * When absent it is learned from the provider's first answer. Either way it is compared with each
   * stored vector's length, so a provider reconfigured to a new dimension under the same model name
   * re-embeds what it stranded instead of leaving it unreachable by semantic search.
   */
  readonly dimensions?: number
  /**
   * Embed a batch of texts.
   * @param texts - the texts to embed, in order.
   * @param signal - cancellation for the pass.
   * @returns one vector per input, in the same order.
   */
  readonly embed: (texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>
}

/** What `create` and `update` return: the memory, plus what the write implied. */
export interface WriteResult {
  readonly memory: Memory
  /** True when the write changed the rule set the model is bound by. */
  readonly rulesChanged: boolean
}

/** One project's memory. */
export class ProjectMemory {
  /** The rendered rule block, or `''`. Recomputed on demand and after every rule write. */
  #rulesBlock: string | undefined
  #embedder: Embedder | undefined
  /** The attached provider's vector length: reported, learned from its answers, or not yet known. */
  #dimensions: number | undefined
  #embedPass: Promise<unknown> | undefined
  #embedAgain = false
  readonly #abort = new AbortController()
  /** Open memory sessions keyed by the harness session of the agent that owns each. */
  readonly #sessions = new Map<string, OpenSession>()
  /** The current settings, read per call so a committed settings change reaches an open project. */
  readonly #options: () => ProjectMemoryOptions
  readonly #projectRoot: string
  readonly #databasePath: string

  /**
   * @param store - the project's open database.
   * @param options - ranking, retention, and embedding settings; pass a function to have them read
   *   at each call. The project root and database path are this object's identity and are fixed from
   *   the first read — a different file is a different project, opened as its own object.
   * @param onRulesChanged - called after a write that changed the rule set, so a prompt registration
   *   holding the previous block can drop it.
   */
  constructor(
    private readonly store: MemoryStore,
    options: ProjectMemoryOptions | (() => ProjectMemoryOptions),
    private readonly onRulesChanged: () => void = () => {},
  ) {
    this.#options = typeof options === 'function' ? options : () => options
    const initial = this.#options()
    this.#projectRoot = initial.projectRoot
    this.#databasePath = initial.databasePath
  }

  /** The project's slug, derived from its directory name. */
  get project(): string {
    return projectSlug(this.#projectRoot)
  }

  /** Absolute path of the project directory this memory belongs to. */
  get projectRoot(): string {
    return this.#projectRoot
  }

  /** Absolute path of the database file backing this memory. */
  get databasePath(): string {
    return this.#databasePath
  }

  /**
   * The open memory session of a caller that names no owner.
   * @deprecated Sessions are per agent; use {@link sessionIdFor} with the agent's session id.
   * @returns the session id, when one is open for {@link HOST_SESSION_OWNER}.
   */
  get sessionId(): string | undefined {
    return this.sessionIdFor(HOST_SESSION_OWNER)
  }

  /**
   * The memory session one agent owns.
   * @param owner - the agent's harness session id.
   * @returns the open memory session's id, or undefined when that agent has none.
   */
  sessionIdFor(owner: string): string | undefined {
    return this.#sessions.get(owner)?.id
  }

  /**
   * Attach an embedding provider, or detach the current one.
   *
   * Attaching schedules a backfill: memories written while no provider was mounted, and memories
   * embedded by a previous model, both need a vector before semantic search can reach them.
   * @param embedder - the provider, or undefined to run lexically only.
   */
  setEmbedder(embedder: Embedder | undefined): void {
    this.#embedder = embedder
    this.#dimensions = embedder?.dimensions
    if (embedder !== undefined) this.scheduleEmbedding()
  }

  /** Whether semantic ranking is available right now. */
  get semantic(): boolean {
    return this.#embedder !== undefined
  }

  /** Release the database and abandon any background embedding. */
  async close(): Promise<void> {
    this.#abort.abort()
    await this.store.close()
  }

  // ---------- rules ----------

  /**
   * The rendered binding-rules block, as the system prompt injects it.
   *
   * Synchronous because the prompt assembly that reads it is synchronous. The value is a cache that
   * {@link refreshRules} fills and every rule write invalidates, so a caller reaching it before the
   * first refresh gets `''` — no rules — rather than a stale set.
   * @returns the block, or `''` when the project has no rules.
   */
  rulesBlock(): string {
    return this.#rulesBlock ?? ''
  }

  /**
   * Reload the rule set and re-render the cached block.
   * @param now - the current time, for evaluating rule expiry.
   * @returns the rule set that was loaded.
   */
  async refreshRules(now: number): Promise<RuleSet> {
    const rules = await this.store.rules(now)
    this.#rulesBlock = renderRules(this.project, rules)
    return rules
  }

  /**
   * Read the project's complete rule set.
   * @param now - the current time, for evaluating rule expiry.
   * @returns both halves, in full.
   */
  async rules(now: number): Promise<RuleSet> {
    return this.refreshRules(now)
  }

  // ---------- writes ----------

  /**
   * Store a new memory, deriving everything the author did not supply.
   *
   * The insert and its audit entry commit together, and an agent's rule is checked against the
   * agent quota inside the same transaction, so two concurrent rules cannot both take the last slot.
   * @param input - the validated create request.
   * @param actor - who is writing: `agent`, `user`, or a caller-supplied label.
   * @param now - the write time.
   * @param origin - the calling agent, for authorship rules and session counters; absent for a person.
   * @returns the stored memory and whether it changed the rule set.
   * @throws MemoryForbiddenError when an agent may not add this rule.
   */
  async create(input: CreateMemoryInput, actor: string, now: number, origin?: WriteOrigin): Promise<WriteResult> {
    const isRule = isRuleCategory(input.category)
    const priority = isRule ? Math.max(input.priority ?? 0, RULE_MIN_PRIORITY) : input.priority ?? 0
    const expiry = expiresAt(input.category, priority, now, this.#options().retentionDays)
    const stored: StoredMemory = {
      id: randomUUID(),
      category: input.category,
      title: input.title,
      content: input.content,
      summary: summarize(input.title, input.content),
      tags: input.tags ?? [],
      entities: extractEntities(`${input.title}. ${input.content}`),
      relatedIds: input.relatedIds ?? [],
      status: 'active',
      priority,
      // An agent's write is labelled as an agent's whatever its arguments claimed: the label is what
      // decides who may later change a rule, so it cannot be something the model chooses.
      source: origin?.agent === undefined ? input.source ?? AGENT_SOURCE : AGENT_SOURCE,
      createdAt: now,
      updatedAt: now,
      ...input.metadata === undefined ? {} : { metadata: input.metadata },
      ...expiry === undefined ? {} : { expiresAt: expiry },
    }
    const memory = await this.store.transaction(async (tx) => {
      const agentRules = origin?.agent !== undefined && isRule ? await tx.countLiveRules(AGENT_SOURCE, now) : 0
      assertAgentMayCreate(input.category, input.content, origin, agentRules)
      const inserted = await tx.insert(stored)
      await tx.recordProvenance({
        memoryId: inserted.id, operation: 'create', actor, at: now,
        details: { category: inserted.category, title: inserted.title, entities: inserted.entities.length },
      })
      return inserted
    })
    this.#tally(origin, 'created', 1)
    if (isRule) await this.rulesDidChange(now)
    this.scheduleEmbedding()
    return { memory, rulesChanged: isRule }
  }

  /**
   * Apply a patch, re-deriving the summary, entities, and retention when the text, category, or
   * lifecycle moved.
   *
   * The read, the derivation, the authorship check, the write, and the audit entry are one
   * transaction, so an edit is always derived from the row as it is when the edit applies — two
   * overlapping edits cannot each compute from a row the other has already changed.
   * @param patch - the validated update request.
   * @param actor - who is writing.
   * @param now - the write time.
   * @param origin - the calling agent, for authorship rules; absent for a person.
   * @returns the updated memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   * @throws MemoryForbiddenError when an agent may not make this change.
   */
  async update(patch: UpdateMemoryInput, actor: string, now: number, origin?: WriteOrigin): Promise<WriteResult> {
    const options = this.#options()
    const { memory, rulesChanged } = await this.store.transaction(async (tx) => {
      const existing = await tx.read(patch.id)
      if (existing === undefined) throw new MemoryNotFoundError(`no memory with id "${patch.id}"`)
      const category = patch.category ?? existing.category
      assertAgentMayChange(existing, category, patch.content ?? existing.content, origin)
      if (origin?.agent !== undefined && isRuleCategory(category) && !isRuleCategory(existing.category)) {
        assertAgentMayCreate(category, patch.content ?? existing.content, origin, await tx.countLiveRules(AGENT_SOURCE, now))
      }
      const { columns, changed } = ProjectMemory.derivePatch(existing, patch, now, options)
      const updated = await tx.update(patch.id, columns, now)
      if (updated === undefined) throw new MemoryNotFoundError(`no memory with id "${patch.id}"`)
      await tx.recordProvenance({ memoryId: updated.id, operation: 'update', actor, at: now, details: { changed } })
      return { memory: updated, rulesChanged: isRuleCategory(existing.category) || isRuleCategory(category) }
    })
    if (rulesChanged) await this.rulesDidChange(now)
    this.scheduleEmbedding()
    return { memory, rulesChanged }
  }

  /**
   * Turn a patch into the columns it writes, from the row as it currently is.
   * @param existing - the row before the change.
   * @param patch - the requested change.
   * @param now - the write time, which a recomputed retention date counts from.
   * @param options - the settings in force for this write.
   * @returns the columns to write and the names of the fields the caller changed.
   */
  private static derivePatch(
    existing: Memory, patch: UpdateMemoryInput, now: number, options: ProjectMemoryOptions,
  ): { columns: Record<string, unknown>, changed: string[] } {
    const columns: Record<string, unknown> = {}
    const changed: string[] = []
    if (patch.title !== undefined) { columns['title'] = patch.title; changed.push('title') }
    if (patch.content !== undefined) { columns['content'] = patch.content; changed.push('content') }
    if (patch.tags !== undefined) { columns['tags'] = [...patch.tags]; changed.push('tags') }
    if (patch.metadata !== undefined) { columns['metadata'] = patch.metadata; changed.push('metadata') }
    if (patch.status !== undefined) { columns['status'] = patch.status; changed.push('status') }
    if (patch.relatedIds !== undefined) { columns['related_ids'] = [...patch.relatedIds]; changed.push('relatedIds') }
    if (patch.category !== undefined) { columns['category'] = patch.category; changed.push('category') }

    const category = patch.category ?? existing.category
    const becameRule = isRuleCategory(category)
    if (patch.priority !== undefined) {
      columns['priority'] = becameRule ? Math.max(patch.priority, RULE_MIN_PRIORITY) : patch.priority
      changed.push('priority')
    } else if (becameRule && existing.priority < RULE_MIN_PRIORITY) {
      // Reclassifying a note as a rule has to carry the rule priority floor with it, or the entry
      // would be enforced while sorting below every other rule in the injected block.
      columns['priority'] = RULE_MIN_PRIORITY
    }

    if (patch.title !== undefined || patch.content !== undefined) {
      const title = patch.title ?? existing.title
      const content = patch.content ?? existing.content
      columns['summary'] = summarize(title, content)
      columns['entities'] = extractEntities(`${title}. ${content}`)
      // The stored vector describes the previous text, so keeping it would let a stale vector answer
      // a semantic query about text that no longer exists. Clearing it re-queues the memory.
      columns['embedding'] = null
      columns['embedding_model'] = null
      columns['embedding_dim'] = null
    }
    // Judged at the write time: a memory still stored active but past its date is expired, and
    // restoring it without a fresh window would leave it expired the moment it came back.
    const restored = patch.status === 'active' && effectiveStatus(existing, now) !== 'active'
    if (patch.category !== undefined || patch.priority !== undefined || restored) {
      const priority = (columns['priority'] as number | undefined) ?? existing.priority
      columns['expires_at'] = expiresAt(category, priority, now, options.retentionDays) ?? null
    }
    return { columns, changed }
  }

  /**
   * Archive a memory: excluded from recall and from enforcement, but still there to restore or audit.
   * @param id - the memory to archive.
   * @param actor - who is archiving.
   * @param now - the archive time.
   * @param reason - optional note recorded on the audit entry.
   * @param origin - the calling agent, for authorship rules; absent for a person.
   * @returns the archived memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   * @throws MemoryForbiddenError when an agent may not retire this memory.
   */
  async archive(id: string, actor: string, now: number, reason?: string, origin?: WriteOrigin): Promise<WriteResult> {
    return this.setStatus(id, 'archived', 'archive', actor, now, reason, origin)
  }

  /**
   * Return an archived or expired memory to the live set, with a fresh retention window.
   *
   * The window restarts at the restore: a memory restored with its old deadline would be active but
   * already past expiry — shown in neither the active nor the expired list, and expired again by the
   * next session start.
   * @param id - the memory to restore.
   * @param actor - who is restoring.
   * @param now - the restore time.
   * @param origin - the calling agent, for authorship rules; absent for a person.
   * @returns the restored memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   * @throws MemoryForbiddenError when an agent may not restore this memory.
   */
  async restore(id: string, actor: string, now: number, origin?: WriteOrigin): Promise<WriteResult> {
    return this.setStatus(id, 'active', 'restore', actor, now, undefined, origin)
  }

  /**
   * Move a memory between lifecycle states and record why, as one transaction.
   * @param id - the memory to move.
   * @param status - the new status.
   * @param operation - the audit operation to record.
   * @param actor - who is acting.
   * @param now - the time of the change.
   * @param reason - optional note recorded on the audit entry.
   * @param origin - the calling agent, for authorship rules; absent for a person.
   * @returns the memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   * @throws MemoryForbiddenError when an agent may not make this change.
   */
  private async setStatus(
    id: string, status: Memory['status'], operation: ProvenanceOperation,
    actor: string, now: number, reason: string | undefined, origin: WriteOrigin | undefined,
  ): Promise<WriteResult> {
    const options = this.#options()
    const { memory, rulesChanged } = await this.store.transaction(async (tx) => {
      const existing = await tx.read(id)
      if (existing === undefined) throw new MemoryNotFoundError(`no memory with id "${id}"`)
      assertAgentMayChange(existing, existing.category, existing.content, origin)
      const { columns } = ProjectMemory.derivePatch(existing, { id, status }, now, options)
      const updated = await tx.update(id, columns, now)
      if (updated === undefined) throw new MemoryNotFoundError(`no memory with id "${id}"`)
      await tx.recordProvenance({
        memoryId: id, operation, actor, at: now, ...reason === undefined ? {} : { details: { reason } },
      })
      return { memory: updated, rulesChanged: isRuleCategory(existing.category) }
    })
    if (rulesChanged) await this.rulesDidChange(now)
    return { memory, rulesChanged }
  }

  /**
   * Remove a memory and its audit trail permanently.
   *
   * The audit trail goes with it deliberately: a trail pointing at a memory nobody can read is not
   * an audit, and keeping it would leave the deleted title recoverable after a delete meant to
   * remove exactly that. Both deletes are one transaction, so a failure cannot leave either behind.
   * @param id - the memory to remove.
   * @param now - the time of the removal.
   * @param origin - the calling agent, for authorship rules; absent for a person.
   * @returns whether a memory was removed and whether the rule set changed.
   * @throws MemoryForbiddenError when an agent may not remove this memory.
   */
  async remove(id: string, now: number, origin?: WriteOrigin): Promise<{ removed: boolean, rulesChanged: boolean }> {
    const removed = await this.store.transaction(async (tx) => {
      const existing = await tx.read(id)
      if (existing === undefined) return undefined
      assertAgentMayChange(existing, existing.category, existing.content, origin)
      return tx.hardDelete(id)
    })
    const rulesChanged = removed !== undefined && isRuleCategory(removed.category)
    if (rulesChanged) await this.rulesDidChange(now)
    return { removed: removed !== undefined, rulesChanged }
  }

  /**
   * Reload the rule cache and notify the prompt registration.
   * @param now - the current time.
   */
  private async rulesDidChange(now: number): Promise<void> {
    await this.refreshRules(now)
    this.onRulesChanged()
  }

  // ---------- reads ----------

  /**
   * Read a filtered page of memories.
   * @param query - the validated filters and paging.
   * @param now - the current time, for evaluating expiry.
   * @returns the page and the unpaged total, each memory carrying the status it has at `now`.
   */
  async list(query: ListMemoriesQuery, now: number): Promise<MemoryPage> {
    const page = await this.store.list(query, now)
    return { ...page, memories: page.memories.map(memory => asOf(memory, now)) }
  }

  /**
   * Read one memory by id without counting it as a use — for checks, not for handing text to a model.
   * @param id - the memory id.
   * @returns the memory, or undefined when the project does not hold it.
   */
  async get(id: string): Promise<Memory | undefined> {
    return this.store.get(id)
  }

  /**
   * Read one memory by id or exact title, and count the read.
   * @param selector - the id or the exact title to find.
   * @param now - the current time; a title only finds a memory still active at it.
   * @param origin - the calling agent, whose session the read is counted against.
   * @returns the memory, carrying the status it has at `now` — so an id naming a memory past its
   *   retention date answers `expired` even before a session start has swept it.
   * @throws MemoryNotFoundError when nothing matches.
   */
  async recall(selector: { id?: string, title?: string }, now: number, origin?: WriteOrigin): Promise<Memory> {
    const stored = selector.id !== undefined
      ? await this.store.get(selector.id)
      : selector.title !== undefined ? await this.store.getByTitle(selector.title, now) : undefined
    const memory = stored === undefined ? undefined : asOf(stored, now)
    if (memory === undefined) {
      const named = selector.id ?? selector.title ?? '(nothing)'
      throw new MemoryNotFoundError(`no memory matches "${named}"`)
    }
    await this.store.incrementAccess([memory.id])
    await this.store.recordProvenance({
      memoryId: memory.id, operation: 'access', actor: 'agent', at: now,
      details: { via: selector.id !== undefined ? 'id' : 'title' },
    })
    this.#tally(origin, 'accessed', 1)
    return memory
  }

  /**
   * Rank the project's memories against a query.
   *
   * Both signals run when a provider is mounted: a substring probe feeding BM25F, and a cosine probe
   * over stored vectors. A memory found by either is a candidate, and a memory with no vector is
   * ranked on its lexical score rather than penalised for the gap — otherwise every memory written
   * before the provider was configured would be permanently unreachable.
   * @param query - the validated search request.
   * @param now - the current time.
   * @param signal - cancellation for the query embedding, when one is computed.
   * @param origin - the calling agent, whose session the returned hits are counted against.
   * @returns the ranked hits, the full index, and what the token budget left out.
   */
  async search(query: SearchQuery, now: number, signal: AbortSignal, origin?: WriteOrigin): Promise<SearchResult> {
    const options = this.#options()
    const terms = queryTerms(query.query)
    const limit = query.limit ?? 10
    const floor = query.minSimilarity ?? options.minSimilarity
    const vector = await this.embedQuery(query.query, signal)

    const candidates = await this.store.candidates(terms, vector, {
      now,
      limit: options.candidateLimit,
      ...query.category === undefined ? {} : { category: query.category },
    })
    const lexical = scoreLexical(terms, candidates.documents, candidates.stats)

    const hits: SearchHit[] = []
    for (const memory of candidates.memories.values()) {
      if (query.tags !== undefined && query.tags.length > 0) {
        if (!query.tags.some(tag => memory.tags.includes(tag))) continue
      }
      const cosine = candidates.cosine.get(memory.id)
      const similarity = blendSimilarity(
        lexical.get(memory.id)?.normalized ?? 0, cosine, options.vectorWeight,
      )
      if (similarity < floor) continue
      const matched: ('lexical' | 'vector')[] = []
      if ((lexical.get(memory.id)?.raw ?? 0) > 0) matched.push('lexical')
      if (cosine !== undefined) matched.push('vector')
      hits.push({
        memory,
        similarity: Number(similarity.toFixed(4)),
        relevance: Number(
          relevance(similarity, memory.updatedAt, memory.accessCount, now, options.relevanceWeights)
            .toFixed(4),
        ),
        matched,
      })
    }
    hits.sort((left, right) => right.relevance - left.relevance)
    const ranked = hits.slice(0, limit)

    await this.store.incrementAccess(ranked.map(hit => hit.memory.id))
    this.#tally(origin, 'accessed', ranked.length)

    const index: SearchIndexEntry[] = ranked.map(hit => ({
      id: hit.memory.id,
      title: hit.memory.title,
      summary: hit.memory.summary,
      category: hit.memory.category,
      similarity: hit.similarity,
    }))
    if (query.tokenBudget === undefined) {
      return {
        query: query.query, index, hits: ranked, total: ranked.length,
        tokensUsed: ranked.reduce((total, hit) => total + estimateTokens(hit.memory.content), 0),
        hasMore: false, semantic: vector !== undefined,
      }
    }
    const kept: SearchHit[] = []
    let tokensUsed = 0
    for (const hit of ranked) {
      const cost = estimateTokens(hit.memory.content)
      if (tokensUsed + cost > query.tokenBudget) continue
      kept.push(hit)
      tokensUsed += cost
    }
    return {
      query: query.query, index, hits: kept, total: ranked.length, tokensUsed,
      hasMore: kept.length < ranked.length, semantic: vector !== undefined,
    }
  }

  /**
   * Read the most recent live memories of one category.
   * @param category - the category to read.
   * @param limit - most rows to return.
   * @param now - the current time.
   * @returns the memories, highest priority and newest first.
   */
  async byCategory(category: MemoryCategory, limit: number, now: number): Promise<Memory[]> {
    return this.store.byCategory(category, limit, now)
  }

  /**
   * Count what the project holds.
   * @param now - the current time.
   * @returns totals by status and active counts by category.
   */
  async stats(now: number): Promise<MemoryStats> {
    return this.store.stats(now)
  }

  /**
   * Read one memory's audit trail.
   * @param memoryId - the memory to trace.
   * @param limit - most entries to return.
   * @returns the entries, newest first.
   */
  async provenance(memoryId: string, limit: number): Promise<ProvenanceEntry[]> {
    return this.store.provenance(memoryId, limit)
  }

  /**
   * Read recent sessions.
   * @param limit - most sessions to return.
   * @returns the sessions, newest first.
   */
  async sessions(limit: number): Promise<MemorySession[]> {
    return this.store.sessions(limit)
  }

  /**
   * Read every memory, for export.
   * @returns all memories regardless of status.
   */
  async all(): Promise<Memory[]> {
    return this.store.all()
  }

  // ---------- sessions ----------

  /**
   * Open a memory session for one agent and gather what the model should start with.
   *
   * Sessions left open by a previous crash are closed first. Their summaries are the orphan marker
   * rather than real text, so the "where we left off" answer skips past them to the last session
   * that actually ended with something to say. A session another agent in this process still owns is
   * NOT an orphan — it is open because it is in use — so it is left alone; only this owner's own
   * previous session, replaced by this start, is closed with the marker.
   * @param now - the start time.
   * @param owner - the harness session id of the agent the session belongs to.
   * @returns the rules, last summary, sprint goals, and recent decisions.
   */
  async startSession(now: number, owner: string = HOST_SESSION_OWNER): Promise<SessionContext> {
    const id = randomUUID()
    // Reserved before the first await, so an overlapping start by another agent already counts this
    // session as live and cannot close it as an orphan between its insert and this bookkeeping.
    this.#sessions.set(owner, { id, created: 0, accessed: 0 })
    const live = [...this.#sessions.values()].map(session => session.id).filter(open => open !== id)
    let orphansClosed: number
    try {
      orphansClosed = await this.store.closeOrphans(ORPHAN_SUMMARY, now, live)
      await this.store.expireStale(now)
      await this.store.startSession(id, now)
    } catch (error) {
      if (this.#sessions.get(owner)?.id === id) this.#sessions.delete(owner)
      throw error
    }

    const rules = await this.refreshRules(now)
    const lastSummary = await this.store.lastSummary(ORPHAN_SUMMARY)
    const sprint = await this.store.byCategory('sprint', SPRINT_LIMIT, now)
    const recentDecisions = await this.store.byCategory(
      'decision', DECISION_LIMIT, now, now - DECISION_WINDOW_DAYS * DAY_MS,
    )
    return {
      sessionId: id,
      project: this.project,
      mandatory: rules.mandatory,
      forbidden: rules.forbidden,
      sprint,
      recentDecisions,
      orphansClosed,
      ...lastSummary === undefined ? {} : { lastSummary },
    }
  }

  /**
   * Close a memory session with the summary the next one opens with.
   *
   * Only the caller's own open session can be closed. A session id is a claim, not a credential: the
   * sessions table holds rows from other processes and from earlier runs, and closing one of those
   * would file this agent's summary as that session's last word. Ownership lives only in this object
   * — the row records no owner — so a session this object did not open for this owner is refused,
   * whatever agent id opened it elsewhere; the next session start closes it as an orphan instead.
   * @param sessionId - the session to close; defaults to the owner's own open session.
   * @param summary - what the next session needs to know.
   * @param now - the end time.
   * @param owner - the harness session id of the calling agent.
   * @returns whether an open session was closed; false when the owner has none open.
   * @throws MemoryForbiddenError when the named session belongs to another live agent, or is not the
   *   owner's own open session.
   */
  async endSession(
    sessionId: string | undefined, summary: string, now: number, owner: string = HOST_SESSION_OWNER,
  ): Promise<boolean> {
    const own = this.#sessions.get(owner)
    const holder = [...this.#sessions.entries()].find(([, session]) => session.id === sessionId)
    if (holder !== undefined && holder[0] !== owner) {
      throw new MemoryForbiddenError(
        `memory session "${sessionId}" belongs to another agent; call memory_session_end without a session_id `
        + 'to file your summary against your own session',
      )
    }
    if (sessionId !== undefined && sessionId !== own?.id) {
      throw new MemoryForbiddenError(
        `memory session "${sessionId}" is not one this agent opened, or it has already ended; call `
        + 'memory_session_end without a session_id to file your summary against your own session',
      )
    }
    if (own === undefined) return false
    const closed = await this.store.endSession(own.id, summary, own.created, own.accessed, now)
    if (this.#sessions.get(owner)?.id === own.id) this.#sessions.delete(owner)
    return closed
  }

  /**
   * Forget an agent's session without closing it, because the agent is gone.
   *
   * The row stays open, exactly as a crash would leave it, and the next session start closes it with
   * the orphan marker — which is the truth: nobody filed a summary for it.
   * @param owner - the harness session id of the departed agent.
   */
  releaseSession(owner: string): void {
    this.#sessions.delete(owner)
  }

  /**
   * Add to the running tally of the session a call belongs to.
   * @param origin - the caller; a caller naming no session counts against {@link HOST_SESSION_OWNER}.
   * @param field - which tally.
   * @param count - how much to add.
   */
  #tally(origin: WriteOrigin | undefined, field: 'created' | 'accessed', count: number): void {
    const session = this.#sessions.get(origin?.session ?? HOST_SESSION_OWNER)
    if (session !== undefined) session[field] += count
  }

  // ---------- embeddings ----------

  /**
   * The identity stored vectors are compared against, while a provider is attached.
   * @returns the model and, when known, the dimension.
   */
  #identity(): EmbeddingIdentity | undefined {
    const embedder = this.#embedder
    if (embedder === undefined) return undefined
    return { model: embedder.model, ...this.#dimensions === undefined ? {} : { dimensions: this.#dimensions } }
  }

  /**
   * Count live memories still missing a usable vector.
   * @param now - the current time, for evaluating expiry.
   * @returns memories the attached provider has yet to embed, or — with no provider — every live
   *   memory without a vector.
   */
  async pendingEmbeddings(now: number): Promise<number> {
    return this.store.countWithoutEmbedding(this.#identity(), now)
  }

  /**
   * Embed one query, when a provider is mounted.
   *
   * A failing provider degrades to lexical ranking rather than failing the search: a search that
   * returns keyword matches is useful, and one that returns an endpoint error is not. An answer of a
   * length the stored vectors do not have means the provider changed dimension, so a backfill is
   * scheduled for what that stranded.
   * @param query - the query text.
   * @param signal - cancellation for the call.
   * @returns the query vector, or undefined when no provider is mounted or the call failed.
   */
  private async embedQuery(query: string, signal: AbortSignal): Promise<number[] | undefined> {
    const embedder = this.#embedder
    if (embedder === undefined) return undefined
    let vectors: readonly (readonly number[])[]
    try {
      vectors = await embedder.embed([query], signal)
    } catch {
      // Classified provider failures and transport failures alike mean "no vector this time". The
      // lexical half of the ranking is unaffected, so the search still answers.
      return undefined
    }
    const dimensions = ProjectMemory.accepted(vectors, 1)
    const [vector] = vectors
    if (dimensions === undefined || vector === undefined) return undefined
    if (embedder === this.#embedder && dimensions !== this.#dimensions) {
      this.#dimensions = dimensions
      this.scheduleEmbedding()
    }
    return [...vector]
  }

  /**
   * Check a provider's answer is one vector per input, all finite and of one non-zero length.
   * @param vectors - what the provider returned.
   * @param expected - how many inputs were sent.
   * @returns the common dimension, or undefined when the answer is unusable.
   */
  private static accepted(vectors: readonly (readonly number[])[], expected: number): number | undefined {
    if (!Array.isArray(vectors) || vectors.length !== expected) return undefined
    const dimensions = vectors[0]?.length ?? 0
    if (dimensions === 0) return undefined
    const usable = vectors.every(vector =>
      Array.isArray(vector) && vector.length === dimensions && vector.every(value => Number.isFinite(value)))
    return usable ? dimensions : undefined
  }

  /**
   * Ask for a background embedding pass, coalescing overlapping requests.
   *
   * A pass that finishes while another request arrived runs again rather than dropping it, so a
   * burst of writes ends with everything embedded instead of everything but the last one.
   */
  scheduleEmbedding(): void {
    if (this.#embedder === undefined || this.#abort.signal.aborted) return
    if (this.#embedPass !== undefined) { this.#embedAgain = true; return }
    this.#embedPass = this.drainEmbeddings().finally(() => {
      this.#embedPass = undefined
      if (this.#embedAgain) { this.#embedAgain = false; this.scheduleEmbedding() }
    })
  }

  /**
   * Wait for the current background embedding pass, if one is running.
   * @returns settlement after the pass; resolves immediately when none is running.
   */
  async whenEmbedded(): Promise<void> {
    await this.#embedPass
  }

  /**
   * Embed everything still missing a vector for the current model and dimension.
   *
   * Every loop either stores a whole batch — which moves those rows out of the backlog — or stops.
   * An unusable answer (too few vectors, empty or non-finite ones, mixed lengths) stops the pass
   * rather than retrying it: storing nothing leaves the backlog exactly as it was, and asking again
   * immediately would spin on a provider that keeps answering the same way.
   * @returns how many memories were embedded.
   */
  async drainEmbeddings(): Promise<number> {
    const embedder = this.#embedder
    if (embedder === undefined) return 0
    let embedded = 0
    if (this.#dimensions === undefined) {
      const probed = await this.probeDimensions(embedder)
      if (probed === undefined) return 0
      embedded += probed
    }
    let dimensionChanges = 0
    for (;;) {
      if (this.#abort.signal.aborted || this.#embedder !== embedder) return embedded
      const batch = this.#options().embedBatch
      const identity = this.#identity()
      if (identity === undefined) return embedded
      const pending = await this.store.withoutEmbedding(identity, batch, Date.now())
      if (pending.length === 0) return embedded
      let vectors: readonly (readonly number[])[]
      try {
        vectors = await embedder.embed(
          pending.map(memory => embeddingText(memory.title, memory.content)),
          this.#abort.signal,
        )
      } catch {
        // The provider is unreachable, unconfigured, or rejecting. Stopping leaves these memories
        // searchable lexically and re-queued for the next pass; retrying here would spin.
        return embedded
      }
      const dimensions = ProjectMemory.accepted(vectors, pending.length)
      if (dimensions === undefined || this.#embedder !== embedder) return embedded
      const changed = this.#dimensions !== undefined && dimensions !== this.#dimensions
      this.#dimensions = dimensions
      for (const [index, memory] of pending.entries()) {
        await this.store.setEmbedding(memory.id, vectors[index] as readonly number[], embedder.model)
      }
      embedded += pending.length
      // A dimension change mid-pass strands what was stored before it, so look again — once; a
      // provider that keeps changing its mind is not something a loop can settle.
      if (changed) { dimensionChanges += 1; if (dimensionChanges > 1) return embedded; continue }
      if (pending.length < batch) return embedded
    }
  }

  /**
   * Learn the dimension a provider emits today, when it did not say, by re-embedding one memory the
   * same model embedded before. That spends the call on real work — the memory's vector is refreshed
   * — and tells whether vectors stored under this model name are still comparable.
   * @param embedder - the attached provider.
   * @returns how many memories the probe embedded (0 or 1), or undefined when the pass should stop.
   */
  private async probeDimensions(embedder: Embedder): Promise<number | undefined> {
    const sample = await this.store.embeddedBy(embedder.model, Date.now())
    // Nothing is stored under this model yet, so nothing can be stranded; the first batch will tell.
    if (sample === undefined) return 0
    let vectors: readonly (readonly number[])[]
    try {
      vectors = await embedder.embed([embeddingText(sample.title, sample.content)], this.#abort.signal)
    } catch {
      // Same reasoning as a failed batch: stop, and let the next pass try again.
      return undefined
    }
    const dimensions = ProjectMemory.accepted(vectors, 1)
    const [vector] = vectors
    if (dimensions === undefined || vector === undefined || this.#embedder !== embedder) return undefined
    this.#dimensions = dimensions
    await this.store.setEmbedding(sample.id, vector, embedder.model)
    return 1
  }
}
