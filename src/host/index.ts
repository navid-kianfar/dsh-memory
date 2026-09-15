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
import { installSettingsSection, settingsNamespace } from './settings-section.ts'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryStore } from './store.ts'
import { ProjectMemory, type Embedder, type ProjectMemoryOptions } from './memory.ts'
import { DEFAULT_DATABASE_PATH, MemoryStoreError, canonicalDatabasePath, resolveDatabasePath } from './db.ts'
import { isSubagentSession } from './lineage.ts'
import { toCategoryCounts, toMemoryView, toProvenanceView, toSessionView } from './views.ts'
import { parseInstructions } from './import.ts'
import { DEFAULT_RELEVANCE_WEIGHTS } from '../domain/score.ts'
import {
  PROMPT_LITERAL_BRACES, escapePromptText, renderSessionContext, renderSessionEndReminder,
} from '../domain/rules.ts'
import { MemoryForbiddenError } from '../domain/authorship.ts'
import {
  IMPORT_ENTRY_LIMIT, MemoryInputError, MemoryNotFoundError, parseCreate, parseImport, parseListQuery,
  parseSearchQuery, parseUpdate,
} from '../domain/validate.ts'
import { MEMORY_CATEGORIES, type CreateMemoryInput, type MemoryCategory } from '../domain/types.ts'
import type { EmbeddingEngine, EmbeddingProviderInfo } from '../embedding/index.ts'
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
  // The manager writes as the user, who is never refused on authorship; mapped anyway so a refusal
  // reaching an endpoint is a readable rejection rather than a transport fault.
  if (error instanceof MemoryForbiddenError) return { ok: false, code: 'invalid', message: error.message }
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

/**
 * A live agent, as the `agents` service and the agent events hand it over.
 *
 * Derived from the service rather than imported from `@deepseek-ai/dsh-agent` by name, so the type
 * is always the one the running harness declares — a linked development checkout and the installed
 * release can otherwise disagree about it.
 */
type Agent = ReturnType<Context['agents']['list']>[number]

/** One agent's tie to the project whose rules bind it. */
interface AgentBinding {
  /** The directory the agent's session works in; re-resolved when the database path changes. */
  readonly cwd: string
  /** Whether the agent is a delegated subagent, which gets rules but no memory session. */
  readonly subagent: boolean
  /** The project the agent is bound to right now; replaced when its cwd resolves to another file. */
  project: ProjectMemory
  /** The agent-scoped registration of the rule section, disposed with the agent. */
  fiber?: ReturnType<Context['inject']>
}

/** Why an agent is being bound: its session just started, or it was running before this plugin was. */
type BindReason = 'session-start' | 'already-running'

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
  /** Projects keyed by canonical database path, including ones still opening; opened on first touch. */
  private readonly projects = new Map<string, Promise<ProjectMemory>>()
  /** Projects that finished opening, for the synchronous prompt path that cannot await an open. */
  private readonly opened = new Map<string, ProjectMemory>()
  /** Canonical database path per project root and configured path, so assembly does no disk I/O. */
  private readonly keys = new Map<string, string>()
  /** Every agent this instance has bound, from the moment binding begins. */
  private readonly attached = new Set<Agent>()
  /** The bound agents' projects and rule sections. */
  private readonly bindings = new Map<Agent, AgentBinding>()
  /** Agents that have already been reminded to file a summary, under the `once` policy. */
  private readonly reminded = new WeakSet<Agent>()
  /** The mounted provider as {@link ProjectMemory} consumes it, once its identity is known. */
  private embedder: Promise<Embedder | undefined> = Promise.resolve(undefined)
  /** Bumped on every provider mount and unmount, so a slow describe() cannot attach a stale one. */
  private embedderGeneration = 0
  /** The database path open projects were resolved under, to notice when a settings change moves it. */
  private appliedDatabasePath: string
  private source: () => Config

  /**
   * @param ctx - Host context; the embedding provider is resolved optionally so a deployment
   *   without one still gets lexical ranking and every other feature.
   * @param config - the composition-layer memory preferences.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.source = () => config
    this.appliedDatabasePath = config.databasePath
    installSettingsSection(ctx, MEMORY_SETTINGS_NAMESPACE, MemoryService.Config, config, {
      setSource: (current) => { this.source = current },
      // Ranking, retention, and injection settings are read inside each call and each prompt
      // assembly — open projects read them through a function — so a committed change reaches the
      // next request with nothing to rebuild. A moved database is the one change that re-resolves
      // projects, and that happens here.
      onChange: () => { this.applySettings() },
    })

    ctx.on('agent/session-start', ({ agent }) => { this.bind(agent, 'session-start') })
    ctx.on('agent/turn-stopping', ({ agent }) => { this.onTurnStopping(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.onAgentDisposed(agent) })

    // A provider can mount after projects are open, go away, or be reconfigured (which remounts it),
    // so attachment follows its lifecycle rather than being decided once at project open.
    ctx.inject(['memoryEmbedding'], (scope) => {
      this.useEmbeddingEngine(scope.memoryEmbedding)
      scope.effect(() => () => { this.useEmbeddingEngine(undefined) }, 'dsh-memory: detach embedding provider')
    })

    ctx.effect(() => async () => {
      const bindings = [...this.bindings.values()]
      this.bindings.clear()
      this.attached.clear()
      await Promise.all(bindings.map(binding => binding.fiber?.dispose()))
      const projects = [...this.projects.values()]
      this.projects.clear()
      this.opened.clear()
      await Promise.all(projects.map(async (pending) => {
        // A project still opening must finish before it can be closed; a project that FAILED to open
        // holds no database, so there is nothing to release and the rejection is already reported.
        await pending.then(project => project.close(), () => {})
      }))
    }, 'dsh-memory: close project memories')

    // A reloaded plugin starts after its agents did: their session-start has already fired, and
    // without this they would run on with no rule section at all until their next session.
    for (const agent of ctx.agents.list()) this.bind(agent, 'already-running')
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
      // Zero is how a numeric setting says "never", since the schema has no null to offer; `null` is
      // how the retention table says it.
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
   * The canonical database path a project root resolves to under the current configuration.
   *
   * Cached, because the prompt path calls this on every assembly and canonicalising touches the disk.
   * @param root - absolute project directory.
   * @returns the canonical path, the key a project is opened under.
   * @throws Error when the database directory cannot be created or resolved.
   */
  private keyFor(root: string): string {
    const configured = this.source().databasePath
    const cacheKey = `${root}\u0000${configured}`
    const cached = this.keys.get(cacheKey)
    if (cached !== undefined) return cached
    const key = canonicalDatabasePath(resolveDatabasePath(root, configured))
    this.keys.set(cacheKey, key)
    return key
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
    // Keyed by the file, not by the string a caller named the project with: the session's cwd and
    // the browser's workspace root can spell one directory differently, and two ProjectMemory objects
    // over one database would each hold their own rule cache and sessions.
    let key: string
    try {
      key = this.keyFor(root)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const path = resolveDatabasePath(root, this.source().databasePath)
      throw new MemoryStoreError(`could not open the memory database at "${path}": ${message}`)
    }
    const existing = this.projects.get(key)
    if (existing !== undefined) return existing
    const opening = (async () => {
      const store = await MemoryStore.open(key)
      // Options are read per call, so a settings change reaches this project without reopening it.
      const project = new ProjectMemory(store, () => ({ ...this.optionsFor(root), databasePath: key }))
      try {
        await project.refreshRules(Date.now())
        // Visible to the synchronous prompt path only once its rule cache is filled, so an agent
        // re-bound to it never reads an empty block in between.
        this.opened.set(key, project)
        const pending = this.embedder
        const embedder = await pending
        // A provider that mounted or went away during the wait has already been applied to every
        // opened project, this one included; applying the older answer now would undo it.
        if (pending === this.embedder) project.setEmbedder(embedder)
        return project
      } catch (error) {
        if (this.opened.get(key) === project) this.opened.delete(key)
        await project.close()
        throw error
      }
    })()
    this.projects.set(key, opening)
    opening.catch(() => { if (this.projects.get(key) === opening) this.projects.delete(key) })
    return opening
  }

  /**
   * Attach a provider to every open project, or detach the one that went away.
   *
   * The identity vectors are stamped with is resolved BEFORE anything is embedded. Stamping a
   * placeholder and correcting it once the provider described itself made every restart re-embed the
   * whole project, because the stored stamp no longer matched the corrected one.
   * @param engine - the mounted provider, or undefined when it unmounted.
   */
  private useEmbeddingEngine(engine: EmbeddingEngine | undefined): void {
    this.embedderGeneration += 1
    const generation = this.embedderGeneration
    const resolving = engine === undefined ? Promise.resolve(undefined) : this.identify(engine)
    this.embedder = resolving
    void resolving.then((embedder) => {
      if (generation !== this.embedderGeneration) return
      for (const project of this.opened.values()) project.setEmbedder(embedder)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: could not attach the embedding provider: ${String(error)}`)
    })
  }

  /**
   * Learn a provider's model and dimension, and wrap it as {@link ProjectMemory} consumes it.
   * @param engine - the mounted provider.
   * @returns the embedder, or undefined when the provider cannot describe itself — attaching it under
   *   a guessed identity would mis-stamp every vector it produced.
   */
  private async identify(engine: EmbeddingEngine): Promise<Embedder | undefined> {
    let info: EmbeddingProviderInfo
    try {
      info = await engine.describe()
    } catch (error) {
      this.ctx.logger.warn(`dsh-memory: the embedding provider could not describe itself; ranking lexically: ${String(error)}`)
      return undefined
    }
    return {
      model: info.model ?? info.provider,
      ...info.dimensions === undefined ? {} : { dimensions: info.dimensions },
      embed: (texts, signal) => engine.embed(texts, signal),
    }
  }

  /**
   * Describe the mounted embedding provider, for the manager's header.
   * @returns the provider's readiness, or an absent provider.
   */
  private async describeEmbedding(): Promise<EmbeddingProviderInfo & { available: boolean }> {
    const engine = this.ctx.get('memoryEmbedding')
    if (engine === undefined) {
      return { available: false, provider: 'none', ready: false, detail: 'no embedding provider is mounted' }
    }
    return { ...await engine.describe(), available: true }
  }

  /** React to a committed settings change: only a moved database needs more than the next read. */
  private applySettings(): void {
    const databasePath = this.source().databasePath
    if (databasePath === this.appliedDatabasePath) return
    this.appliedDatabasePath = databasePath
    void this.moveProjects().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: could not move to the new database path: ${String(error)}`)
    })
  }

  /**
   * Re-resolve every live agent's project after the database path changed, then release the files
   * nothing reaches any more.
   *
   * Tools resolve their project per call, so without this they would write the new file while each
   * live agent's rule section kept reading the old one — two halves of one agent disagreeing about
   * which rules exist.
   */
  private async moveProjects(): Promise<void> {
    const config = this.source()
    for (const [agent, binding] of [...this.bindings]) {
      const next = await this.project(binding.cwd)
      if (next === binding.project) continue
      binding.project.releaseSession(agent.id)
      binding.project = next
      if (!binding.subagent && config.autoSession) await next.startSession(Date.now(), agent.id)
    }
    const stale = [...this.opened].filter(([key, project]) => this.keyFor(project.projectRoot) !== key)
    for (const [key] of stale) {
      this.opened.delete(key)
      this.projects.delete(key)
    }
    await Promise.all(stale.map(([, project]) => project.close()))
  }

  // ---------- harness hooks ----------

  /**
   * Bind an agent to its project: install its rule section, and — for a top-level agent — open its
   * memory session and seed its opening context.
   *
   * Everything past the synchronous guard is detached. `agent/session-start` is a notification the
   * loop does not await, so a slow first database open must not delay the first request — the rule
   * section reads the cached block, which is correct from the moment the open completes.
   *
   * A subagent gets the rules and nothing else. It works in its parent's directory and fires its own
   * session-start, but it is not a new session of the project: starting a memory session for it
   * would replace nothing of its own and would compete with its parent's, and re-sending the
   * project history spends its context on what its brief already carries.
   * @param agent - the agent to bind.
   * @param reason - a fresh session gets its opening context; an agent that was already running when
   *   this plugin started has had it, and gets only its rules and a session to file against.
   */
  private bind(agent: Agent, reason: BindReason): void {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || this.attached.has(agent)) return
    this.attached.add(agent)
    const subagent = isSubagentSession(agent.session.header)
    const config = this.source()
    void (async () => {
      const project = await this.project(cwd)
      if (!this.attached.has(agent)) return
      this.installRules(agent, { cwd, subagent, project })
      if (subagent || !config.autoSession) return
      const context = await project.startSession(Date.now(), agent.id)
      if (reason === 'already-running' || !config.injectSessionContext) return
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
   *
   * The literal-brace variable is registered beside the section because the section's text is
   * escaped against it; the renderer resolves variables from the same scope chain, so the two cannot
   * be separated.
   * @param agent - the agent to bind.
   * @param binding - its directory, lineage, and project.
   */
  private installRules(agent: Agent, binding: AgentBinding): void {
    if (this.bindings.has(agent)) return
    this.bindings.set(agent, binding)
    binding.fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.variable(PROMPT_LITERAL_BRACES.name, () => PROMPT_LITERAL_BRACES.value)
      scope.systemPrompt.section({
        name: RULES_SECTION,
        order: RULES_ORDER,
        text: () => this.rulesSection(binding),
      })
    })
  }

  /**
   * The rule section's text for one assembly.
   * @param binding - the agent's binding.
   * @returns the escaped rule block, or `''` when enforcement is off or the project has no rules.
   */
  private rulesSection(binding: AgentBinding): string {
    if (!this.source().injectRules) return ''
    return escapePromptText(this.currentProject(binding).rulesBlock())
  }

  /**
   * The project an agent's directory resolves to right now, re-binding the agent when it moved.
   *
   * Synchronous, because prompt assembly is. When the resolved project is not open yet, it is opened
   * for the next assembly and the agent keeps the rules it was bound by until then: one request under
   * the previous rule set is a smaller failure than one request under none.
   * @param binding - the agent's binding.
   * @returns the project to read.
   */
  private currentProject(binding: AgentBinding): ProjectMemory {
    let key: string
    try {
      key = this.keyFor(binding.cwd)
    } catch (error) {
      this.ctx.logger.warn(`dsh-memory: could not resolve the memory database for "${binding.cwd}": ${String(error)}`)
      return binding.project
    }
    if (key === binding.project.databasePath) return binding.project
    const current = this.opened.get(key)
    if (current !== undefined) {
      binding.project = current
      return current
    }
    this.project(binding.cwd).catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-memory: could not open memory for "${binding.cwd}": ${String(error)}`)
    })
    return binding.project
  }

  /**
   * Remind the model to file a session summary at the turn's stop boundary.
   *
   * Under `once` the reminder lands on the first turn that reaches a stop boundary WITH a session to
   * file against, and never again — which is the difference between a prompt the model acts on and
   * one it learns to ignore. The policy is spent only when a reminder is actually sent; a turn with
   * no session of its own must not use it up.
   * @param agent - the agent whose turn is closing.
   */
  private onTurnStopping(agent: Agent): void {
    const config = this.source()
    if (config.remind === 'never' || !config.autoSession) return
    if (config.remind === 'once' && this.reminded.has(agent)) return
    const binding = this.bindings.get(agent)
    if (binding === undefined || binding.subagent) return
    const project = this.currentProject(binding)
    const sessionId = project.sessionIdFor(agent.id)
    if (sessionId === undefined) return
    if (config.remind === 'once') this.reminded.add(agent)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderSessionEndReminder(project.project, sessionId) }],
      source: { kind: 'plugin', plugin: 'dsh-memory' },
    }))
  }

  /**
   * Drop the agent's rule section and forget its memory session when the agent goes away.
   *
   * The project's database stays open: another agent may share it, and reopening a DuckDB file costs
   * a lock round trip that the plugin's own teardown handles once instead. The session row stays open
   * too, and the next start closes it as an orphan — nobody filed its summary.
   * @param agent - the disposed agent.
   */
  private onAgentDisposed(agent: Agent): void {
    this.attached.delete(agent)
    const binding = this.bindings.get(agent)
    if (binding === undefined) return
    this.bindings.delete(agent)
    binding.project.releaseSession(agent.id)
    binding.fiber?.dispose().catch((error: unknown) => {
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
      // The browser is a trust boundary like the model is: the same validation, the same ceilings.
      // A blank text filter is the search box being empty, not a request to match the empty string.
      const text = request.text?.trim()
      const query = parseListQuery({
        ...request.status === undefined ? {} : { status: request.status },
        ...request.category === undefined ? {} : { category: request.category },
        ...request.tags === undefined ? {} : { tags: request.tags },
        ...text === undefined || text.length === 0 ? {} : { text },
        ...request.limit === undefined ? {} : { limit: request.limit },
        ...request.offset === undefined ? {} : { offset: request.offset },
        ...request.sortBy === undefined ? {} : { sortBy: request.sortBy },
        ...request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder },
      })
      const page = await project.list(query, Date.now())
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
      const query = parseSearchQuery({
        query: request.query,
        limit: request.limit ?? this.source().searchLimit,
        ...request.category === undefined ? {} : { category: request.category },
        ...request.tags === undefined ? {} : { tags: request.tags },
        ...request.minSimilarity === undefined ? {} : { minSimilarity: request.minSimilarity },
      })
      const result = await project.search(query, Date.now(), signal)
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
      const { text, source } = parseImport({ text: request.text, source: request.source })
      const project = await this.project(request.project)
      const now = Date.now()
      const parsed = parseInstructions(text)
      if (parsed.length === 0) {
        return { ok: false, code: 'invalid', message: 'nothing in that file looked like a rule or a note' }
      }
      if (parsed.length > IMPORT_ENTRY_LIMIT) {
        throw new MemoryInputError(`that file holds ${parsed.length} entries; an import creates at most ${IMPORT_ENTRY_LIMIT}`)
      }
      // Every entry is validated before the first is written, with the ceilings a memory typed into
      // the manager gets, so a bad entry refuses the import instead of leaving half of it behind.
      const inputs = parsed.map(entry => MemoryService.importEntry(entry, source))
      const created = []
      for (const input of inputs) {
        const written = await project.create(input, 'user', now)
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
   * Validate one parsed import entry as a create request.
   * @param entry - what the instructions parser produced.
   * @param source - the source label every imported memory records.
   * @returns the accepted input.
   * @throws MemoryInputError naming the entry when a field is rejected.
   */
  private static importEntry(entry: CreateMemoryInput, source: string): CreateMemoryInput {
    try {
      return parseCreate({ ...entry, source })
    } catch (error) {
      if (!(error instanceof MemoryInputError)) throw error
      throw new MemoryInputError(`imported entry "${entry.title.slice(0, 60)}": ${error.message}`)
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
      const project = await this.project(request.project)
      // Let the background pass finish first, so this pass does not embed the same rows beside it.
      await project.whenEmbedded()
      const embedded = await project.drainEmbeddings()
      return { ok: true, embedded, remaining: await project.pendingEmbeddings(Date.now()) }
    } catch (error) {
      return failure(error)
    }
  }
}

export default MemoryService
