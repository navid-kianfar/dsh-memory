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
 * @module @achasoft/dsh-memory/host/db
 */

import { DuckDBInstance, DuckDBFloatType, DuckDBListType, DuckDBVarCharType } from '@duckdb/node-api'
import type { DuckDBConnection } from '@duckdb/node-api'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

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
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  let instance: DuckDBInstance
  try {
    instance = await DuckDBInstance.create(path)
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

  const connection = await instance.connect()
  const close = (): void => {
    connection.closeSync()
    instance.closeSync()
  }
  try {
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
