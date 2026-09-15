/**
 * The project's memory medium: where the database lives, how it is opened, and the physical layout
 * it carries.
 *
 * DuckDB rather than a JSON file or SQLite because memory is something you interrogate. `duckdb
 * .dsh/memory.db "select * from memory where category = 'decision'"` is a supported way to use this
 * plugin, not a debugging trick, and the vector column that makes semantic recall possible is a
 * first-class type here rather than a blob a query cannot reach into.
 *
 * DuckDB takes an exclusive lock on the file it opens read-write, so one process owns the memory of
 * one project at a time. That is stated in {@link MemoryStoreError} rather than worked around: a
 * second writer would need a daemon, and a daemon is exactly the thing this plugin replaces.
 *
 * That lock does NOT protect a file from its own process. It is a POSIX advisory lock, which is held
 * per process, so a second `DuckDBInstance.create` on a file this process already has open succeeds
 * — and two instances each running their own buffer pool and checkpoints over one file destroy it
 * ("Serialization Error: Failed to deserialize: field id mismatch"). The same project reached under
 * two spellings of its path, or a plugin reload that opens before the old fiber has closed, is all
 * it takes. So every open goes through one process-wide, reference-counted instance per canonical
 * file path, and only the last release closes it.
 *
 * @module @achasoft/dsh-memory/host/db
 */

import { DuckDBInstance, DuckDBFloatType, DuckDBListType, DuckDBVarCharType } from '@duckdb/node-api'
import type { DuckDBConnection } from '@duckdb/node-api'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * The on-disk layout version.
 *
 * Monotonic, with no migrations: a database stamped with any other version is refused rather than
 * altered in place. Silently reshaping a file the user may also be querying by hand — or have
 * committed to a repository for a teammate — is worse than saying the build and the file disagree.
 */
export const MEMORY_SCHEMA_VERSION = 1

/** Path of the memory database relative to the project root. */
export const DEFAULT_DATABASE_PATH = '.dsh/memory.db'

/** The `VARCHAR[]` element type, for binding tag, entity, and relation lists (including empty ones). */
export const VARCHAR_LIST = new DuckDBListType(DuckDBVarCharType.instance)

/** The `FLOAT[]` element type, for binding embedding vectors. */
export const FLOAT_LIST = new DuckDBListType(DuckDBFloatType.instance)

/** Raised when the medium itself is unusable, as opposed to a caller sending a bad value. */
export class MemoryStoreError extends Error {
  /**
   * @param message - what is wrong with the database or its path, and what to do about it.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStoreError'
  }
}

/**
 * Resolve the memory database's absolute path.
 * @param projectRoot - absolute path of the project the memory belongs to.
 * @param configured - the configured path; a relative path resolves against the project root.
 * @returns the absolute database path.
 */
export function resolveDatabasePath(projectRoot: string, configured: string): string {
  return isAbsolute(configured) ? resolve(configured) : resolve(projectRoot, configured)
}

/**
 * The one spelling of a database path that every route to the same file agrees on.
 *
 * Symlinks, `..` segments, a trailing slash on the project root, and — on a case-insensitive volume
 * such as a default macOS disk — letter case all name one file under several strings. The directory
 * is created first so it can be resolved on disk; the file itself is resolved too once it exists.
 * @param path - absolute database path, or `:memory:`.
 * @returns the canonical path, or `:memory:` unchanged.
 */
export function canonicalDatabasePath(path: string): string {
  if (path === ':memory:') return path
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  if (existsSync(absolute)) return realpathSync.native(absolute)
  return join(realpathSync.native(dirname(absolute)), basename(absolute))
}

/** One DuckDB instance shared by every open of the same file in this process. */
interface SharedInstance {
  readonly instance: Promise<DuckDBInstance>
  refs: number
  /**
   * The layout check and creation, run once per instance. Concurrent first opens would otherwise
   * each issue the schema DDL, and DuckDB refuses the second with a catalog write-write conflict.
   */
  layout?: Promise<void>
}

/** A reference to a file's instance, as {@link openMemoryDatabase} consumes it. */
interface AcquiredInstance {
  readonly instance: DuckDBInstance
  /** Give the reference back; the last one closes the instance. Idempotent. */
  readonly release: () => void
  /**
   * Run the layout step unless another holder of this instance already has.
   * @param work - the check-and-create step.
   * @returns once the layout is in place.
   */
  readonly ensureLayout: (work: () => Promise<void>) => Promise<void>
}

/**
 * Memoize a layout step on its holder, forgetting a failure so the next open retries it.
 * @param holder - the object carrying the memo.
 * @param work - the step.
 * @returns the step's completion.
 */
function layoutOnce(holder: { layout?: Promise<void> }, work: () => Promise<void>): Promise<void> {
  if (holder.layout === undefined) {
    const running = work()
    holder.layout = running
    running.catch(() => { if (holder.layout === running) delete holder.layout })
  }
  return holder.layout
}

/**
 * Process-wide so that every copy of this module agrees — the build emits several entry chunks, and
 * a deployment can load the plugin from a linked checkout and a global install at once.
 */
const INSTANCES_KEY = Symbol.for('@achasoft/dsh-memory/duckdb-instances')

/**
 * The shared instance table.
 * @returns the table, created on first use.
 */
function instances(): Map<string, SharedInstance> {
  const holder = globalThis as { [INSTANCES_KEY]?: Map<string, SharedInstance> }
  holder[INSTANCES_KEY] ??= new Map()
  return holder[INSTANCES_KEY]
}

/**
 * Take a reference to the file's instance, creating it when this process holds none.
 * @param path - canonical database path; `:memory:` always gets a private instance.
 * @returns the instance and the function that gives the reference back.
 */
async function acquireInstance(path: string): Promise<AcquiredInstance> {
  if (path === ':memory:') {
    const instance = await DuckDBInstance.create(path)
    const holder: { layout?: Promise<void> } = {}
    return {
      instance,
      release: () => { instance.closeSync() },
      ensureLayout: work => layoutOnce(holder, work),
    }
  }
  const table = instances()
  let entry = table.get(path)
  if (entry === undefined) {
    const created: SharedInstance = { instance: DuckDBInstance.create(path), refs: 0 }
    table.set(path, created)
    // A failed create must not be handed to the next caller: the usual cause is another process
    // holding the lock, and that may have cleared by the next attempt.
    created.instance.catch(() => { if (table.get(path) === created) table.delete(path) })
    entry = created
  }
  entry.refs++
  const shared = entry
  let instance: DuckDBInstance
  try {
    instance = await shared.instance
  } catch (error) {
    shared.refs--
    throw error
  }
  let released = false
  return {
    instance,
    ensureLayout: work => layoutOnce(shared, work),
    release: () => {
      if (released) return
      released = true
      shared.refs--
      if (shared.refs > 0) return
      if (table.get(path) === shared) table.delete(path)
      // Synchronous, so no second open can slip in between the table losing the entry and the file
      // being checkpointed and unlocked.
      instance.closeSync()
    },
  }
}

/**
 * The memory's physical layout: tables, indexes, and the hand-query view.
 *
 * Timestamps are `BIGINT` epoch milliseconds rather than `TIMESTAMP` because that is what both
 * halves of the plugin speak; the `memory` view converts them so a hand query does not have to.
 * Embeddings are `FLOAT[]` — a list, not a fixed-width array — so that changing embedding model does
 * not require rewriting the column, and `embedding_dim` is stored beside the vector because
 * `list_cosine_similarity` raises on mismatched lengths and so must never be handed two.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id              VARCHAR PRIMARY KEY,
    category        VARCHAR   NOT NULL,
    title           VARCHAR   NOT NULL,
    content         VARCHAR   NOT NULL,
    summary         VARCHAR   NOT NULL DEFAULT '',
    tags            VARCHAR[] NOT NULL DEFAULT [],
    entities        VARCHAR[] NOT NULL DEFAULT [],
    related_ids     VARCHAR[] NOT NULL DEFAULT [],
    metadata        JSON,
    status          VARCHAR   NOT NULL DEFAULT 'active',
    priority        INTEGER   NOT NULL DEFAULT 0,
    source          VARCHAR   NOT NULL DEFAULT 'assistant',
    access_count    INTEGER   NOT NULL DEFAULT 0,
    expires_at      BIGINT,
    created_at      BIGINT    NOT NULL,
    updated_at      BIGINT    NOT NULL,
    embedding       FLOAT[],
    embedding_model VARCHAR,
    embedding_dim   INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                VARCHAR PRIMARY KEY,
    started_at        BIGINT  NOT NULL,
    ended_at          BIGINT,
    summary           VARCHAR,
    memories_created  INTEGER NOT NULL DEFAULT 0,
    memories_accessed INTEGER NOT NULL DEFAULT 0
  );

  CREATE SEQUENCE IF NOT EXISTS seq_provenance START 1;

  CREATE TABLE IF NOT EXISTS provenance (
    seq       BIGINT PRIMARY KEY DEFAULT nextval('seq_provenance'),
    memory_id VARCHAR NOT NULL,
    operation VARCHAR NOT NULL,
    details   JSON,
    actor     VARCHAR NOT NULL,
    recorded_at BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
  CREATE INDEX IF NOT EXISTS idx_memories_status   ON memories (status);
  CREATE INDEX IF NOT EXISTS idx_memories_updated  ON memories (updated_at);
  CREATE INDEX IF NOT EXISTS idx_memories_expires  ON memories (expires_at);
  CREATE INDEX IF NOT EXISTS idx_provenance_memory ON provenance (memory_id, seq);

  -- A readable projection for people querying this file by hand. Rules sort first, then priority,
  -- then recency, which is the order they matter in rather than the order they were written.
  CREATE OR REPLACE VIEW memory AS
    SELECT
      category,
      title,
      content,
      priority,
      status,
      tags,
      source,
      access_count                                                  AS reads,
      strftime(make_timestamp(created_at * 1000), '%Y-%m-%d %H:%M') AS created,
      strftime(make_timestamp(updated_at * 1000), '%Y-%m-%d %H:%M') AS updated,
      CASE WHEN expires_at IS NULL THEN NULL
           ELSE strftime(make_timestamp(expires_at * 1000), '%Y-%m-%d') END AS expires,
      id
    FROM memories
    ORDER BY
      CASE WHEN category IN ('mandatory_rules', 'forbidden_rules') THEN 0 ELSE 1 END,
      priority DESC,
      updated_at DESC;

  -- The rule set exactly as the model receives it, for confirming by hand what an agent is bound by.
  CREATE OR REPLACE VIEW rules AS
    SELECT
      CASE WHEN category = 'mandatory_rules' THEN 'MUST' ELSE 'MUST NOT' END AS kind,
      title,
      content,
      priority,
      id
    FROM memories
    WHERE category IN ('mandatory_rules', 'forbidden_rules') AND status = 'active'
    ORDER BY kind, priority DESC, created_at;
`

/** An open memory database and the connection that owns its lock. */
export interface OpenMemoryDatabase {
  /** The connection every statement runs on. */
  readonly connection: DuckDBConnection
  /** Release the file lock. Idempotent. */
  readonly close: () => void
}

/** Meta key holding the layout version stamp. */
const VERSION_KEY = 'schema_version'

/**
 * Open the memory database, creating its directory and layout as needed.
 *
 * The version stamp is written last on a fresh database: the stamp asserts the layout is complete,
 * so a failure part-way through leaves an unstamped file that the next open rebuilds rather than a
 * stamped file missing half its tables.
 * @param path - absolute database path, or `:memory:` for a throwaway store (tests).
 * @returns the open connection and its release function.
 * @throws MemoryStoreError when the file is locked by another process or carries a layout version
 *   this build cannot read.
 */
export async function openMemoryDatabase(path: string): Promise<OpenMemoryDatabase> {
  let acquired: AcquiredInstance
  try {
    acquired = await acquireInstance(canonicalDatabasePath(path))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/lock|being used by another/i.test(message)) {
      throw new MemoryStoreError(
        `the memory database at "${path}" is locked by another process. DuckDB allows one writer at `
        + 'a time, so close the other dsh instance or the `duckdb` shell holding it, then retry.',
      )
    }
    throw new MemoryStoreError(`could not open the memory database at "${path}": ${message}`)
  }

  let connection: DuckDBConnection
  try {
    connection = await acquired.instance.connect()
  } catch (error) {
    acquired.release()
    throw error
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    try {
      connection.closeSync()
    } finally {
      acquired.release()
    }
  }
  try {
    await acquired.ensureLayout(async () => {
      const stamped = await readVersion(connection)
      if (stamped !== undefined && stamped !== MEMORY_SCHEMA_VERSION) {
        throw new MemoryStoreError(
          `the memory at "${path}" was written with layout version ${stamped}, which this build `
          + `(${MEMORY_SCHEMA_VERSION}) cannot read. Move it aside to start fresh, or run a build that matches it.`,
        )
      }
      await connection.run(SCHEMA)
      if (stamped === undefined) {
        await connection.run(
          `INSERT INTO meta (key, value) VALUES ('${VERSION_KEY}', '${MEMORY_SCHEMA_VERSION}')`,
        )
      }
    })
    return { connection, close }
  } catch (error) {
    close()
    throw error
  }
}

/**
 * Read the layout stamp of an already-open database.
 * @param connection - the open connection.
 * @returns the stamped version, or undefined for a database that has no layout yet.
 */
async function readVersion(connection: DuckDBConnection): Promise<number | undefined> {
  const existing = await connection.runAndReadAll(
    "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'meta'",
  )
  const [tableRow] = existing.getRowObjects()
  if (Number(tableRow?.['n'] ?? 0) === 0) return undefined
  const result = await connection.runAndReadAll(
    `SELECT value FROM meta WHERE key = '${VERSION_KEY}'`,
  )
  const [row] = result.getRowObjects()
  const value = row?.['value']
  return typeof value === 'string' ? Number.parseInt(value, 10) : undefined
}
