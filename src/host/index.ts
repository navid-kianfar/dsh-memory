/**
 * The memory capability's Node half: the store every project gets, the RPC endpoint the manager
 * calls, the settings section that owns the deployment's preferences, and the harness hooks that
 * make a project's rules and context reach the model without anyone asking.
 *
 * The binding rules are a system-prompt section rather than a message injected per turn. A section's
 * text provider runs at every prompt assembly, so the rules are re-read on every request and cannot
 * be summarized away by compaction — the failure mode this plugin exists to remove. Session context
 * (the last summary, sprint goals, recent decisions) is injected once at session start instead,
 * because it is history rather than obligation and repeating it on every request would pay for it
 * again each turn.
 *
 * Each project's memory is opened lazily and keyed by its directory, so two workspaces open in one
 * Web Client never share a rule set, and a project nobody has touched never has a database created
 * for it.
 *
 * @module @achasoft/dsh-memory/host
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryStore } from './store.ts'
import { ProjectMemory, type Embedder, type ProjectMemoryOptions } from './memory.ts'
import { DEFAULT_DATABASE_PATH, MemoryStoreError, resolveDatabasePath } from './db.ts'
import { toCategoryCounts, toMemoryView, toProvenanceView, toSessionView } from './views.ts'
import { parseInstructions } from './import.ts'
import { DEFAULT_RELEVANCE_WEIGHTS } from '../domain/score.ts'
import { renderSessionContext, renderSessionEndReminder } from '../domain/rules.ts'
import { MemoryInputError, MemoryNotFoundError, parseCreate, parseUpdate } from '../domain/validate.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from '../domain/types.ts'
import type { EmbeddingProviderInfo } from '../embedding/index.ts'
import type {} from '../embedding/index.ts'
import type {
  MemoryCreateRequest, MemoryEmbedResult, MemoryExportResult, MemoryImportRequest,
  MemoryImportResult, MemoryListRequest, MemoryListResult, MemoryOverviewResult,
  MemoryProjectRequest, MemoryProvenanceRequest, MemoryProvenanceResult, MemoryRemoveRequest,
  MemoryRemoveResult, MemorySearchRequest, MemorySearchResult, MemorySessionsResult, MemorySettings,
  MemoryStatsView,
  MemoryUpdateRequest, MemoryWriteResult,
} from './types.ts'

export type * from './types.ts'
export { ProjectMemory } from './memory.ts'
export { MemoryStore } from './store.ts'
export { MemoryStoreError, DEFAULT_DATABASE_PATH } from './db.ts'
export { parseInstructions } from './import.ts'

/** The settings namespace both halves of this plugin address; the browser card joins on it. */
export const MEMORY_SETTINGS_NAMESPACE = settingsNamespace('memory')

/** Deployment configuration for the memory capability; the `memory` settings section's own shape. */
export interface Config extends MemorySettings {
  /**
   * Per-category retention in days. `0` means that category never expires; an absent category takes
   * the built-in default. Rules never expire whatever this says.
   */
  retentionDays?: Record<string, number>
  /** How much the match, recency, and access signals each contribute to a result's ordering. */
  relevanceWeights?: { similarity: number, recency: number, access: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Order of the binding-rules section: after the deployment persona, before tool guidance. */
const RULES_ORDER = 50

/** Name of the binding-rules prompt section; one per agent, in that agent's own scope. */
const RULES_SECTION = 'memory:rules'

/** How many audit entries one trail read returns. */
const PROVENANCE_LIMIT = 100

/** How many sessions the manager's Sessions tab shows. */
const SESSION_LIMIT = 50

/** Version stamped into an export document, so an importer knows what it is reading. */
const EXPORT_VERSION = 1

/**
 * Translate a rejection into the failure union the browser branches on.
 * @param error - the caught value.
 * @returns the classified failure.
 * @throws the original value when it is not one this endpoint owns.
 */
function failure(error: unknown): { readonly ok: false, readonly code: 'invalid' | 'not-found' | 'unavailable', readonly message: string } {
  if (error instanceof MemoryInputError) return { ok: false, code: 'invalid', message: error.message }
  if (error instanceof MemoryNotFoundError) return { ok: false, code: 'not-found', message: error.message }
  if (error instanceof MemoryStoreError) return { ok: false, code: 'unavailable', message: error.message }
  throw error
}

/**
 * Read a JSON sidecar the browser sent as text.
 * @param json - the text, or undefined when the caller sent none.
 * @returns the parsed record, `null` to clear a stored sidecar, or undefined to leave it alone.
 * @throws MemoryInputError when the text is not a JSON object.
 */
function parseSidecar(json: string | undefined): Record<string, unknown> | null | undefined {
  if (json === undefined) return undefined
  if (json.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new MemoryInputError('metadata must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryInputError('metadata must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Host-side memory endpoint, settings owner, and harness-hook consumer. */
export class MemoryService extends TypertRemoteService {
  static inject = ['agents']

  /** Loader validation for the storage path, the injection switches, and the ranking knobs. */
  static Config: z<Config> = z.object({
    databasePath: z.string().default(DEFAULT_DATABASE_PATH),
    injectRules: z.boolean().default(true),
    injectSessionContext: z.boolean().default(true),
    autoSession: z.boolean().default(true),
    remind: z.union(['never', 'once', 'every-turn'] as const).default('once'),
    vectorWeight: z.number().min(0).max(1).default(0.6),
    minSimilarity: z.number().min(0).max(1).default(0.05),
    searchLimit: z.number().step(1).min(1).max(100).default(10),
    candidateLimit: z.number().step(1).min(1).default(1000),
    embedBatch: z.number().step(1).min(1).default(64),
    toolset: z.union(['core', 'full'] as const).default('core'),
    retentionDays: z.dict(z.number().step(1).min(0)).default({}),
    relevanceWeights: z.object({
      similarity: z.number().min(0).max(1).default(DEFAULT_RELEVANCE_WEIGHTS.similarity),
      recency: z.number().min(0).max(1).default(DEFAULT_RELEVANCE_WEIGHTS.recency),
      access: z.number().min(0).max(1).default(DEFAULT_RELEVANCE_WEIGHTS.access),
    }).default(DEFAULT_RELEVANCE_WEIGHTS),
  })

  // TypeScript `private`, not `#private`. A Cordis service is reached through a Proxy, and a JS
  // private field is keyed to the instance that declared it — so a Remote call arriving through
  // `ctx.memory` cannot read one, and every endpoint fails with a brand-check error at runtime that
  // no type check can see.
  /** Open memories keyed by absolute project root; a project is opened on first touch. */
  private readonly projects = new Map<string, Promise<ProjectMemory>>()
  /** Per-agent prompt fibers, so a rule set unwinds with the agent that reads it. */
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  /** Agents that have already been reminded to file a summary, under the `once` policy. */
  private readonly reminded = new WeakSet<Agent>()
  /** The mounted embedding provider's model name, refreshed whenever its readiness is described. */
  private embeddingModel: string | undefined
  private source: () => Config

  /**
   * @param ctx - Host context; the embedding provider is resolved optionally so a deployment
   *   without one still gets lexical ranking and every other feature.
   * @param config - the composition-layer memory preferences.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.source = () => config
    installSettingsSection(ctx, MEMORY_SETTINGS_NAMESPACE, MemoryService.Config, config, {
      setSource: (current) => { this.source = current },
      // Ranking and injection settings are read inside each call and each prompt assembly, so a
      // committed change reaches the next request with no registration to rebuild. The one derived
      // thing — an already-open project's options — is refreshed here.
      onChange: () => { this.applySettings() },
    })

    ctx.on('agent/session-start', ({ agent }) => { this.onSessionStart(agent) })
    ctx.on('agent/turn-stopping', ({ agent }) => { this.onTurnStopping(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.onAgentDisposed(agent) })

    ctx.effect(() => async () => {
      const fibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all(fibers.map(fiber => fiber.dispose()))
      const projects = [...this.projects.values()]
      this.projects.clear()
      await Promise.all(projects.map(async (pending) => {
        // A project still opening must finish before it can be closed; a project that FAILED to open
        // holds no database, so there is nothing to release and the rejection is already reported.
        await pending.then(project => project.close(), () => {})
      }))
    }, 'dsh-memory: close project memories')
  }

  // ---------- project resolution ----------

  /**
   * The project a call means when it names none: the directory the Host process runs in.
   * @returns the absolute default project root.
   */
  private get defaultRoot(): string {
    return process.cwd()
  }

  /**
   * Build the per-project settings from the current configuration.
   * @param projectRoot - absolute project directory.
   * @returns the options one {@link ProjectMemory} runs under.
   */
  private optionsFor(projectRoot: string): ProjectMemoryOptions {
    const config = this.source()
    const retention: Partial<Record<MemoryCategory, number | null>> = {}
    for (const [category, days] of Object.entries(config.retentionDays ?? {})) {
      if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) continue
      // Zero is how a numeric setting says "never", since the schema has no null to offer.
      retention[category as MemoryCategory] = days === 0 ? null : days
    }
    return {
      projectRoot,
      databasePath: resolveDatabasePath(projectRoot, config.databasePath),
      candidateLimit: config.candidateLimit,
      minSimilarity: config.minSimilarity,
      vectorWeight: config.vectorWeight,
      relevanceWeights: config.relevanceWeights ?? DEFAULT_RELEVANCE_WEIGHTS,
      retentionDays: retention,
      embedBatch: config.embedBatch,
    }
  }

  /**
   * Open a project's memory, or return the already-open one.
   *
   * A failed open is not cached: the usual cause is another process holding the file lock, and a
   * cached rejection would keep answering with that failure after the other process exited.
   * @param projectRoot - absolute project directory; absent uses the Host's default.
   * @returns the project's memory.
   * @throws MemoryStoreError when the database cannot be opened.
   */
  async project(projectRoot?: string): Promise<ProjectMemory> {
    const root = projectRoot ?? this.defaultRoot
    const existing = this.projects.get(root)
    if (existing !== undefined) return existing
    const options = this.optionsFor(root)
    const opening = (async () => {
      const store = await MemoryStore.open(options.databasePath)
      const project = new ProjectMemory(store, options)
      project.setEmbedder(this.embedder())
      await project.refreshRules(Date.now())
      return project
    })()
    this.projects.set(root, opening)
    opening.catch(() => { this.projects.delete(root) })
    return opening
  }

  /**
   * The embedding provider, as {@link ProjectMemory} consumes it.
   * @returns the embedder, or undefined when no provider is mounted.
   */
  private embedder(): Embedder | undefined {
    const engine = this.ctx.get('memoryEmbedding')
    if (engine === undefined) return undefined
    return {
      // The provider's own identity is what a stored vector is stamped with; asking it per batch
      // would make every backfill wait on a describe() round trip.
      model: this.embeddingModel ?? 'unknown',
      embed: (texts, signal) => engine.embed(texts, signal),
    }
  }

  /**
   * Describe the mounted embedding provider, and remember its model for vector stamping.
   * @returns the provider's readiness, or an absent provider.
   */
  private async describeEmbedding(): Promise<EmbeddingProviderInfo & { available: boolean }> {
    const engine = this.ctx.get('memoryEmbedding')
    if (engine === undefined) {
      return { available: false, provider: 'none', ready: false, detail: 'no embedding provider is mounted' }
    }
    const info = await engine.describe()
    this.embeddingModel = info.model ?? info.provider
    return { ...info, available: true }
  }

  /** Re-apply changed settings to every already-open project. */
  private applySettings(): void {
    for (const pending of this.projects.values()) {
      void pending.then((project) => { project.setEmbedder(this.embedder()) }, () => {})
    }
  }

  // ---------- harness hooks ----------

  /**
   * Open the agent's project, install its rule section, and seed its opening context.
   *
   * Everything here is detached. `agent/session-start` is a notification the loop does not await, so
   * a slow first database open must not delay the first request — the rule section reads the cached
   * block, which is empty until the open completes and correct on every request after it.
   * @param agent - the agent whose session began.
   */
  private onSessionStart(agent: Agent): void {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const config = this.source()
    void (async () => {
      const project = await this.project(cwd)
      if (config.injectRules) this.installRules(agent, project)
      if (!config.autoSession) return
      const context = await project.startSession(Date.now())
      if (!config.injectSessionContext) return
      const text = renderSessionContext(context)
      if (text.length === 0) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-memory' },
      }))
    })().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: could not open memory for "${cwd}": ${String(error)}`)
    })
  }

  /**
   * Register this agent's binding-rules section in the agent's own scope.
   *
   * Agent-scoped rather than global because two workspaces open in one Host have different rules,
   * and a global section would hand each agent the other's. The provider re-reads the cached block
   * at every assembly, which is what keeps a mid-session rule edit binding from the next request.
   * @param agent - the agent to bind.
   * @param project - the memory whose rules bind it.
   */
  private installRules(agent: Agent, project: ProjectMemory): void {
    if (this.promptFibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: RULES_SECTION,
        order: RULES_ORDER,
        text: () => (this.source().injectRules ? project.rulesBlock() : ''),
      })
    })
    this.promptFibers.set(agent, fiber)
  }

  /**
   * Remind the model to file a session summary at the turn's stop boundary.
   *
   * Under `once` the reminder lands on the first turn that reaches a stop boundary and never again,
   * which is the difference between a prompt the model acts on and one it learns to ignore.
   * @param agent - the agent whose turn is closing.
   */
  private onTurnStopping(agent: Agent): void {
    const config = this.source()
    if (config.remind === 'never' || !config.autoSession) return
    if (config.remind === 'once') {
      if (this.reminded.has(agent)) return
      this.reminded.add(agent)
    }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    void (async () => {
      const project = await this.project(cwd)
      const sessionId = project.sessionId
      if (sessionId === undefined) return
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: renderSessionEndReminder(project.project, sessionId) }],
        source: { kind: 'plugin', plugin: 'dsh-memory' },
      }))
    })().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: session-end reminder failed: ${String(error)}`)
    })
  }

  /**
   * Drop the agent's rule section when the agent goes away.
   *
   * The project's database stays open: another agent may share it, and reopening a DuckDB file costs
   * a lock round trip that the plugin's own teardown handles once instead.
   * @param agent - the disposed agent.
   */
  private onAgentDisposed(agent: Agent): void {
    const fiber = this.promptFibers.get(agent)
    if (fiber === undefined) return
    this.promptFibers.delete(agent)
    void fiber.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: rule section cleanup failed: ${String(error)}`)
    })
  }

  // ---------- RPC endpoints ----------

  /**
   * Describe one project's memory: what it holds, where it lives, and what binds the model.
   * @param request - the project to describe; absent uses the Host's default project.
   * @returns the overview, or why it could not be read.
   */
  @Remote('describe')
  async describe(request: MemoryProjectRequest): Promise<MemoryOverviewResult> {
    try {
      const project = await this.project(request.project)
      const now = Date.now()
      const [stats, rules, embedding] = await Promise.all([
        project.stats(now), project.rules(now), this.describeEmbedding(),
      ])
      const statsView: MemoryStatsView = {
        total: stats.total,
        active: stats.active,
        archived: stats.archived,
        expired: stats.expired,
        embedded: stats.embedded,
        byCategory: toCategoryCounts(stats.byCategory),
      }
      return {
        ok: true,
        overview: {
          project: project.project,
          projectRoot: request.project ?? this.defaultRoot,
          databasePath: project.databasePath,
          stats: statsView,
          embedding: {
            available: embedding.available,
            provider: embedding.provider,
            ready: embedding.ready,
            ...embedding.model === undefined ? {} : { model: embedding.model },
            ...embedding.detail === undefined ? {} : { detail: embedding.detail },
          },
          mandatory: rules.mandatory.map(toMemoryView),
          forbidden: rules.forbidden.map(toMemoryView),
          rulesBlock: project.rulesBlock(),
          enforcing: this.source().injectRules,
        },
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Read a filtered page of a project's memories.
   * @param request - the filters and paging.
   * @returns the page, or why it could not be read.
   */
  @Remote('list')
  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    try {
      const project = await this.project(request.project)
      const page = await project.list({
        ...request.status === undefined ? {} : { status: request.status },
        ...request.category === undefined ? {} : { category: request.category },
        ...request.tags === undefined ? {} : { tags: request.tags },
        ...request.text === undefined ? {} : { text: request.text },
        ...request.limit === undefined ? {} : { limit: request.limit },
        ...request.offset === undefined ? {} : { offset: request.offset },
        ...request.sortBy === undefined ? {} : { sortBy: request.sortBy },
        ...request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder },
      }, Date.now())
      return {
        ok: true,
        memories: page.memories.map(toMemoryView),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Rank a project's memories against a query.
   * @param request - the query and its filters.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the ranked hits, or why the search could not run.
   */
  @Remote('search')
  async search(request: MemorySearchRequest, signal: AbortSignal): Promise<MemorySearchResult> {
    try {
      const project = await this.project(request.project)
      const result = await project.search({
        query: request.query,
        limit: request.limit ?? this.source().searchLimit,
        ...request.category === undefined ? {} : { category: request.category },
        ...request.tags === undefined ? {} : { tags: request.tags },
        ...request.minSimilarity === undefined ? {} : { minSimilarity: request.minSimilarity },
      }, Date.now(), signal)
      return {
        ok: true,
        query: result.query,
        total: result.total,
        semantic: result.semantic,
        hits: result.hits.map(hit => ({
          memory: toMemoryView(hit.memory),
          similarity: hit.similarity,
          relevance: hit.relevance,
          matched: hit.matched,
        })),
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Write a new memory from the manager.
   * @param request - the memory to store.
   * @returns the stored memory, or why the write was refused.
   */
  @Remote('create')
  async create(request: MemoryCreateRequest): Promise<MemoryWriteResult> {
    try {
      const project = await this.project(request.project)
      const metadata = parseSidecar(request.metadataJson)
      const input = parseCreate({
        category: request.category,
        title: request.title,
        content: request.content,
        tags: request.tags,
        priority: request.priority,
        source: 'user',
        ...metadata === null || metadata === undefined ? {} : { metadata },
      })
      const written = await project.create(input, 'user', Date.now())
      return { ok: true, memory: toMemoryView(written.memory), rulesChanged: written.rulesChanged }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Apply an edit from the manager.
   * @param request - the fields to change.
   * @returns the updated memory, or why the edit was refused.
   */
  @Remote('update')
  async update(request: MemoryUpdateRequest): Promise<MemoryWriteResult> {
    try {
      const project = await this.project(request.project)
      const metadata = parseSidecar(request.metadataJson)
      const patch = parseUpdate({
        id: request.id,
        ...request.category === undefined ? {} : { category: request.category },
        ...request.title === undefined ? {} : { title: request.title },
        ...request.content === undefined ? {} : { content: request.content },
        ...request.tags === undefined ? {} : { tags: request.tags },
        ...request.priority === undefined ? {} : { priority: request.priority },
        ...request.status === undefined ? {} : { status: request.status },
        ...metadata === undefined ? {} : { metadata },
      })
      const written = await project.update(patch, 'user', Date.now())
      return { ok: true, memory: toMemoryView(written.memory), rulesChanged: written.rulesChanged }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Archive a memory, or remove it and its audit trail permanently.
   *
   * Named `discard` rather than `remove` because the browser's namespace service already owns a
   * `remove` method for un-mounting an endpoint; a Remote method of that name is refused at mount
   * time, taking the whole plugin down with it.
   * @param request - which memory, and whether the removal is permanent.
   * @returns what happened, or why it was refused.
   */
  @Remote('discard')
  async discard(request: MemoryRemoveRequest): Promise<MemoryRemoveResult> {
    try {
      const project = await this.project(request.project)
      const now = Date.now()
      if (request.hard) {
        const result = await project.remove(request.id, now)
        return { ok: true, removed: result.removed, rulesChanged: result.rulesChanged }
      }
      const written = await project.archive(request.id, 'user', now)
      return { ok: true, removed: true, rulesChanged: written.rulesChanged }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Read a project's recent sessions.
   * @param request - the project to read.
   * @returns the sessions, or why they could not be read.
   */
  @Remote('sessions')
  async sessions(request: MemoryProjectRequest): Promise<MemorySessionsResult> {
    try {
      const project = await this.project(request.project)
      return { ok: true, sessions: (await project.sessions(SESSION_LIMIT)).map(toSessionView) }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Read one memory's audit trail.
   * @param request - the memory to trace.
   * @returns the entries, newest first, or why they could not be read.
   */
  @Remote('provenance')
  async provenance(request: MemoryProvenanceRequest): Promise<MemoryProvenanceResult> {
    try {
      const project = await this.project(request.project)
      const entries = await project.provenance(request.id, PROVENANCE_LIMIT)
      return { ok: true, entries: entries.map(toProvenanceView) }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Import an existing instructions file as structured memory.
   * @param request - the file's text and the source label to record.
   * @returns what was created, or why the import was refused.
   */
  @Remote('importInstructions')
  async importInstructions(request: MemoryImportRequest): Promise<MemoryImportResult> {
    try {
      const project = await this.project(request.project)
      const now = Date.now()
      const parsed = parseInstructions(request.text)
      if (parsed.length === 0) {
        return { ok: false, code: 'invalid', message: 'nothing in that file looked like a rule or a note' }
      }
      const created = []
      for (const entry of parsed) {
        const written = await project.create({ ...entry, source: request.source }, 'user', now)
        created.push(written.memory)
      }
      return {
        ok: true,
        imported: created.length,
        rules: created.filter(memory => memory.category.endsWith('_rules')).length,
        memories: created.map(toMemoryView),
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Export every memory as portable JSON, for committing to a repository or moving to another machine.
   * @param request - the project to export.
   * @returns the export document, or why it could not be read.
   */
  @Remote('exportAll')
  async exportAll(request: MemoryProjectRequest): Promise<MemoryExportResult> {
    try {
      const project = await this.project(request.project)
      const memories = await project.all()
      const document = {
        version: EXPORT_VERSION,
        project: project.project,
        exportedAt: new Date(Date.now()).toISOString(),
        memories: memories.map(toMemoryView),
      }
      return { ok: true, json: JSON.stringify(document, null, 2), count: memories.length }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Run an embedding pass now, rather than waiting for the background one.
   * @param request - the project to embed.
   * @returns how many were embedded and how many still need it, or why the pass could not run.
   */
  @Remote('reembed')
  async reembed(request: MemoryProjectRequest): Promise<MemoryEmbedResult> {
    try {
      await this.describeEmbedding()
      const project = await this.project(request.project)
      project.setEmbedder(this.embedder())
      const embedded = await project.drainEmbeddings()
      const stats = await project.stats(Date.now())
      return { ok: true, embedded, remaining: Math.max(0, stats.active - stats.embedded) }
    } catch (error) {
      return failure(error)
    }
  }
}

export default MemoryService
