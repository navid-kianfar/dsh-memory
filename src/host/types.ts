/**
 * The Host endpoint's wire vocabulary — every value that crosses the Typert gateway between this
 * plugin's Node half and its browser half.
 *
 * These are deliberately not the domain types. The generator turns each of them into a runtime
 * schema, so they stay to primitives, arrays, and unions of string literals: a memory's JSON sidecar
 * travels as `metadataJson` text rather than as an open record, because an index signature has no
 * honest schema and a wire value the browser cannot validate is worse than one it has to parse.
 *
 * Every endpoint answers a union tagged with `ok`. A validation rejection is a normal outcome of a
 * form the user is still filling in, and the gateway erases a thrown business exception's
 * classification — so failures are returned as values and only transport faults throw.
 *
 * @module @achasoft/dsh-memory/host/types
 */

/** Every kind of thing a project can remember, as the wire spells it. */
export type MemoryCategoryWire =
  | 'decision' | 'architecture' | 'devops' | 'feedback' | 'reference' | 'sprint' | 'project_plan'
  | 'developer_docs' | 'session' | 'mandatory_rules' | 'forbidden_rules'

/** Lifecycle state of a stored memory, as the wire spells it. */
export type MemoryStatusWire = 'active' | 'archived' | 'expired'

/** Sort keys the manager's listing offers. */
export type MemorySortWire = 'updatedAt' | 'createdAt' | 'title' | 'priority' | 'accessCount' | 'category'

/** One stored memory as the browser receives it. */
export interface MemoryView {
  readonly id: string
  readonly category: MemoryCategoryWire
  readonly title: string
  readonly content: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly entities: readonly string[]
  readonly relatedIds: readonly string[]
  /** The JSON sidecar as text, absent when the memory carries none. */
  readonly metadataJson?: string
  readonly status: MemoryStatusWire
  readonly priority: number
  readonly source: string
  readonly accessCount: number
  /** Retention deadline in epoch milliseconds; absent means it never expires. */
  readonly expiresAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  /** Whether a vector is stored, so the manager can show what semantic search covers. */
  readonly embedded: boolean
}

/** One ranked search result as the browser receives it. */
export interface MemoryHitView {
  readonly memory: MemoryView
  readonly similarity: number
  readonly relevance: number
  /** Which signals produced the hit: `lexical`, `vector`, or both. */
  readonly matched: readonly string[]
}

/** One recorded working session. */
export interface MemorySessionView {
  readonly id: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly summary?: string
  readonly memoriesCreated: number
  readonly memoriesAccessed: number
}

/** One entry of a memory's audit trail. */
export interface MemoryProvenanceView {
  readonly seq: number
  readonly memoryId: string
  readonly operation: string
  readonly actor: string
  readonly at: number
  /** Operation-specific facts as JSON text, absent when the entry carries none. */
  readonly detailsJson?: string
}

/** What the project holds, by status and by category. */
export interface MemoryStatsView {
  readonly total: number
  readonly active: number
  readonly archived: number
  readonly expired: number
  readonly embedded: number
  /** Active count per category, as `category` / `count` pairs so the wire needs no index signature. */
  readonly byCategory: readonly MemoryCategoryCount[]
}

/** One category's active count. */
export interface MemoryCategoryCount {
  readonly category: MemoryCategoryWire
  readonly count: number
}

/** Whether semantic ranking is available, and why not when it is not. */
export interface MemoryEmbeddingView {
  /** Whether a provider is mounted at all. */
  readonly available: boolean
  /** The provider's plugin identity, when one is mounted. */
  readonly provider?: string
  /** The embedding model, when the provider names one. */
  readonly model?: string
  /** Whether a call would be attempted; false means configuration is missing. */
  readonly ready: boolean
  /** Why it is not ready, in words a person can act on. Never a secret. */
  readonly detail?: string
}

/** Everything the manager needs to render its header and empty states. */
export interface MemoryOverview {
  /** The project slug, derived from the project directory name. */
  readonly project: string
  /** Absolute path of the project this memory belongs to. */
  readonly projectRoot: string
  /** Absolute path of the DuckDB file, so the manager can tell the user where their memory lives. */
  readonly databasePath: string
  readonly stats: MemoryStatsView
  readonly embedding: MemoryEmbeddingView
  /** Live mandatory rules. */
  readonly mandatory: readonly MemoryView[]
  /** Live forbidden rules. */
  readonly forbidden: readonly MemoryView[]
  /** The rules block exactly as the model receives it, or `''` when there are none. */
  readonly rulesBlock: string
  /** Whether the plugin is injecting that block into model requests right now. */
  readonly enforcing: boolean
}

/** A failure returned as a value, with a class the browser can branch on. */
export interface MemoryFailure {
  readonly ok: false
  /** `invalid` for a rejected field, `not-found` for an unknown id, `unavailable` for the store itself. */
  readonly code: 'invalid' | 'not-found' | 'unavailable'
  readonly message: string
}

/** The overview, or why it could not be read. */
export type MemoryOverviewResult = { readonly ok: true, readonly overview: MemoryOverview } | MemoryFailure

/** Filters and paging for the manager's listing. */
export interface MemoryListRequest {
  /** Absolute path of the project to read; absent uses the Host's default project. */
  readonly project?: string
  /** `all` includes archived and expired memories. */
  readonly status?: MemoryStatusWire | 'all'
  readonly category?: MemoryCategoryWire
  readonly tags?: readonly string[]
  /** Case-insensitive substring filter over title, summary, and content. */
  readonly text?: string
  readonly limit?: number
  readonly offset?: number
  readonly sortBy?: MemorySortWire
  readonly sortOrder?: 'asc' | 'desc'
}

/** One page of the listing, or why it could not be read. */
export type MemoryListResult = {
  readonly ok: true
  readonly memories: readonly MemoryView[]
  readonly total: number
  readonly limit: number
  readonly offset: number
} | MemoryFailure

/** A ranked search from the manager's search box. */
export interface MemorySearchRequest {
  readonly project?: string
  readonly query: string
  readonly category?: MemoryCategoryWire
  readonly tags?: readonly string[]
  readonly limit?: number
  readonly minSimilarity?: number
}

/** The ranked hits, or why the search could not run. */
export type MemorySearchResult = {
  readonly ok: true
  readonly query: string
  readonly hits: readonly MemoryHitView[]
  readonly total: number
  /** Whether stored vectors participated; false means the ranking was lexical only. */
  readonly semantic: boolean
} | MemoryFailure

/** A new memory written from the manager. */
export interface MemoryCreateRequest {
  readonly project?: string
  readonly category: MemoryCategoryWire
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly priority?: number
  /** The JSON sidecar as text; invalid JSON is rejected rather than stored. */
  readonly metadataJson?: string
}

/** An edit from the manager. Only supplied fields change. */
export interface MemoryUpdateRequest {
  readonly project?: string
  readonly id: string
  readonly category?: MemoryCategoryWire
  readonly title?: string
  readonly content?: string
  readonly tags?: readonly string[]
  readonly priority?: number
  readonly status?: MemoryStatusWire
  /** The JSON sidecar as text; an empty string clears it. */
  readonly metadataJson?: string
}

/** Archiving or permanently removing a memory. */
export interface MemoryRemoveRequest {
  readonly project?: string
  readonly id: string
  /** True removes the row and its audit trail; false archives it, leaving it restorable. */
  readonly hard: boolean
}

/** The written memory, or why the write was refused. */
export type MemoryWriteResult = {
  readonly ok: true
  readonly memory: MemoryView
  /** True when the write changed the rule set the model is bound by. */
  readonly rulesChanged: boolean
} | MemoryFailure

/** Whether the removal happened, or why it was refused. */
export type MemoryRemoveResult = {
  readonly ok: true
  readonly removed: boolean
  readonly rulesChanged: boolean
} | MemoryFailure

/** Which project's sessions or trail to read. */
export interface MemoryProjectRequest {
  readonly project?: string
}

/** Recent sessions, or why they could not be read. */
export type MemorySessionsResult = {
  readonly ok: true
  readonly sessions: readonly MemorySessionView[]
} | MemoryFailure

/** One memory's audit trail request. */
export interface MemoryProvenanceRequest {
  readonly project?: string
  readonly id: string
}

/** The audit trail, or why it could not be read. */
export type MemoryProvenanceResult = {
  readonly ok: true
  readonly entries: readonly MemoryProvenanceView[]
} | MemoryFailure

/** An import of an existing instructions file. */
export interface MemoryImportRequest {
  readonly project?: string
  /** The file's text, as the browser read it. */
  readonly text: string
  /** Label recorded as each imported memory's source, such as the file name. */
  readonly source: string
}

/** What an import created, or why it was refused. */
export type MemoryImportResult = {
  readonly ok: true
  readonly imported: number
  readonly rules: number
  readonly memories: readonly MemoryView[]
} | MemoryFailure

/** Every memory as portable JSON, or why it could not be read. */
export type MemoryExportResult = {
  readonly ok: true
  /** The export document as JSON text, ready to save or commit. */
  readonly json: string
  readonly count: number
} | MemoryFailure

/** What a re-embed pass did, or why it could not run. */
export type MemoryEmbedResult = {
  readonly ok: true
  readonly embedded: number
  readonly remaining: number
} | MemoryFailure

/** The plugin's own settings, as the settings card reads and writes them. */
export interface MemorySettings {
  /** Path of the DuckDB file relative to the project root, or an absolute path. */
  databasePath: string
  /** Inject the project's binding rules into every model request. */
  injectRules: boolean
  /** Inject the last summary, sprint goals, and recent decisions when a session starts. */
  injectSessionContext: boolean
  /** Open and close a memory session alongside each agent session. */
  autoSession: boolean
  /** When to remind the model to file a session summary. */
  remind: 'never' | 'once' | 'every-turn'
  /** The vector signal's share of a blended similarity, `0`–`1`. */
  vectorWeight: number
  /** Similarity floor for a search that does not name one. */
  minSimilarity: number
  /** Hits a search returns when the caller does not say. */
  searchLimit: number
  /** Rows either search probe may return before the tail is left unconsidered. */
  candidateLimit: number
  /** Memories embedded per background pass. */
  embedBatch: number
  /** Which model-facing tools to register. */
  toolset: 'core' | 'full'
}
