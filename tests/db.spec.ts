/**
 * The medium's one-instance-per-file guarantee, against real files on disk.
 *
 * DuckDB's file lock is per process, so it lets this process open a file it already holds. Two
 * instances over one file then checkpoint over each other and leave it unreadable ("Serialization
 * Error: Failed to deserialize: field id mismatch"). These tests reach one file under several
 * spellings, write through every handle interleaved, and prove the file still opens afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { Context } from '@deepseek-ai/cordis'
import { canonicalDatabasePath, openMemoryDatabase, type OpenMemoryDatabase } from '../src/host/db.ts'
import { MemoryService } from '../src/host/index.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-db-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Write through every handle in turn, checkpointing as it goes — the pattern that destroys a file
 * two independent instances share.
 * @param handles - the open databases to write through.
 * @param rows - how many rows to write in total.
 * @param from - the first row id, so a second pass over one file does not collide with the first.
 */
async function interleave(handles: readonly OpenMemoryDatabase[], rows: number, from = 0): Promise<void> {
  for (let i = from; i < from + rows; i++) {
    const { connection } = handles[i % handles.length]!
    const now = 1_800_000_000_000 + i
    await connection.run(
      `INSERT INTO memories (id, category, title, content, created_at, updated_at) `
      + `VALUES ('m${i}', 'decision', 't${i}', repeat('x', ${(i * 37) % 3000}), ${now}, ${now})`,
    )
    if (i % 3 === 0) {
      await connection.run(`UPDATE memories SET status = 'archived', access_count = access_count + 1 WHERE id = 'm${i}'`)
    }
    if (i % 200 === 199) await connection.run('CHECKPOINT')
  }
}

/**
 * Open the file with a fresh instance, as the next process would, and count its rows.
 * @param path - the database file.
 * @returns the row count.
 */
async function reopenCount(path: string): Promise<number> {
  const instance = await DuckDBInstance.create(path)
  const connection = await instance.connect()
  try {
    const result = await connection.runAndReadAll('SELECT count(*) AS n FROM memories')
    await connection.runAndReadAll('SELECT * FROM memories ORDER BY updated_at')
    return Number(result.getRowObjects()[0]?.['n'])
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

describe('canonicalDatabasePath', () => {
  it('gives one spelling to a path reached through a symlink, a dot-dot, and a trailing slash', () => {
    const real = join(root, 'project')
    mkdirSync(real)
    symlinkSync(real, join(root, 'alias'))
    const direct = canonicalDatabasePath(join(real, '.dsh', 'memory.db'))
    expect(canonicalDatabasePath(join(root, 'alias', '.dsh', 'memory.db'))).toBe(direct)
    expect(canonicalDatabasePath(`${real}/sub/../.dsh/memory.db`)).toBe(direct)
    expect(canonicalDatabasePath(join(`${real}/`, '.dsh/memory.db'))).toBe(direct)
  })

  it('leaves the in-memory sentinel alone', () => {
    expect(canonicalDatabasePath(':memory:')).toBe(':memory:')
  })
})

describe('openMemoryDatabase', () => {
  // 1,200 real writes against a file on disk: about a second alone, but several times that when the
  // full suite's workers share the disk, which the 5 s default does not leave room for. The volume is
  // the point — the corruption this guards against only surfaces after many interleaved writes.
  it('shares one instance across every spelling of a file, so interleaved writes leave it readable', async () => {
    const real = join(root, 'project')
    mkdirSync(real)
    symlinkSync(real, join(root, 'alias'))
    const handles = [
      await openMemoryDatabase(join(real, '.dsh', 'memory.db')),
      await openMemoryDatabase(join(root, 'alias', '.dsh', 'memory.db')),
      await openMemoryDatabase(`${real}/sub/../.dsh/memory.db`),
    ]
    await interleave(handles, 1200)
    for (const handle of handles) handle.close()

    expect(await reopenCount(join(real, '.dsh', 'memory.db'))).toBe(1200)
  }, 20_000)

  it('keeps the file open for the remaining holders when one of them closes', async () => {
    const path = join(root, 'memory.db')
    const first = await openMemoryDatabase(path)
    const second = await openMemoryDatabase(path)
    first.close()
    first.close()
    await interleave([second], 50)
    second.close()

    expect(await reopenCount(path)).toBe(50)
  })

  it('opens concurrently without handing out two instances', async () => {
    const path = join(root, 'memory.db')
    const handles = await Promise.all(Array.from({ length: 4 }, () => openMemoryDatabase(path)))
    await interleave(handles, 400)
    for (const handle of handles) handle.close()

    expect(await reopenCount(path)).toBe(400)
  })

  it('releases the file once the last holder closes', async () => {
    const path = join(root, 'memory.db')
    const handle = await openMemoryDatabase(path)
    await interleave([handle], 10)
    handle.close()

    // A fresh, independent instance may only touch the file safely once nothing here holds it.
    expect(await reopenCount(path)).toBe(10)
    const again = await openMemoryDatabase(path)
    await interleave([again], 5, 10)
    again.close()
    expect(await reopenCount(path)).toBe(15)
  })
})

describe('MemoryService.project', () => {
  const settings = {
    injectRules: false,
    injectSessionContext: false,
    autoSession: false,
    remind: 'never' as const,
    vectorWeight: 0.6,
    minSimilarity: 0.05,
    searchLimit: 10,
    candidateLimit: 1000,
    embedBatch: 64,
    toolset: 'core' as const,
  }

  it('returns one project for two spellings of the same directory', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
    const fiber = await ctx.plugin(MemoryService, { ...settings, databasePath: '.dsh/memory.db' })
    try {
      const real = join(root, 'project')
      mkdirSync(real)
      symlinkSync(real, join(root, 'alias'))
      const [a, b, c] = await Promise.all([
        ctx.memory.project(real),
        ctx.memory.project(`${real}/`),
        ctx.memory.project(join(root, 'alias')),
      ])
      expect(b).toBe(a)
      expect(c).toBe(a)
    } finally {
      await fiber.dispose()
    }
  })

  it('does not open a second instance when a reloaded plugin reaches a project the old one still holds', async () => {
    const real = join(root, 'project')
    mkdirSync(real)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
    const before = await ctx.plugin(MemoryService, { ...settings, databasePath: '.dsh/memory.db' })
    const old = await ctx.memory.project(real)
    await old.create({ category: 'decision', title: 'Before reload', content: 'kept' }, 'user', Date.now())

    // Start the replacement and write through it before the old fiber has finished closing.
    const disposing = before.dispose()
    const after = await ctx.plugin(MemoryService, { ...settings, databasePath: '.dsh/memory.db' })
    const fresh = await ctx.memory.project(real)
    for (let i = 0; i < 300; i++) {
      await fresh.create({ category: 'decision', title: `After reload ${i}`, content: 'x'.repeat(i * 7) }, 'user', Date.now())
    }
    await disposing
    await after.dispose()

    expect(await reopenCount(join(real, '.dsh', 'memory.db'))).toBe(301)
  })
})
