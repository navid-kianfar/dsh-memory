/**
 * The vocabulary both halves of the plugin speak: what a memory is, which kinds exist, and the
 * request and response records that cross the RPC and tool surfaces.
 *
 * Every type here is JSON-shaped on purpose. The browser half receives these values through the
 * Typert gateway and the model half receives them as tool results, so a field that cannot survive
 * `JSON.parse(JSON.stringify(x))` cannot live in this module — timestamps are epoch milliseconds
 * rather than `Date`, and absent values are omitted rather than `undefined`-valued.
 *
 * @module @achasoft/dsh-memory/domain/types
 */

/**
 * Every kind of thing a project can remember.
 *
 * The list is closed: a category decides retention, default priority, and whether an entry is
 * enforced as a rule, so an open vocabulary would make those decisions unanswerable. `session` is
 * written by the plugin itself when a session summary is persisted; the rest are authored.
 */
export const MEMORY_CATEGORIES = [
  'decision',
  'architecture',
  'devops',
  'feedback',
  'reference',
  'sprint',
  'project_plan',
  'developer_docs',
  'session',
  'mandatory_rules',
  'forbidden_rules',
] as const

/** One of {@link MEMORY_CATEGORIES}. */
export type MemoryCategory = typeof MEMORY_CATEGORIES[number]

/**
 * The two categories that are enforced rather than recalled.
 *
 * Entries in these categories are injected into every model request verbatim and completely, never
 * ranked or truncated, which is what separates a rule from a decision that merely records the same
 * fact.
 */
export const RULE_CATEGORIES = ['mandatory_rules', 'forbidden_rules'] as const

/** One of {@link RULE_CATEGORIES}. */
export type RuleCategory = typeof RULE_CATEGORIES[number]

/** How a rule is stated to the model: something to always do, or never do. */
export type RuleType = 'mandatory' | 'forbidden'

/** The `mandatory`/`forbidden` spelling used by tool arguments, mapped to storage categories. */
export const RULE_TYPE_CATEGORY: Readonly<Record<RuleType, RuleCategory>> = {
  mandatory: 'mandatory_rules',
  forbidden: 'forbidden_rules',
}

/**
 * Lifecycle state of a stored memory.
 *
 * `archived` is a deletion the user can undo; `expired` is the same state reached by the retention
 * clock rather than by a person. Both are excluded from recall, and both keep the row so provenance
 * stays answerable.
 */
export type MemoryStatus = 'active' | 'archived' | 'expired'

/** Every {@link MemoryStatus}, for validation and for the UI's status filter. */
export const MEMORY_STATUSES = ['active', 'archived', 'expired'] as const

/** Lowest and highest accepted {@link Memory.priority}. */
export const PRIORITY_MIN = 0

/** Highest accepted {@link Memory.priority}; rules are forced to at least {@link RULE_MIN_PRIORITY}. */
export const PRIORITY_MAX = 3

/**
 * The floor a rule's priority is raised to on write.
 *
 * A rule that sorted below an ordinary note would be rendered late in the injected block and read as
 * an afterthought, so the floor is part of what "rule" means rather than a default the author picks.
 */
export const RULE_MIN_PRIORITY = 2

/** One stored memory, as every surface sees it. */
export interface Memory {
  /** Stable identity (UUID v4), assigned on insert and never reused. */
  readonly id: string
  /** Which kind of thing this is; decides retention and rule enforcement. */
  readonly category: MemoryCategory
  /** One-line name, unique enough for `memory_recall` to find by title. */
  readonly title: string
  /** The full text. This is what a model reads when the memory is recalled. */
  readonly content: string
  /** Derived one-line abstract shown in listings and in token-budgeted search indexes. */
  readonly summary: string
  /** Author-supplied labels, used for filtering. */
  readonly tags: readonly string[]
  /** Author-supplied JSON sidecar; the plugin never interprets it. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Lifecycle state; only `active` memories are recalled or enforced. */
  readonly status: MemoryStatus
  /** `0`–`3`, higher first within a category. */
  readonly priority: number
  /** Who wrote it: `assistant`, `user`, `imported`, or a caller-supplied label. */
  readonly source: string
  /** Ids of related memories; the plugin stores and returns them without following them. */
  readonly relatedIds: readonly string[]
  /** Capitalised terms and identifiers extracted from the text, used to boost lexical matches. */
  readonly entities: readonly string[]
  /** How many times this memory has been recalled or returned by a search. */
  readonly accessCount: number
  /** Retention deadline in epoch milliseconds; absent means it never expires. */
  readonly expiresAt?: number
  /** Creation time in epoch milliseconds. */
  readonly createdAt: number
  /** Last modification time in epoch milliseconds. */
  readonly updatedAt: number
  /** Whether a vector is stored for this memory, so a UI can show what semantic search covers. */
  readonly embedded: boolean
}

/** Input accepted by a create. Absent optional fields take their documented defaults. */
export interface CreateMemoryInput {
  readonly category: MemoryCategory
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
  /** `0`–`3`; a rule is raised to {@link RULE_MIN_PRIORITY} regardless. */
  readonly priority?: number
  /** Defaults to `assistant`. */
  readonly source?: string
  readonly relatedIds?: readonly string[]
}

/**
 * Input accepted by an update. Every field is optional and an absent field is left untouched — this
 * is a patch, so clearing a list means passing an empty array, not omitting it.
 */
export interface UpdateMemoryInput {
  readonly id: string
  readonly title?: string
  readonly content?: string
  readonly tags?: readonly string[]
  /** `null` clears the stored sidecar; omitting the field leaves it untouched. */
  readonly metadata?: Readonly<Record<string, unknown>> | null
  readonly status?: MemoryStatus
  readonly priority?: number
  readonly relatedIds?: readonly string[]
  readonly category?: MemoryCategory
}

/** Sort keys a listing accepts; each maps to one indexed column. */
export const MEMORY_SORT_KEYS = ['updatedAt', 'createdAt', 'title', 'priority', 'accessCount', 'category'] as const

/** One of {@link MEMORY_SORT_KEYS}. */
export type MemorySortKey = typeof MEMORY_SORT_KEYS[number]

/** Filters and paging for a listing. Every field is optional. */
export interface ListMemoriesQuery {
  /** Defaults to `active`. Pass `all` to include archived and expired rows. */
  readonly status?: MemoryStatus | 'all'
  readonly category?: MemoryCategory
  /** Matches a memory carrying ANY of these tags. */
  readonly tags?: readonly string[]
  /** Case-insensitive substring match against title, summary, and content. */
  readonly text?: string
  readonly limit?: number
  readonly offset?: number
  readonly sortBy?: MemorySortKey
  readonly sortOrder?: 'asc' | 'desc'
}

/** One page of a listing, with the unpaged total so a UI can render "n of m". */
export interface MemoryPage {
  readonly memories: readonly Memory[]
  /** Rows matching the filters before `limit`/`offset` were applied. */
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** What to search for and how much to bring back. */
export interface SearchQuery {
  readonly query: string
  readonly category?: MemoryCategory
  readonly tags?: readonly string[]
  /** Defaults to 10. */
  readonly limit?: number
  /**
   * Drop hits scoring below this, on the same `0`–`1` scale as {@link SearchHit.similarity}.
   * Defaults to a permissive floor because a lexical-only ranking scores lower than a vector one.
   */
  readonly minSimilarity?: number
  /**
   * When set, return a compact index of every hit plus full content only for as many hits as fit in
   * this many estimated tokens. The caller sees what it did not receive rather than a silent cut.
   */
  readonly tokenBudget?: number
}

/** One ranked search result. */
export interface SearchHit {
  readonly memory: Memory
  /** Match strength on a `0`–`1` scale: cosine similarity when vectors were used, else the lexical score. */
  readonly similarity: number
  /** The ordering score: {@link similarity} blended with recency and access frequency. */
  readonly relevance: number
  /** Which signals produced this hit, so a UI can explain why it matched. */
  readonly matched: readonly ('lexical' | 'vector')[]
}

/** A compact stand-in for a hit whose content did not fit the token budget. */
export interface SearchIndexEntry {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly category: MemoryCategory
  readonly similarity: number
}

/** Search results, with the token-budget split when one was requested. */
export interface SearchResult {
  readonly query: string
  /** Every hit above the floor, in ranked order. */
  readonly index: readonly SearchIndexEntry[]
  /** Hits returned in full. Equal to every hit unless a `tokenBudget` cut it short. */
  readonly hits: readonly SearchHit[]
  readonly total: number
  /** Estimated tokens the returned {@link hits} consume. */
  readonly tokensUsed: number
  /** True when {@link index} lists hits absent from {@link hits}. */
  readonly hasMore: boolean
  /** Whether stored vectors participated; false means the ranking was lexical only. */
  readonly semantic: boolean
}

/** The complete, unranked rule set of a project. */
export interface RuleSet {
  readonly mandatory: readonly Memory[]
  readonly forbidden: readonly Memory[]
  /** `mandatory.length + forbidden.length`, so a caller can test emptiness without two reads. */
  readonly total: number
}

/** One recorded working session against this project's memory. */
export interface MemorySession {
  readonly id: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly summary?: string
  readonly memoriesCreated: number
  readonly memoriesAccessed: number
}

/** Operations recorded in the audit trail. */
export const PROVENANCE_OPERATIONS = [
  'create', 'update', 'access', 'archive', 'restore', 'delete', 'import', 'expire',
] as const

/** One of {@link PROVENANCE_OPERATIONS}. */
export type ProvenanceOperation = typeof PROVENANCE_OPERATIONS[number]

/** One entry of a memory's audit trail. */
export interface ProvenanceEntry {
  readonly seq: number
  readonly memoryId: string
  readonly operation: ProvenanceOperation
  /** Operation-specific facts: changed field names, an import source, a deletion reason. */
  readonly details?: Readonly<Record<string, unknown>>
  /** What performed it: `agent`, `user`, or a caller-supplied label. */
  readonly actor: string
  readonly at: number
}

/** The context a session opens with: the rules it must follow and what happened last time. */
export interface SessionContext {
  readonly sessionId: string
  /** The project slug, derived from the project directory name. */
  readonly project: string
  readonly mandatory: readonly Memory[]
  readonly forbidden: readonly Memory[]
  /** Summary of the last session that actually ended with one, if any. */
  readonly lastSummary?: string
  readonly sprint: readonly Memory[]
  readonly recentDecisions: readonly Memory[]
  /** Sessions left open by a crash or context overflow, closed by this start. */
  readonly orphansClosed: number
}

/** Per-category counts, plus the totals a UI header shows. */
export interface MemoryStats {
  readonly total: number
  readonly active: number
  readonly archived: number
  readonly expired: number
  /** Active count per category; a category with no active rows is absent. */
  readonly byCategory: Readonly<Partial<Record<MemoryCategory, number>>>
  /** Active memories carrying a stored vector. */
  readonly embedded: number
}
