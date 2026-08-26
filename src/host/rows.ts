/**
 * Reading DuckDB rows back into domain values.
 *
 * The driver returns `BIGINT` as `bigint`, list columns as a `DuckDBListValue` wrapper, and `JSON`
 * as its text. Converting in one place keeps every query's result mapping identical and means a
 * column type change is a one-line edit rather than a hunt.
 *
 * @module @achasoft/dsh-memory/host/rows
 */

import type { DuckDBValue } from '@duckdb/node-api'
import type {
  Memory, MemoryCategory, MemorySession, MemoryStatus, ProvenanceEntry, ProvenanceOperation,
} from '../domain/types.ts'

/** One row as the driver hands it over. */
export type Row = Readonly<Record<string, DuckDBValue>>

/**
 * Read a text column.
 * @param value - the cell.
 * @returns the string, or `''` when the cell is null.
 */
export function text(value: DuckDBValue): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Read a numeric column, including `BIGINT` cells the driver returns as `bigint`.
 * @param value - the cell.
 * @returns the number, or `0` when the cell is null.
 */
export function num(value: DuckDBValue): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

/**
 * Read a nullable numeric column.
 * @param value - the cell.
 * @returns the number, or undefined when the cell is null.
 */
export function optionalNum(value: DuckDBValue): number | undefined {
  if (value === null || value === undefined) return undefined
  return num(value)
}

/**
 * Read a `VARCHAR[]` or `FLOAT[]` column.
 * @param value - the cell.
 * @returns the items, or `[]` when the cell is null.
 */
export function list(value: DuckDBValue): unknown[] {
  if (value !== null && typeof value === 'object' && 'items' in value) {
    return [...(value as { items: readonly unknown[] }).items]
  }
  return []
}

/**
 * Read a `VARCHAR[]` column as strings.
 * @param value - the cell.
 * @returns the string items; non-string items are dropped rather than coerced.
 */
export function strings(value: DuckDBValue): string[] {
  return list(value).filter((item): item is string => typeof item === 'string')
}

/**
 * Read a `FLOAT[]` column as numbers.
 * @param value - the cell.
 * @returns the numeric items, or `[]` when the cell is null.
 */
export function floats(value: DuckDBValue): number[] {
  return list(value).filter((item): item is number => typeof item === 'number')
}

/**
 * Read a `JSON` column.
 *
 * Malformed stored JSON reads as absent rather than throwing: this is the one column a person
 * editing the file by hand can corrupt, and losing a sidecar must not make the memory unreadable.
 * @param value - the cell.
 * @returns the parsed object, or undefined when the cell is null, not an object, or unparseable.
 */
export function json(value: DuckDBValue): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    // Only a hand-edited or externally written cell can reach here; the plugin's own writes are
    // JSON.stringify output. Dropping the sidecar keeps the memory itself readable.
    return undefined
  }
}

/**
 * Map a `memories` row onto the domain value.
 * @param row - the row, selected with the full column list.
 * @returns the memory.
 */
export function toMemory(row: Row): Memory {
  const metadata = json(row['metadata'] ?? null)
  const expires = optionalNum(row['expires_at'] ?? null)
  return {
    id: text(row['id'] ?? null),
    category: text(row['category'] ?? null) as MemoryCategory,
    title: text(row['title'] ?? null),
    content: text(row['content'] ?? null),
    summary: text(row['summary'] ?? null),
    tags: strings(row['tags'] ?? null),
    status: text(row['status'] ?? null) as MemoryStatus,
    priority: num(row['priority'] ?? null),
    source: text(row['source'] ?? null),
    relatedIds: strings(row['related_ids'] ?? null),
    entities: strings(row['entities'] ?? null),
    accessCount: num(row['access_count'] ?? null),
    createdAt: num(row['created_at'] ?? null),
    updatedAt: num(row['updated_at'] ?? null),
    embedded: optionalNum(row['embedding_dim'] ?? null) !== undefined,
    ...metadata === undefined ? {} : { metadata },
    ...expires === undefined ? {} : { expiresAt: expires },
  }
}

/**
 * Map a `sessions` row onto the domain value.
 * @param row - the row.
 * @returns the session record.
 */
export function toSession(row: Row): MemorySession {
  const endedAt = optionalNum(row['ended_at'] ?? null)
  const summary = row['summary']
  return {
    id: text(row['id'] ?? null),
    startedAt: num(row['started_at'] ?? null),
    memoriesCreated: num(row['memories_created'] ?? null),
    memoriesAccessed: num(row['memories_accessed'] ?? null),
    ...endedAt === undefined ? {} : { endedAt },
    ...typeof summary === 'string' ? { summary } : {},
  }
}

/**
 * Map a `provenance` row onto the domain value.
 * @param row - the row.
 * @returns the audit entry.
 */
export function toProvenance(row: Row): ProvenanceEntry {
  const details = json(row['details'] ?? null)
  return {
    seq: num(row['seq'] ?? null),
    memoryId: text(row['memory_id'] ?? null),
    operation: text(row['operation'] ?? null) as ProvenanceOperation,
    actor: text(row['actor'] ?? null),
    at: num(row['recorded_at'] ?? null),
    ...details === undefined ? {} : { details },
  }
}
