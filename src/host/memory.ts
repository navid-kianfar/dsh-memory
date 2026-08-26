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
import { MemoryStore, type StoredMemory } from './store.ts'
import { blendSimilarity, relevance, scoreLexical, type RelevanceWeights } from '../domain/score.ts'
import { embeddingText, estimateTokens, extractEntities, projectSlug, queryTerms, summarize } from '../domain/text.ts'
import { expiresAt } from '../domain/retention.ts'
import { renderRules } from '../domain/rules.ts'
import { MemoryNotFoundError } from '../domain/validate.ts'
import {
  RULE_CATEGORIES, RULE_MIN_PRIORITY,
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

/** The embedding side of the plugin, as this object needs it. */
export interface Embedder {
  /** The model's identity, stored beside each vector so a model change is detectable. */
  readonly model: string
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
  #embedPass: Promise<unknown> | undefined
  #embedAgain = false
  readonly #abort = new AbortController()
  /** The open memory session, when a session has started against this project. */
  #sessionId: string | undefined
  #created = 0
  #accessed = 0

  /**
   * @param store - the project's open database.
   * @param options - ranking, retention, and embedding settings.
   * @param onRulesChanged - called after a write that changed the rule set, so a prompt registration
   *   holding the previous block can drop it.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly options: ProjectMemoryOptions,
    private readonly onRulesChanged: () => void = () => {},
  ) {}

  /** The project's slug, derived from its directory name. */
  get project(): string {
    return projectSlug(this.options.projectRoot)
  }

  /** Absolute path of the database file backing this memory. */
  get databasePath(): string {
    return this.options.databasePath
  }

  /** The open memory session's id, when one has started. */
  get sessionId(): string | undefined {
    return this.#sessionId
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
   * @param input - the validated create request.
   * @param actor - who is writing: `agent`, `user`, or a caller-supplied label.
   * @param now - the write time.
   * @returns the stored memory and whether it changed the rule set.
   */
  async create(input: CreateMemoryInput, actor: string, now: number): Promise<WriteResult> {
    const isRule = (RULE_CATEGORIES as readonly string[]).includes(input.category)
    const priority = isRule ? Math.max(input.priority ?? 0, RULE_MIN_PRIORITY) : input.priority ?? 0
    const expiry = expiresAt(input.category, priority, now, this.options.retentionDays)
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
      source: input.source ?? 'assistant',
      createdAt: now,
      updatedAt: now,
      ...input.metadata === undefined ? {} : { metadata: input.metadata },
      ...expiry === undefined ? {} : { expiresAt: expiry },
    }
    const memory = await this.store.insert(stored)
    this.#created += 1
    await this.record(memory.id, 'create', actor, now, {
      category: memory.category, title: memory.title, entities: memory.entities.length,
    })
    if (isRule) await this.rulesDidChange(now)
    this.scheduleEmbedding()
    return { memory, rulesChanged: isRule }
  }

  /**
   * Apply a patch, re-deriving the summary, entities, and retention when the text or category moved.
   * @param patch - the validated update request.
   * @param actor - who is writing.
   * @param now - the write time.
   * @returns the updated memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   */
  async update(patch: UpdateMemoryInput, actor: string, now: number): Promise<WriteResult> {
    const existing = await this.store.get(patch.id)
    if (existing === undefined) throw new MemoryNotFoundError(`no memory with id "${patch.id}"`)

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
    const becameRule = (RULE_CATEGORIES as readonly string[]).includes(category)
    if (patch.priority !== undefined) {
      columns['priority'] = becameRule ? Math.max(patch.priority, RULE_MIN_PRIORITY) : patch.priority
      changed.push('priority')
    } else if (patch.category !== undefined && becameRule && existing.priority < RULE_MIN_PRIORITY) {
      // Reclassifying a note as a rule has to carry the rule priority floor with it, or the entry
      // would be enforced while sorting below every other rule in the injected block.
      columns['priority'] = RULE_MIN_PRIORITY
    }

    const title = patch.title ?? existing.title
    const content = patch.content ?? existing.content
    if (patch.title !== undefined || patch.content !== undefined) {
      columns['summary'] = summarize(title, content)
      columns['entities'] = extractEntities(`${title}. ${content}`)
      // The stored vector describes the previous text, so keeping it would let a stale vector answer
      // a semantic query about text that no longer exists. Clearing it re-queues the memory.
      columns['embedding'] = null
      columns['embedding_model'] = null
      columns['embedding_dim'] = null
    }
    if (patch.category !== undefined || patch.priority !== undefined) {
      const priority = (columns['priority'] as number | undefined) ?? existing.priority
      const expiry = expiresAt(category, priority, now, this.options.retentionDays)
      columns['expires_at'] = expiry ?? null
    }

    const memory = await this.store.update(patch.id, columns, now)
    if (memory === undefined) throw new MemoryNotFoundError(`no memory with id "${patch.id}"`)
    await this.record(memory.id, 'update', actor, now, { changed })

    const wasRule = (RULE_CATEGORIES as readonly string[]).includes(existing.category)
    const rulesChanged = wasRule || becameRule
    if (rulesChanged) await this.rulesDidChange(now)
    this.scheduleEmbedding()
    return { memory, rulesChanged }
  }

  /**
   * Archive a memory: excluded from recall and from enforcement, but still there to restore or audit.
   * @param id - the memory to archive.
   * @param actor - who is archiving.
   * @param now - the archive time.
   * @param reason - optional note recorded on the audit entry.
   * @returns the archived memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   */
  async archive(id: string, actor: string, now: number, reason?: string): Promise<WriteResult> {
    return this.setStatus(id, 'archived', 'archive', actor, now, reason)
  }

  /**
   * Return an archived or expired memory to the live set.
   * @param id - the memory to restore.
   * @param actor - who is restoring.
   * @param now - the restore time.
   * @returns the restored memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   */
  async restore(id: string, actor: string, now: number): Promise<WriteResult> {
    return this.setStatus(id, 'active', 'restore', actor, now)
  }

  /**
   * Move a memory between lifecycle states and record why.
   * @param id - the memory to move.
   * @param status - the new status.
   * @param operation - the audit operation to record.
   * @param actor - who is acting.
   * @param now - the time of the change.
   * @param reason - optional note recorded on the audit entry.
   * @returns the memory and whether the rule set changed.
   * @throws MemoryNotFoundError when the id is unknown.
   */
  private async setStatus(
    id: string, status: Memory['status'], operation: ProvenanceOperation,
    actor: string, now: number, reason?: string,
  ): Promise<WriteResult> {
    const existing = await this.store.get(id)
    if (existing === undefined) throw new MemoryNotFoundError(`no memory with id "${id}"`)
    const memory = await this.store.update(id, { status }, now)
    if (memory === undefined) throw new MemoryNotFoundError(`no memory with id "${id}"`)
    await this.record(id, operation, actor, now, reason === undefined ? undefined : { reason })
    const rulesChanged = (RULE_CATEGORIES as readonly string[]).includes(existing.category)
    if (rulesChanged) await this.rulesDidChange(now)
    return { memory, rulesChanged }
  }

  /**
   * Remove a memory and its audit trail permanently.
   *
   * The audit trail goes with it deliberately: a trail pointing at a memory nobody can read is not
   * an audit, and keeping it would leave the deleted title recoverable after a delete meant to
   * remove exactly that.
   * @param id - the memory to remove.
   * @param now - the time of the removal.
   * @returns whether a memory was removed and whether the rule set changed.
   */
  async remove(id: string, now: number): Promise<{ removed: boolean, rulesChanged: boolean }> {
    const existing = await this.store.get(id)
    if (existing === undefined) return { removed: false, rulesChanged: false }
    const removed = await this.store.hardDelete(id)
    const rulesChanged = removed && (RULE_CATEGORIES as readonly string[]).includes(existing.category)
    if (rulesChanged) await this.rulesDidChange(now)
    return { removed, rulesChanged }
  }

  /**
   * Reload the rule cache and notify the prompt registration.
   * @param now - the current time.
   */
  private async rulesDidChange(now: number): Promise<void> {
    await this.refreshRules(now)
    this.onRulesChanged()
  }

  /**
   * Append one audit entry.
   * @param memoryId - the memory affected.
   * @param operation - what happened.
   * @param actor - who did it.
   * @param now - when.
   * @param details - operation-specific facts.
   */
  private async record(
    memoryId: string, operation: ProvenanceOperation, actor: string, now: number,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.store.recordProvenance({
      memoryId, operation, actor, at: now, ...details === undefined ? {} : { details },
    })
  }

  // ---------- reads ----------

  /**
   * Read a filtered page of memories.
   * @param query - the validated filters and paging.
   * @param now - the current time, for evaluating expiry.
   * @returns the page and the unpaged total.
   */
  async list(query: ListMemoriesQuery, now: number): Promise<MemoryPage> {
    return this.store.list(query, now)
  }

  /**
   * Read one memory by id or exact title, and count the read.
   * @param selector - the id or the exact title to find.
   * @param now - the current time.
   * @returns the memory.
   * @throws MemoryNotFoundError when nothing matches.
   */
  async recall(selector: { id?: string, title?: string }, now: number): Promise<Memory> {
    const memory = selector.id !== undefined
      ? await this.store.get(selector.id)
      : selector.title !== undefined ? await this.store.getByTitle(selector.title) : undefined
    if (memory === undefined) {
      const named = selector.id ?? selector.title ?? '(nothing)'
      throw new MemoryNotFoundError(`no memory matches "${named}"`)
    }
    await this.store.incrementAccess([memory.id])
    await this.record(memory.id, 'access', 'agent', now, { via: selector.id !== undefined ? 'id' : 'title' })
    this.#accessed += 1
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
   * @returns the ranked hits, the full index, and what the token budget left out.
   */
  async search(query: SearchQuery, now: number, signal: AbortSignal): Promise<SearchResult> {
    const terms = queryTerms(query.query)
    const limit = query.limit ?? 10
    const floor = query.minSimilarity ?? this.options.minSimilarity
    const vector = await this.embedQuery(query.query, signal)

    const candidates = await this.store.candidates(terms, vector, {
      now,
      limit: this.options.candidateLimit,
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
        lexical.get(memory.id)?.normalized ?? 0, cosine, this.options.vectorWeight,
      )
      if (similarity < floor) continue
      const matched: ('lexical' | 'vector')[] = []
      if ((lexical.get(memory.id)?.raw ?? 0) > 0) matched.push('lexical')
      if (cosine !== undefined) matched.push('vector')
      hits.push({
        memory,
        similarity: Number(similarity.toFixed(4)),
        relevance: Number(
          relevance(similarity, memory.updatedAt, memory.accessCount, now, this.options.relevanceWeights)
            .toFixed(4),
        ),
        matched,
      })
    }
    hits.sort((left, right) => right.relevance - left.relevance)
    const ranked = hits.slice(0, limit)

    await this.store.incrementAccess(ranked.map(hit => hit.memory.id))
    this.#accessed += ranked.length

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
   * Open a memory session and gather what the model should start with.
   *
   * Sessions left open by a previous crash are closed first. Their summaries are the orphan marker
   * rather than real text, so the "where we left off" answer skips past them to the last session
   * that actually ended with something to say.
   * @param now - the start time.
   * @returns the rules, last summary, sprint goals, and recent decisions.
   */
  async startSession(now: number): Promise<SessionContext> {
    const orphansClosed = await this.store.closeOrphans(ORPHAN_SUMMARY, now)
    await this.store.expireStale(now)
    const id = randomUUID()
    await this.store.startSession(id, now)
    this.#sessionId = id
    this.#created = 0
    this.#accessed = 0

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
   * @param sessionId - the session to close; defaults to the open one.
   * @param summary - what the next session needs to know.
   * @param now - the end time.
   * @returns whether an open session was closed.
   */
  async endSession(sessionId: string | undefined, summary: string, now: number): Promise<boolean> {
    const id = sessionId ?? this.#sessionId
    if (id === undefined) return false
    const closed = await this.store.endSession(id, summary, this.#created, this.#accessed, now)
    if (closed && id === this.#sessionId) this.#sessionId = undefined
    return closed
  }

  // ---------- embeddings ----------

  /**
   * Embed one query, when a provider is mounted.
   *
   * A failing provider degrades to lexical ranking rather than failing the search: a search that
   * returns keyword matches is useful, and one that returns an endpoint error is not.
   * @param query - the query text.
   * @param signal - cancellation for the call.
   * @returns the query vector, or undefined when no provider is mounted or the call failed.
   */
  private async embedQuery(query: string, signal: AbortSignal): Promise<number[] | undefined> {
    const embedder = this.#embedder
    if (embedder === undefined) return undefined
    try {
      const [vector] = await embedder.embed([query], signal)
      return vector === undefined ? undefined : [...vector]
    } catch {
      // Classified provider failures and transport failures alike mean "no vector this time". The
      // lexical half of the ranking is unaffected, so the search still answers.
      return undefined
    }
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
   * Embed everything still missing a vector for the current model.
   * @returns how many memories were embedded.
   */
  async drainEmbeddings(): Promise<number> {
    const embedder = this.#embedder
    if (embedder === undefined) return 0
    let embedded = 0
    for (;;) {
      if (this.#abort.signal.aborted) return embedded
      const pending = await this.store.withoutEmbedding(embedder.model, this.options.embedBatch, Date.now())
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
      for (const [index, memory] of pending.entries()) {
        const vector = vectors[index]
        if (vector === undefined) continue
        await this.store.setEmbedding(memory.id, vector, embedder.model)
        embedded += 1
      }
      if (pending.length < this.options.embedBatch) return embedded
    }
  }
}
