/**
 * Projecting domain values onto the wire.
 *
 * The two vocabularies differ deliberately — see `./types.ts` for why — so the mapping lives here
 * rather than inline at each endpoint, where eleven copies would drift.
 *
 * @module @achasoft/dsh-memory/host/views
 */

import type {
  Memory, MemoryCategory, MemorySession, ProvenanceEntry,
} from '../domain/types.ts'
import type {
  MemoryCategoryCount, MemoryCategoryWire, MemoryProvenanceView, MemorySessionView, MemoryView,
} from './types.ts'

/**
 * Project one memory.
 * @param memory - the domain value.
 * @returns the wire value, with the JSON sidecar serialized to text.
 */
export function toMemoryView(memory: Memory): MemoryView {
  return {
    id: memory.id,
    category: memory.category,
    title: memory.title,
    content: memory.content,
    summary: memory.summary,
    tags: memory.tags,
    entities: memory.entities,
    relatedIds: memory.relatedIds,
    status: memory.status,
    priority: memory.priority,
    source: memory.source,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    embedded: memory.embedded,
    ...memory.metadata === undefined ? {} : { metadataJson: JSON.stringify(memory.metadata) },
    ...memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt },
  }
}

/**
 * Project one session record.
 * @param session - the domain value.
 * @returns the wire value.
 */
export function toSessionView(session: MemorySession): MemorySessionView {
  return {
    id: session.id,
    startedAt: session.startedAt,
    memoriesCreated: session.memoriesCreated,
    memoriesAccessed: session.memoriesAccessed,
    ...session.endedAt === undefined ? {} : { endedAt: session.endedAt },
    ...session.summary === undefined ? {} : { summary: session.summary },
  }
}

/**
 * Project one audit entry.
 * @param entry - the domain value.
 * @returns the wire value, with operation details serialized to text.
 */
export function toProvenanceView(entry: ProvenanceEntry): MemoryProvenanceView {
  return {
    seq: entry.seq,
    memoryId: entry.memoryId,
    operation: entry.operation,
    actor: entry.actor,
    at: entry.at,
    ...entry.details === undefined ? {} : { detailsJson: JSON.stringify(entry.details) },
  }
}

/**
 * Project per-category counts as pairs.
 *
 * A record keyed by category has no honest runtime schema across the gateway, and a pair list sorts
 * deterministically — which is what keeps the manager's category filter from reordering on refresh.
 * @param counts - active counts by category.
 * @returns the pairs, highest count first and then alphabetically.
 */
export function toCategoryCounts(
  counts: Readonly<Partial<Record<MemoryCategory, number>>>,
): readonly MemoryCategoryCount[] {
  return Object.entries(counts)
    .filter((entry): entry is [MemoryCategoryWire, number] => typeof entry[1] === 'number')
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
}
