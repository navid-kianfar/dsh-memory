/**
 * Input validation for the two untrusted boundaries this plugin has: arguments a model generated,
 * and payloads the browser sent over RPC.
 *
 * Same-process typed callers are trusted — the repository below this layer assumes valid input and
 * has no checks of its own. Everything crossing one of those two boundaries passes through here
 * first, which is why the rejections are worded for a reader who has to fix the call rather than for
 * a log.
 *
 * @module @achasoft/dsh-memory/domain/validate
 */

import {
  MEMORY_CATEGORIES, MEMORY_SORT_KEYS, MEMORY_STATUSES, PRIORITY_MAX, PRIORITY_MIN,
  RULE_TYPE_CATEGORY,
  type CreateMemoryInput, type ListMemoriesQuery, type MemoryCategory, type MemorySortKey,
  type MemoryStatus, type RuleType, type SearchQuery, type UpdateMemoryInput,
} from './types.ts'

/** Raised when a caller sends a value this plugin cannot act on. */
export class MemoryInputError extends Error {
  /**
   * @param message - what is wrong and what the caller should send instead.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryInputError'
  }
}

/** Raised when an operation names a memory the project does not hold. */
export class MemoryNotFoundError extends Error {
  /**
   * @param message - which identity was not found.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryNotFoundError'
  }
}

/** Longest accepted title; past this a title is prose that belongs in the content. */
export const TITLE_MAX_CHARS = 500

/** Longest accepted content, a guard against a runaway paste rather than a considered ceiling. */
export const CONTENT_MAX_CHARS = 200_000

/** Most tags one memory may carry. */
const MAX_TAGS = 32

/** Longest accepted tag. */
const TAG_MAX_CHARS = 64

/** Largest page a listing will return in one call. */
export const LIST_LIMIT_MAX = 500

/** Largest number of hits one search returns. */
export const SEARCH_LIMIT_MAX = 100

/**
 * Require a non-empty string within a length bound.
 * @param value - the value to check.
 * @param field - the field name used in the rejection.
 * @param max - the character ceiling.
 * @returns the trimmed value.
 * @throws MemoryInputError when the value is absent, not a string, blank, or too long.
 */
export function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new MemoryInputError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new MemoryInputError(`${field} must not be empty`)
  if (trimmed.length > max) {
    throw new MemoryInputError(`${field} must be at most ${max} characters (got ${trimmed.length})`)
  }
  return trimmed
}

/**
 * Narrow a value to one of a closed set.
 * @param value - the value to check.
 * @param allowed - every accepted member.
 * @param field - the field name used in the rejection.
 * @returns the value, narrowed.
 * @throws MemoryInputError when the value is not a member.
 */
export function requireMember<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new MemoryInputError(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`)
  }
  return value as T
}

/**
 * Narrow a value to a memory category.
 * @param value - the value to check.
 * @returns the category.
 * @throws MemoryInputError when it is not one of {@link MEMORY_CATEGORIES}.
 */
export function requireCategory(value: unknown): MemoryCategory {
  return requireMember(value, MEMORY_CATEGORIES, 'category')
}

/**
 * Map a `mandatory`/`forbidden` rule type to its storage category.
 * @param value - the rule type as a caller spelled it.
 * @returns the rule category.
 * @throws MemoryInputError when it is neither.
 */
export function requireRuleCategory(value: unknown): MemoryCategory {
  return RULE_TYPE_CATEGORY[requireMember<RuleType>(value, ['mandatory', 'forbidden'], 'rule_type')]
}

/**
 * Clean a tag list: trimmed, non-empty, deduplicated, bounded.
 * @param value - the value to check; `undefined` yields an empty list.
 * @returns the accepted tags.
 * @throws MemoryInputError when it is not an array of short non-empty strings.
 */
export function requireTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new MemoryInputError('tags must be an array of strings')
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new MemoryInputError('tags must be an array of strings')
    const tag = entry.trim()
    if (tag.length === 0) continue
    if (tag.length > TAG_MAX_CHARS) {
      throw new MemoryInputError(`tag "${tag.slice(0, 20)}…" exceeds ${TAG_MAX_CHARS} characters`)
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > MAX_TAGS) throw new MemoryInputError(`at most ${MAX_TAGS} tags are allowed`)
  return tags
}

/**
 * Require a whole number within an inclusive range.
 * @param value - the value to check.
 * @param field - the field name used in the rejection.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the number.
 * @throws MemoryInputError when it is not an integer in range.
 */
export function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MemoryInputError(`${field} must be a whole number`)
  }
  if (value < min || value > max) {
    throw new MemoryInputError(`${field} must be between ${min} and ${max} (got ${value})`)
  }
  return value
}

/**
 * Accept a caller-supplied JSON sidecar.
 * @param value - the value to check; `undefined` and `null` both mean "no metadata".
 * @returns the record, or undefined.
 * @throws MemoryInputError when it is not a plain object.
 */
export function requireMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryInputError('metadata must be a JSON object')
  }
  return value as Record<string, unknown>
}

/**
 * Accept a list of memory ids.
 * @param value - the value to check; `undefined` yields an empty list.
 * @param field - the field name used in the rejection.
 * @returns the ids, deduplicated.
 * @throws MemoryInputError when it is not an array of non-empty strings.
 */
export function requireIds(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new MemoryInputError(`${field} must be an array of memory ids`)
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new MemoryInputError(`${field} must be an array of memory ids`)
    }
    const id = entry.trim()
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Validate a create request.
 * @param raw - the caller's payload.
 * @returns the accepted input, with defaults applied.
 * @throws MemoryInputError for any rejected field.
 */
export function parseCreate(raw: Record<string, unknown>): CreateMemoryInput {
  const priority = raw['priority'] === undefined
    ? 0
    : requireInteger(raw['priority'], 'priority', PRIORITY_MIN, PRIORITY_MAX)
  const source = raw['source'] === undefined ? 'assistant' : requireText(raw['source'], 'source', 64)
  const metadata = requireMetadata(raw['metadata'])
  return {
    category: requireCategory(raw['category']),
    title: requireText(raw['title'], 'title', TITLE_MAX_CHARS),
    content: requireText(raw['content'], 'content', CONTENT_MAX_CHARS),
    tags: requireTags(raw['tags']),
    priority,
    source,
    relatedIds: requireIds(raw['related_ids'] ?? raw['relatedIds'], 'related_ids'),
    ...metadata === undefined ? {} : { metadata },
  }
}

/**
 * Validate an update request. An absent field means "leave it alone"; only supplied fields are
 * returned, so the store can tell "set to empty" apart from "not mentioned".
 * @param raw - the caller's payload.
 * @returns the accepted patch.
 * @throws MemoryInputError for any rejected field, or when nothing was supplied to change.
 */
export function parseUpdate(raw: Record<string, unknown>): UpdateMemoryInput {
  const id = requireText(raw['id'] ?? raw['memory_id'], 'id', 128)
  const patch: {
    -readonly [K in keyof UpdateMemoryInput]: UpdateMemoryInput[K]
  } = { id }
  if (raw['title'] !== undefined) patch.title = requireText(raw['title'], 'title', TITLE_MAX_CHARS)
  if (raw['content'] !== undefined) patch.content = requireText(raw['content'], 'content', CONTENT_MAX_CHARS)
  if (raw['tags'] !== undefined) patch.tags = requireTags(raw['tags'])
  if (raw['metadata'] !== undefined) patch.metadata = requireMetadata(raw['metadata']) ?? null
  if (raw['status'] !== undefined) patch.status = requireMember<MemoryStatus>(raw['status'], MEMORY_STATUSES, 'status')
  if (raw['priority'] !== undefined) {
    patch.priority = requireInteger(raw['priority'], 'priority', PRIORITY_MIN, PRIORITY_MAX)
  }
  if (raw['category'] !== undefined) patch.category = requireCategory(raw['category'])
  const related = raw['related_ids'] ?? raw['relatedIds']
  if (related !== undefined) patch.relatedIds = requireIds(related, 'related_ids')
  if (Object.keys(patch).length === 1) {
    throw new MemoryInputError('supply at least one field to change')
  }
  return patch
}

/**
 * Validate a listing query.
 * @param raw - the caller's payload.
 * @returns the accepted query, with defaults applied.
 * @throws MemoryInputError for any rejected field.
 */
export function parseListQuery(raw: Record<string, unknown>): ListMemoriesQuery {
  const query: { -readonly [K in keyof ListMemoriesQuery]: ListMemoriesQuery[K] } = {}
  if (raw['status'] !== undefined) {
    query.status = requireMember<MemoryStatus | 'all'>(raw['status'], [...MEMORY_STATUSES, 'all'], 'status')
  }
  if (raw['category'] !== undefined) query.category = requireCategory(raw['category'])
  if (raw['tags'] !== undefined) query.tags = requireTags(raw['tags'])
  if (raw['text'] !== undefined) query.text = requireText(raw['text'], 'text', TITLE_MAX_CHARS)
  if (raw['limit'] !== undefined) query.limit = requireInteger(raw['limit'], 'limit', 1, LIST_LIMIT_MAX)
  if (raw['offset'] !== undefined) query.offset = requireInteger(raw['offset'], 'offset', 0, Number.MAX_SAFE_INTEGER)
  if (raw['sort_by'] ?? raw['sortBy']) {
    query.sortBy = requireMember<MemorySortKey>(raw['sort_by'] ?? raw['sortBy'], MEMORY_SORT_KEYS, 'sort_by')
  }
  if (raw['sort_order'] ?? raw['sortOrder']) {
    query.sortOrder = requireMember<'asc' | 'desc'>(raw['sort_order'] ?? raw['sortOrder'], ['asc', 'desc'], 'sort_order')
  }
  return query
}

/**
 * Validate a search query.
 * @param raw - the caller's payload.
 * @returns the accepted query, with defaults applied.
 * @throws MemoryInputError for any rejected field.
 */
export function parseSearchQuery(raw: Record<string, unknown>): SearchQuery {
  const query: { -readonly [K in keyof SearchQuery]: SearchQuery[K] } = {
    query: requireText(raw['query'], 'query', TITLE_MAX_CHARS),
  }
  if (raw['category'] !== undefined) query.category = requireCategory(raw['category'])
  if (raw['tags'] !== undefined) query.tags = requireTags(raw['tags'])
  if (raw['limit'] !== undefined) query.limit = requireInteger(raw['limit'], 'limit', 1, SEARCH_LIMIT_MAX)
  if (raw['min_similarity'] ?? raw['minSimilarity']) {
    const value = raw['min_similarity'] ?? raw['minSimilarity']
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new MemoryInputError('min_similarity must be a number between 0 and 1')
    }
    query.minSimilarity = value
  }
  const budget = raw['token_budget'] ?? raw['tokenBudget']
  if (budget !== undefined) query.tokenBudget = requireInteger(budget, 'token_budget', 1, 1_000_000)
  return query
}
