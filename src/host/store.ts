/**
 * Every SQL statement the plugin runs, and the queue that keeps them in order.
 *
 * One DuckDB connection serves the whole plugin, and a prepared statement holds its bound parameters
 * as mutable state until it runs. Two overlapping callers would therefore interleave their binds on
 * the same statement object and silently write each other's values, so every method here goes
 * through {@link MemoryStore.serialize}: statements queue rather than race. DuckDB itself is fast
 * enough that the queue is never the bottleneck at the scale a project's memory reaches.
 *
 * @module @achasoft/dsh-memory/host/store
 */

import type { DuckDBConnection, DuckDBPreparedStatement } from '@duckdb/node-api'
import {
  FLOAT_LIST, VARCHAR_LIST, openMemoryDatabase, type OpenMemoryDatabase,
} from './db.ts'
import { toMemory, toProvenance, toSession, type Row } from './rows.ts'
import { LEXICAL_FIELDS, type CorpusStats, type LexicalDocument } from '../domain/score.ts'
import type {
  ListMemoriesQuery, Memory, MemoryCategory, MemoryPage, MemorySession, MemoryStats, MemoryStatus,
  ProvenanceEntry, ProvenanceOperation, RuleSet,
} from '../domain/types.ts'
import { RULE_CATEGORIES } from '../domain/types.ts'

/** Every column of `memories`, in the order reads select them. */
const COLUMNS = 'id, category, title, content, summary, tags, entities, related_ids, metadata, '
  + 'status, priority, source, access_count, expires_at, created_at, updated_at, embedding_model, embedding_dim'

/** The predicate for "a memory that currently counts": active and not past its retention date. */
const LIVE = "status = 'active' AND (expires_at IS NULL OR expires_at > ?)"

/** The `category IN (...)` fragment naming the two rule categories. */
const RULE_IN = RULE_CATEGORIES.map(category => `'${category}'`).join(', ')

/**
 * The searchable text of a memory as one expression, for candidate selection and length statistics.
 * Tag and entity lists are flattened so a substring probe reaches them the same way it reaches prose.
 */
const HAYSTACK = "lower(title || ' ' || summary || ' ' || content || ' ' "
  + "|| array_to_string(tags, ' ') || ' ' || array_to_string(entities, ' '))"

/** A memory as it is written: the domain value plus the derived columns the store owns. */
export interface StoredMemory {
  readonly id: string
  readonly category: MemoryCategory
  readonly title: string
  readonly content: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly entities: readonly string[]
  readonly relatedIds: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly status: MemoryStatus
  readonly priority: number
  readonly source: string
  readonly expiresAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Filters shared by the two candidate queries. */
export interface CandidateFilters {
  readonly category?: MemoryCategory
  readonly tags?: readonly string[]
  /** The current time, so expiry is evaluated against the caller's clock rather than the database's. */
  readonly now: number
  /** Most rows either query returns. */
  readonly limit: number
}

/** Candidates for one search, with everything the ranker needs to score them. */
export interface CandidateSet {
  /** The full memories, keyed by id, from both the lexical and the vector probe. */
  readonly memories: ReadonlyMap<string, Memory>
  /** The same memories' searchable text, split by field. */
  readonly documents: readonly LexicalDocument[]
  /** Cosine similarity per id for memories the vector probe reached; empty when it did not run. */
  readonly cosine: ReadonlyMap<string, number>
  /** Corpus size and average field lengths, over every live memory rather than the candidates. */
  readonly stats: CorpusStats
  /** True when a probe hit {@link CandidateFilters.limit} and the tail was not considered. */
  readonly truncated: boolean
}

/** The project's memory, and every operation over it. */
export class MemoryStore {
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false

  /**
   * @param database - the open connection and its release function.
   */
  private constructor(private readonly database: OpenMemoryDatabase) {}

  /**
   * Open a project's memory.
   * @param path - absolute database path, or `:memory:` for a throwaway store.
   * @returns the open store.
   * @throws MemoryStoreError when the file is locked or carries an unreadable layout version.
   */
  static async open(path: string): Promise<MemoryStore> {
    return new MemoryStore(await openMemoryDatabase(path))
  }

  /** Release the database lock. Idempotent; queued work settles first. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Take the tail so a caller mid-statement is not closed out from under; the queue only ever
    // settles, because `serialize` swallows rejections into the tail.
    await this.#tail.catch(() => {})
    this.database.close()
  }

  /**
   * Run one unit of database work with exclusive use of the connection.
   *
   * The tail keeps its own failures out of the chain: a rejected caller gets its rejection, and the
   * next caller still starts from a settled tail rather than inheriting the failure.
   * @param work - the statements to run.
   * @returns the work's result.
   */
  private serialize<T>(work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
    const result = this.#tail.then(
      () => work(this.database.connection),
      () => work(this.database.connection),
    )
    this.#tail = result.catch(() => {})
    return result
  }

  /**
   * Bind a memory's columns onto a prepared insert or replace.
   * @param statement - the prepared statement, whose first 18 parameters are the column list.
   * @param memory - the values to bind.
   */
  private static bindMemory(statement: DuckDBPreparedStatement, memory: StoredMemory): void {
    statement.bindVarchar(1, memory.id)
    statement.bindVarchar(2, memory.category)
    statement.bindVarchar(3, memory.title)
    statement.bindVarchar(4, memory.content)
    statement.bindVarchar(5, memory.summary)
    statement.bindList(6, [...memory.tags], VARCHAR_LIST)
    statement.bindList(7, [...memory.entities], VARCHAR_LIST)
    statement.bindList(8, [...memory.relatedIds], VARCHAR_LIST)
    if (memory.metadata === undefined) statement.bindNull(9)
    else statement.bindVarchar(9, JSON.stringify(memory.metadata))
    statement.bindVarchar(10, memory.status)
    statement.bindInteger(11, memory.priority)
    statement.bindVarchar(12, memory.source)
    if (memory.expiresAt === undefined) statement.bindNull(13)
    else statement.bindBigInt(13, BigInt(memory.expiresAt))
    statement.bindBigInt(14, BigInt(memory.createdAt))
    statement.bindBigInt(15, BigInt(memory.updatedAt))
  }

  /**
   * Write a new memory.
   * @param memory - the complete row to insert.
   * @returns the stored memory as it reads back.
   */
  async insert(memory: StoredMemory): Promise<Memory> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'INSERT INTO memories (id, category, title, content, summary, tags, entities, related_ids, '
        + 'metadata, status, priority, source, expires_at, created_at, updated_at) '
        + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      )
      MemoryStore.bindMemory(statement, memory)
      await statement.run()
      return MemoryStore.one(await this.read(connection, memory.id)) as Memory
    })
  }

  /**
   * Read one memory by identity.
   * @param id - the memory id.
   * @returns the memory, or undefined when the project does not hold it.
   */
  async get(id: string): Promise<Memory | undefined> {
    return this.serialize(async connection => MemoryStore.one(await this.read(connection, id)))
  }

  /**
   * Read one row by id on an already-held connection.
   * @param connection - the connection this call owns.
   * @param id - the memory id.
   * @returns the matching rows (zero or one).
   */
  private async read(connection: DuckDBConnection, id: string): Promise<Row[]> {
    const statement = await connection.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = $1`)
    statement.bindVarchar(1, id)
    return (await statement.runAndReadAll()).getRowObjects()
  }

  /**
   * Map the first row of a result, if there is one.
   * @param rows - the result rows.
   * @returns the mapped memory, or undefined for an empty result.
   */
  private static one(rows: readonly Row[]): Memory | undefined {
    const [row] = rows
    return row === undefined ? undefined : toMemory(row)
  }

  /**
   * Find an active memory by its exact title.
   *
   * Titles are not unique — nothing stops two decisions sharing one — so the most recently updated
   * match wins. That is the one a person naming a title from memory almost always means.
   * @param title - the exact title.
   * @returns the memory, or undefined when no active memory carries that title.
   */
  async getByTitle(title: string): Promise<Memory | undefined> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE title = $1 AND status = 'active' `
        + 'ORDER BY updated_at DESC LIMIT 1',
      )
      statement.bindVarchar(1, title)
      return MemoryStore.one((await statement.runAndReadAll()).getRowObjects())
    })
  }

  /**
   * Read a filtered, sorted page of memories.
   * @param query - the accepted filters and paging.
   * @param now - the current time, for evaluating expiry.
   * @returns the page and the unpaged total.
   */
  async list(query: ListMemoriesQuery, now: number): Promise<MemoryPage> {
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    const sortColumn = {
      updatedAt: 'updated_at', createdAt: 'created_at', title: 'title',
      priority: 'priority', accessCount: 'access_count', category: 'category',
    }[query.sortBy ?? 'updatedAt']
    const order = query.sortOrder === 'asc' ? 'ASC' : 'DESC'

    const where: string[] = []
    const bind: ((statement: DuckDBPreparedStatement, index: number) => void)[] = []
    const status = query.status ?? 'active'
    if (status === 'active') {
      where.push(LIVE.replace('?', `$${bind.length + 1}`))
      bind.push((statement, index) => { statement.bindBigInt(index, BigInt(now)) })
    } else if (status !== 'all') {
      where.push(`status = $${bind.length + 1}`)
      bind.push((statement, index) => { statement.bindVarchar(index, status) })
    }
    if (query.category !== undefined) {
      const category = query.category
      where.push(`category = $${bind.length + 1}`)
      bind.push((statement, index) => { statement.bindVarchar(index, category) })
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      const tags = [...query.tags]
      where.push(`list_has_any(tags, $${bind.length + 1})`)
      bind.push((statement, index) => { statement.bindList(index, tags, VARCHAR_LIST) })
    }
    if (query.text !== undefined && query.text.length > 0) {
      const needle = query.text.toLowerCase()
      where.push(`contains(${HAYSTACK}, $${bind.length + 1})`)
      bind.push((statement, index) => { statement.bindVarchar(index, needle) })
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`

    return this.serialize(async (connection) => {
      const countStatement = await connection.prepare(`SELECT count(*) AS n FROM memories${clause}`)
      bind.forEach((apply, index) => { apply(countStatement, index + 1) })
      const [countRow] = (await countStatement.runAndReadAll()).getRowObjects()
      const total = Number(countRow?.['n'] ?? 0)

      const pageStatement = await connection.prepare(
        `SELECT ${COLUMNS} FROM memories${clause} ORDER BY ${sortColumn} ${order}, id `
        + `LIMIT $${bind.length + 1} OFFSET $${bind.length + 2}`,
      )
      bind.forEach((apply, index) => { apply(pageStatement, index + 1) })
      pageStatement.bindInteger(bind.length + 1, limit)
      pageStatement.bindInteger(bind.length + 2, offset)
      const memories = (await pageStatement.runAndReadAll()).getRowObjects().map(toMemory)
      return { memories, total, limit, offset }
    })
  }

  /**
   * Apply a patch to one memory.
   *
   * The caller supplies already-derived columns — a changed title or content arrives with its new
   * summary and entities — because deriving them needs the domain layer and this module holds only
   * SQL.
   * @param id - the memory to change.
   * @param patch - column values keyed by column name; an absent column is left untouched.
   * @param now - the new `updated_at`.
   * @returns the updated memory, or undefined when the id is unknown.
   */
  async update(id: string, patch: Readonly<Record<string, unknown>>, now: number): Promise<Memory | undefined> {
    const entries = Object.entries(patch)
    if (entries.length === 0) return this.get(id)
    return this.serialize(async (connection) => {
      const assignments = entries.map(([column], index) => `${column} = $${index + 1}`)
      const statement = await connection.prepare(
        `UPDATE memories SET ${assignments.join(', ')}, updated_at = $${entries.length + 1} `
        + `WHERE id = $${entries.length + 2}`,
      )
      entries.forEach(([column, value], index) => {
        MemoryStore.bindColumn(statement, index + 1, column, value)
      })
      statement.bindBigInt(entries.length + 1, BigInt(now))
      statement.bindVarchar(entries.length + 2, id)
      await statement.run()
      return MemoryStore.one(await this.read(connection, id))
    })
  }

  /**
   * Bind one patch value according to the column it targets.
   * @param statement - the prepared update.
   * @param index - the parameter position.
   * @param column - the column being set, which decides the binding type.
   * @param value - the value to bind.
   */
  private static bindColumn(
    statement: DuckDBPreparedStatement, index: number, column: string, value: unknown,
  ): void {
    if (value === undefined || value === null) { statement.bindNull(index); return }
    switch (column) {
      case 'tags': case 'entities': case 'related_ids':
        statement.bindList(index, value as string[], VARCHAR_LIST); return
      case 'embedding':
        statement.bindList(index, value as number[], FLOAT_LIST); return
      case 'metadata':
        statement.bindVarchar(index, JSON.stringify(value)); return
      case 'priority': case 'access_count': case 'embedding_dim':
        statement.bindInteger(index, value as number); return
      case 'expires_at': case 'created_at':
        statement.bindBigInt(index, BigInt(value as number)); return
      default:
        statement.bindVarchar(index, String(value))
    }
  }

  /**
   * Remove a memory and its audit trail permanently.
   * @param id - the memory to remove.
   * @returns true when a row was removed.
   */
  async hardDelete(id: string): Promise<boolean> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare('DELETE FROM memories WHERE id = $1 RETURNING id')
      statement.bindVarchar(1, id)
      const removed = (await statement.runAndReadAll()).getRowObjects().length > 0
      if (removed) {
        const trail = await connection.prepare('DELETE FROM provenance WHERE memory_id = $1')
        trail.bindVarchar(1, id)
        await trail.run()
      }
      return removed
    })
  }

  /**
   * Read the project's complete rule set.
   *
   * Deliberately unlimited and unranked. Rules are enforced rather than recalled, so returning a
   * top-N subset would mean an arbitrary rule silently stopped applying.
   * @param now - the current time, for evaluating expiry.
   * @returns both halves, each ordered by priority then age.
   */
  async rules(now: number): Promise<RuleSet> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE category IN (${RULE_IN}) AND ${LIVE.replace('?', '$1')} `
        + 'ORDER BY priority DESC, created_at ASC',
      )
      statement.bindBigInt(1, BigInt(now))
      const memories = (await statement.runAndReadAll()).getRowObjects().map(toMemory)
      const mandatory = memories.filter(memory => memory.category === 'mandatory_rules')
      const forbidden = memories.filter(memory => memory.category === 'forbidden_rules')
      return { mandatory, forbidden, total: mandatory.length + forbidden.length }
    })
  }

  /**
   * Read the most recent live memories of one category.
   * @param category - the category to read.
   * @param limit - most rows to return.
   * @param now - the current time, for evaluating expiry.
   * @param since - when given, only memories created at or after this time.
   * @returns the memories, newest first.
   */
  async byCategory(
    category: MemoryCategory, limit: number, now: number, since?: number,
  ): Promise<Memory[]> {
    return this.serialize(async (connection) => {
      const sinceClause = since === undefined ? '' : ' AND created_at >= $4'
      const statement = await connection.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE category = $1 AND ${LIVE.replace('?', '$2')}`
        + `${sinceClause} ORDER BY priority DESC, created_at DESC LIMIT $3`,
      )
      statement.bindVarchar(1, category)
      statement.bindBigInt(2, BigInt(now))
      statement.bindInteger(3, limit)
      if (since !== undefined) statement.bindBigInt(4, BigInt(since))
      return (await statement.runAndReadAll()).getRowObjects().map(toMemory)
    })
  }

  /**
   * Gather everything one search needs to rank.
   *
   * Two probes run and their results merge by id: a substring probe over the searchable text, which
   * is a superset of what BM25 can score, and — when a query vector is supplied — a cosine probe
   * over the memories carrying a vector of the same dimension. The dimension filter is not an
   * optimization: `list_cosine_similarity` raises on mismatched lengths, so a stored vector from a
   * previous embedding model must never reach it.
   * @param terms - the query's distinct terms; an empty list skips the lexical probe.
   * @param vector - the query's embedding, or undefined to skip the vector probe.
   * @param filters - category, tag, clock, and row cap.
   * @returns the merged candidates, their cosine scores, and corpus statistics.
   */
  async candidates(
    terms: readonly string[], vector: readonly number[] | undefined, filters: CandidateFilters,
  ): Promise<CandidateSet> {
    return this.serialize(async (connection) => {
      const extra: string[] = []
      if (filters.category !== undefined) extra.push(`category = '${filters.category.replace(/'/g, "''")}'`)
      const scope = `${LIVE.replace('?', '$1')}${extra.length === 0 ? '' : ` AND ${extra.join(' AND ')}`}`

      const memories = new Map<string, Memory>()
      const cosine = new Map<string, number>()
      let truncated = false

      if (terms.length > 0) {
        const probes = terms.map((_, index) => `contains(${HAYSTACK}, $${index + 2})`).join(' OR ')
        const statement = await connection.prepare(
          `SELECT ${COLUMNS} FROM memories WHERE ${scope} AND (${probes}) `
          + `ORDER BY updated_at DESC LIMIT $${terms.length + 2}`,
        )
        statement.bindBigInt(1, BigInt(filters.now))
        terms.forEach((term, index) => { statement.bindVarchar(index + 2, term) })
        statement.bindInteger(terms.length + 2, filters.limit)
        const rows = (await statement.runAndReadAll()).getRowObjects()
        truncated ||= rows.length >= filters.limit
        for (const row of rows) {
          const memory = toMemory(row)
          memories.set(memory.id, memory)
        }
      }

      if (vector !== undefined && vector.length > 0) {
        const statement = await connection.prepare(
          `SELECT ${COLUMNS}, list_cosine_similarity(embedding, $2) AS score FROM memories `
          + `WHERE ${scope} AND embedding_dim = $3 ORDER BY score DESC LIMIT $4`,
        )
        statement.bindBigInt(1, BigInt(filters.now))
        statement.bindList(2, [...vector], FLOAT_LIST)
        statement.bindInteger(3, vector.length)
        statement.bindInteger(4, filters.limit)
        const rows = (await statement.runAndReadAll()).getRowObjects()
        truncated ||= rows.length >= filters.limit
        for (const row of rows) {
          const memory = toMemory(row)
          memories.set(memory.id, memory)
          const score = row['score']
          if (typeof score === 'number' && Number.isFinite(score)) cosine.set(memory.id, score)
        }
      }

      const statsStatement = await connection.prepare(
        'SELECT count(*) AS n, avg(length(title)) AS title, avg(length(summary)) AS summary, '
        + 'avg(length(content)) AS content, avg(length(array_to_string(tags, \' \'))) AS tags, '
        + `avg(length(array_to_string(entities, ' '))) AS entities FROM memories WHERE ${scope}`,
      )
      statsStatement.bindBigInt(1, BigInt(filters.now))
      const [statsRow] = (await statsStatement.runAndReadAll()).getRowObjects()

      const averageLength = { title: 0, entities: 0, tags: 0, summary: 0, content: 0 }
      for (const field of LEXICAL_FIELDS) {
        const value = statsRow?.[field]
        averageLength[field] = typeof value === 'number' && Number.isFinite(value) ? value : 0
      }
      const documents = [...memories.values()].map((memory): LexicalDocument => ({
        id: memory.id,
        fields: {
          title: memory.title,
          entities: memory.entities.join(' '),
          tags: memory.tags.join(' '),
          summary: memory.summary,
          content: memory.content,
        },
      }))
      return {
        memories,
        documents,
        cosine,
        stats: { documentCount: Number(statsRow?.['n'] ?? 0), averageLength },
        truncated,
      }
    })
  }

  /**
   * Record that memories were read, so the relevance blend can favour ones that keep proving useful.
   * @param ids - the memories that were returned to a caller.
   */
  async incrementAccess(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'UPDATE memories SET access_count = access_count + 1 WHERE list_contains($1, id)',
      )
      statement.bindList(1, [...ids], VARCHAR_LIST)
      await statement.run()
    })
  }

  /**
   * Store or replace a memory's embedding.
   * @param id - the memory to embed.
   * @param vector - the embedding; an empty vector clears the stored one.
   * @param model - the model that produced it, so a model change is detectable.
   */
  async setEmbedding(id: string, vector: readonly number[], model: string): Promise<void> {
    await this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'UPDATE memories SET embedding = $1, embedding_model = $2, embedding_dim = $3 WHERE id = $4',
      )
      if (vector.length === 0) {
        statement.bindNull(1)
        statement.bindNull(2)
        statement.bindNull(3)
      } else {
        statement.bindList(1, [...vector], FLOAT_LIST)
        statement.bindVarchar(2, model)
        statement.bindInteger(3, vector.length)
      }
      statement.bindVarchar(4, id)
      await statement.run()
    })
  }

  /**
   * Find live memories that carry no vector for the current model.
   *
   * A memory embedded by a previous model counts as missing: its vector cannot be compared with a
   * new query vector, so leaving it would make it permanently invisible to semantic search.
   * @param model - the model currently configured.
   * @param limit - most rows to return.
   * @param now - the current time, for evaluating expiry.
   * @returns the memories needing an embedding, oldest first so a backlog drains in order.
   */
  async withoutEmbedding(model: string, limit: number, now: number): Promise<Memory[]> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE ${LIVE.replace('?', '$1')} `
        + 'AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2) '
        + 'ORDER BY created_at ASC LIMIT $3',
      )
      statement.bindBigInt(1, BigInt(now))
      statement.bindVarchar(2, model)
      statement.bindInteger(3, limit)
      return (await statement.runAndReadAll()).getRowObjects().map(toMemory)
    })
  }

  /**
   * Move memories past their retention date out of the live set.
   * @param now - the current time.
   * @returns how many memories expired.
   */
  async expireStale(now: number): Promise<number> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        "UPDATE memories SET status = 'expired' WHERE status = 'active' "
        + 'AND expires_at IS NOT NULL AND expires_at <= $1 RETURNING id',
      )
      statement.bindBigInt(1, BigInt(now))
      return (await statement.runAndReadAll()).getRowObjects().length
    })
  }

  /**
   * Count what the project holds, for the manager's header and the `describe` endpoint.
   * @param now - the current time, for evaluating expiry.
   * @returns totals by status and active counts by category.
   */
  async stats(now: number): Promise<MemoryStats> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'SELECT count(*) AS total, '
        + `count(*) FILTER (WHERE ${LIVE.replace('?', '$1')}) AS active, `
        + "count(*) FILTER (WHERE status = 'archived') AS archived, "
        + `count(*) FILTER (WHERE status = 'expired' OR (status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1)) AS expired, `
        + `count(*) FILTER (WHERE ${LIVE.replace('?', '$1')} AND embedding_dim IS NOT NULL) AS embedded `
        + 'FROM memories',
      )
      statement.bindBigInt(1, BigInt(now))
      const [row] = (await statement.runAndReadAll()).getRowObjects()

      const byCategoryStatement = await connection.prepare(
        `SELECT category, count(*) AS n FROM memories WHERE ${LIVE.replace('?', '$1')} GROUP BY category`,
      )
      byCategoryStatement.bindBigInt(1, BigInt(now))
      const byCategory: Partial<Record<MemoryCategory, number>> = {}
      for (const entry of (await byCategoryStatement.runAndReadAll()).getRowObjects()) {
        const category = entry['category']
        if (typeof category === 'string') byCategory[category as MemoryCategory] = Number(entry['n'] ?? 0)
      }
      return {
        total: Number(row?.['total'] ?? 0),
        active: Number(row?.['active'] ?? 0),
        archived: Number(row?.['archived'] ?? 0),
        expired: Number(row?.['expired'] ?? 0),
        embedded: Number(row?.['embedded'] ?? 0),
        byCategory,
      }
    })
  }

  /**
   * Append one audit entry.
   * @param entry - what happened to which memory, and when.
   */
  async recordProvenance(entry: Omit<ProvenanceEntry, 'seq'>): Promise<void> {
    await this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'INSERT INTO provenance (memory_id, operation, details, actor, recorded_at) VALUES ($1,$2,$3,$4,$5)',
      )
      statement.bindVarchar(1, entry.memoryId)
      statement.bindVarchar(2, entry.operation)
      if (entry.details === undefined) statement.bindNull(3)
      else statement.bindVarchar(3, JSON.stringify(entry.details))
      statement.bindVarchar(4, entry.actor)
      statement.bindBigInt(5, BigInt(entry.at))
      await statement.run()
    })
  }

  /**
   * Read one memory's audit trail.
   * @param memoryId - the memory to trace.
   * @param limit - most entries to return.
   * @returns the entries, newest first.
   */
  async provenance(memoryId: string, limit: number): Promise<ProvenanceEntry[]> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'SELECT seq, memory_id, operation, details, actor, recorded_at FROM provenance '
        + 'WHERE memory_id = $1 ORDER BY seq DESC LIMIT $2',
      )
      statement.bindVarchar(1, memoryId)
      statement.bindInteger(2, limit)
      return (await statement.runAndReadAll()).getRowObjects().map(toProvenance)
    })
  }

  /**
   * Open a session record.
   * @param id - the session identity.
   * @param now - the start time.
   */
  async startSession(id: string, now: number): Promise<void> {
    await this.serialize(async (connection) => {
      const statement = await connection.prepare('INSERT INTO sessions (id, started_at) VALUES ($1,$2)')
      statement.bindVarchar(1, id)
      statement.bindBigInt(2, BigInt(now))
      await statement.run()
    })
  }

  /**
   * Close a session record with its summary.
   * @param id - the session to close.
   * @param summary - what the next session needs to know.
   * @param created - memories written during the session.
   * @param accessed - memories read during the session.
   * @param now - the end time.
   * @returns true when an open session was closed.
   */
  async endSession(
    id: string, summary: string, created: number, accessed: number, now: number,
  ): Promise<boolean> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'UPDATE sessions SET ended_at = $1, summary = $2, memories_created = $3, '
        + 'memories_accessed = $4 WHERE id = $5 RETURNING id',
      )
      statement.bindBigInt(1, BigInt(now))
      statement.bindVarchar(2, summary)
      statement.bindInteger(3, created)
      statement.bindInteger(4, accessed)
      statement.bindVarchar(5, id)
      return (await statement.runAndReadAll()).getRowObjects().length > 0
    })
  }

  /**
   * Close sessions that were never ended, so a crashed or context-overflowed session does not stay
   * open forever and shadow the last real summary.
   * @param summary - the marker text recorded on each, recognisable when reading the summary back.
   * @param now - the close time.
   * @returns how many were closed.
   */
  async closeOrphans(summary: string, now: number): Promise<number> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'UPDATE sessions SET ended_at = $1, summary = $2 WHERE ended_at IS NULL RETURNING id',
      )
      statement.bindBigInt(1, BigInt(now))
      statement.bindVarchar(2, summary)
      return (await statement.runAndReadAll()).getRowObjects().length
    })
  }

  /**
   * Read the newest real session summary.
   * @param exclude - the auto-close marker, so an abandoned session does not answer as the last word.
   * @returns the summary, or undefined when no session has ended with one.
   */
  async lastSummary(exclude: string): Promise<string | undefined> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'SELECT summary FROM sessions WHERE summary IS NOT NULL AND summary <> $1 '
        + 'ORDER BY ended_at DESC LIMIT 1',
      )
      statement.bindVarchar(1, exclude)
      const [row] = (await statement.runAndReadAll()).getRowObjects()
      const summary = row?.['summary']
      return typeof summary === 'string' ? summary : undefined
    })
  }

  /**
   * Read recent sessions for the manager's Sessions tab.
   * @param limit - most sessions to return.
   * @returns the sessions, newest first.
   */
  async sessions(limit: number): Promise<MemorySession[]> {
    return this.serialize(async (connection) => {
      const statement = await connection.prepare(
        'SELECT id, started_at, ended_at, summary, memories_created, memories_accessed '
        + 'FROM sessions ORDER BY started_at DESC LIMIT $1',
      )
      statement.bindInteger(1, limit)
      return (await statement.runAndReadAll()).getRowObjects().map(toSession)
    })
  }

  /**
   * Read every memory, for export.
   * @returns all memories regardless of status, oldest first.
   */
  async all(): Promise<Memory[]> {
    return this.serialize(async (connection) => {
      const result = await connection.runAndReadAll(`SELECT ${COLUMNS} FROM memories ORDER BY created_at ASC`)
      return result.getRowObjects().map(toMemory)
    })
  }
}

/** Operations the audit trail records, re-exported so callers need one import. */
export type { ProvenanceOperation }
