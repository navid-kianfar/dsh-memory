/**
 * The engine over a real DuckDB database: what a write derives, what a search ranks, how rules are
 * enforced, and what a session carries forward.
 *
 * These run against `:memory:` rather than a fake store. The whole point of the storage layer is the
 * SQL it emits, so a double would test the parts that cannot break.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/host/store.ts'
import { ORPHAN_SUMMARY, ProjectMemory, type ProjectMemoryOptions } from '../src/host/memory.ts'
import { DEFAULT_RELEVANCE_WEIGHTS } from '../src/domain/score.ts'

const OPTIONS: ProjectMemoryOptions = {
  projectRoot: '/tmp/Example Project',
  databasePath: ':memory:',
  candidateLimit: 500,
  minSimilarity: 0,
  vectorWeight: 0.6,
  relevanceWeights: DEFAULT_RELEVANCE_WEIGHTS,
  retentionDays: {},
  embedBatch: 32,
}

const NOW = 1_800_000_000_000

let memory: ProjectMemory

beforeEach(async () => {
  memory = new ProjectMemory(await MemoryStore.open(':memory:'), OPTIONS)
})

afterEach(async () => {
  await memory.close()
})

describe('writing', () => {
  it('derives the summary, entities, and identity the author did not supply', async () => {
    const { memory: stored } = await memory.create({
      category: 'decision',
      title: 'Storage engine',
      content: 'We picked DuckDB over SQLite because the board is queried by hand. It also has vectors.',
    }, 'agent', NOW)

    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(stored.summary).toBe('We picked DuckDB over SQLite because the board is queried by hand.')
    expect(stored.entities).toContain('DuckDB')
    expect(stored.entities).toContain('SQLite')
    expect(stored.status).toBe('active')
    expect(stored.source).toBe('assistant')
  })

  it('raises a rule to the rule priority floor whatever the author asked for', async () => {
    const { memory: rule, rulesChanged } = await memory.create({
      category: 'mandatory_rules', title: 'Run doc-sync', content: 'Always run doc-sync before pushing.',
      priority: 0,
    }, 'agent', NOW)
    expect(rule.priority).toBe(2)
    expect(rulesChanged).toBe(true)
  })

  it('never expires a rule, and dates an ordinary memory by its category', async () => {
    const { memory: rule } = await memory.create({
      category: 'forbidden_rules', title: 'No credentials', content: 'Never commit credentials.',
    }, 'agent', NOW)
    const { memory: note } = await memory.create({
      category: 'session', title: 'Standup', content: 'Discussed the release.',
    }, 'agent', NOW)

    expect(rule.expiresAt).toBeUndefined()
    expect(note.expiresAt).toBe(NOW + 30 * 86_400_000)
  })

  it('re-derives the summary and drops the stale vector when the content changes', async () => {
    const { memory: stored } = await memory.create({
      category: 'decision', title: 'Original', content: 'The first thing we said.',
    }, 'agent', NOW)
    const { memory: updated } = await memory.update(
      { id: stored.id, content: 'A completely different second thing about PostgreSQL.' }, 'user', NOW + 1000,
    )
    expect(updated.summary).toBe('A completely different second thing about PostgreSQL.')
    expect(updated.entities).toContain('PostgreSQL')
    expect(updated.embedded).toBe(false)
    expect(updated.updatedAt).toBe(NOW + 1000)
  })

  it('carries the rule priority floor when a note is reclassified as a rule', async () => {
    const { memory: note } = await memory.create({
      category: 'reference', title: 'Style', content: 'Two spaces, no tabs.', priority: 0,
    }, 'agent', NOW)
    const { memory: rule, rulesChanged } = await memory.update(
      { id: note.id, category: 'mandatory_rules' }, 'user', NOW + 1,
    )
    expect(rule.priority).toBe(2)
    expect(rulesChanged).toBe(true)
  })
})

describe('rules', () => {
  beforeEach(async () => {
    await memory.create({
      category: 'mandatory_rules', title: 'Run doc-sync', content: 'Always run doc-sync before pushing.',
    }, 'agent', NOW)
    await memory.create({
      category: 'forbidden_rules', title: 'No credentials', content: 'Never commit credentials.',
    }, 'agent', NOW)
  })

  it('renders both halves into the injected block', async () => {
    await memory.refreshRules(NOW)
    const block = memory.rulesBlock()
    expect(block).toContain('Binding rules for project "example-project"')
    expect(block).toContain('MANDATORY — always do this:')
    expect(block).toContain('  - Run doc-sync: Always run doc-sync before pushing.')
    expect(block).toContain('FORBIDDEN — never do this:')
    expect(block).toContain('  - No credentials: Never commit credentials.')
  })

  it('returns every rule rather than a ranked subset', async () => {
    for (let index = 0; index < 30; index += 1) {
      await memory.create({
        category: 'mandatory_rules', title: `Rule ${index}`, content: `Do thing ${index}.`,
      }, 'agent', NOW)
    }
    const rules = await memory.rules(NOW)
    expect(rules.mandatory).toHaveLength(31)
    expect(rules.total).toBe(32)
  })

  it('drops an archived rule out of the block', async () => {
    const rules = await memory.rules(NOW)
    const [first] = rules.mandatory
    await memory.archive(first!.id, 'user', NOW + 1)
    expect(memory.rulesBlock()).not.toContain('Run doc-sync')
    expect((await memory.rules(NOW + 1)).mandatory).toHaveLength(0)
  })

  it('contributes nothing when the project has no rules', async () => {
    const empty = new ProjectMemory(await MemoryStore.open(':memory:'), OPTIONS)
    await empty.refreshRules(NOW)
    expect(empty.rulesBlock()).toBe('')
    await empty.close()
  })
})

describe('search', () => {
  beforeEach(async () => {
    await memory.create({
      category: 'decision', title: 'Database choice',
      content: 'We chose DuckDB for the memory store because it supports vectors natively.',
    }, 'agent', NOW)
    await memory.create({
      category: 'architecture', title: 'Session persistence',
      content: 'Sessions are written as JSONL under the project directory.',
    }, 'agent', NOW)
    await memory.create({
      category: 'devops', title: 'Deployment', content: 'Docker images publish on every tagged release.',
      tags: ['ci'],
    }, 'agent', NOW)
  })

  const search = (query: string, extra = {}) =>
    memory.search({ query, ...extra }, NOW, AbortSignal.timeout(5000))

  it('finds a memory by a term in its content', async () => {
    const result = await search('duckdb vectors')
    expect(result.hits[0]?.memory.title).toBe('Database choice')
    expect(result.hits[0]?.matched).toEqual(['lexical'])
    expect(result.semantic).toBe(false)
  })

  it('ranks a title match above a body mention', async () => {
    await memory.create({
      category: 'reference', title: 'Notes', content: 'Deployment is mentioned here in passing only.',
    }, 'agent', NOW)
    const result = await search('deployment')
    expect(result.hits[0]?.memory.title).toBe('Deployment')
  })

  it('returns nothing rather than everything for a query that matches nothing', async () => {
    const result = await search('kubernetes helm charts')
    expect(result.hits).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('filters by category and by tag', async () => {
    expect((await search('release', { category: 'decision' })).hits).toHaveLength(0)
    expect((await search('release', { category: 'devops' })).hits).toHaveLength(1)
    expect((await search('release', { tags: ['ci'] })).hits).toHaveLength(1)
    expect((await search('release', { tags: ['nope'] })).hits).toHaveLength(0)
  })

  it('reports what a token budget left out instead of silently cutting', async () => {
    const result = await search('duckdb jsonl docker', { tokenBudget: 1 })
    expect(result.index.length).toBeGreaterThan(result.hits.length)
    expect(result.hasMore).toBe(true)
  })

  it('counts a returned hit as an access', async () => {
    await search('duckdb')
    const [hit] = (await search('duckdb')).hits
    expect(hit?.memory.accessCount).toBe(1)
  })
})

describe('sessions', () => {
  it('carries the last real summary, sprint goals, and recent decisions forward', async () => {
    const first = await memory.startSession(NOW)
    await memory.create({
      category: 'sprint', title: 'Ship the plugin', content: 'Land the memory plugin this week.',
    }, 'agent', NOW)
    await memory.create({
      category: 'decision', title: 'Storage', content: 'DuckDB it is.',
    }, 'agent', NOW)
    await memory.endSession(first.sessionId, 'We picked the storage engine.', NOW + 1000)

    const second = await memory.startSession(NOW + 2000)
    expect(second.lastSummary).toBe('We picked the storage engine.')
    expect(second.sprint.map(entry => entry.title)).toEqual(['Ship the plugin'])
    expect(second.recentDecisions.map(entry => entry.title)).toEqual(['Storage'])
    expect(second.orphansClosed).toBe(0)
  })

  it('closes an abandoned session and does not let its marker answer as the last word', async () => {
    const first = await memory.startSession(NOW)
    await memory.endSession(first.sessionId, 'A real summary.', NOW + 100)
    await memory.startSession(NOW + 200)

    const third = await memory.startSession(NOW + 300)
    expect(third.orphansClosed).toBe(1)
    expect(third.lastSummary).toBe('A real summary.')

    const sessions = await memory.sessions(10)
    expect(sessions.some(entry => entry.summary === ORPHAN_SUMMARY)).toBe(true)
  })
})

describe('lifecycle', () => {
  it('archives, restores, and permanently removes', async () => {
    const { memory: stored } = await memory.create({
      category: 'reference', title: 'Temp', content: 'Something to remove.',
    }, 'agent', NOW)

    await memory.archive(stored.id, 'user', NOW + 1, 'superseded')
    expect((await memory.list({ status: 'active' }, NOW + 1)).total).toBe(0)
    expect((await memory.list({ status: 'archived' }, NOW + 1)).total).toBe(1)

    await memory.restore(stored.id, 'user', NOW + 2)
    expect((await memory.list({ status: 'active' }, NOW + 2)).total).toBe(1)

    const trail = await memory.provenance(stored.id, 10)
    expect(trail.map(entry => entry.operation)).toEqual(['restore', 'archive', 'create'])
    expect(trail.find(entry => entry.operation === 'archive')?.details?.['reason']).toBe('superseded')

    expect((await memory.remove(stored.id, NOW + 3)).removed).toBe(true)
    expect(await memory.provenance(stored.id, 10)).toHaveLength(0)
  })

  it('hides a memory once its retention date passes', async () => {
    const { memory: stored } = await memory.create({
      category: 'session', title: 'Old standup', content: 'Long ago.',
    }, 'agent', NOW)
    const after = stored.expiresAt! + 1
    expect((await memory.list({ status: 'active' }, after)).total).toBe(0)
    expect((await memory.stats(after)).expired).toBe(1)
  })
})

describe('embeddings', () => {
  /** A provider whose vectors put the word "storage" near the word "database". */
  const fakeEmbedder = {
    model: 'test-model',
    embed: async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
      texts.map((text) => {
        const lower = text.toLowerCase()
        const storage = /duckdb|database|storage|store/.test(lower) ? 1 : 0
        const deploy = /docker|deploy|release/.test(lower) ? 1 : 0
        return [storage, deploy, 0.1]
      }),
  }

  it('backfills vectors and then ranks a query no keyword would match', async () => {
    await memory.create({
      category: 'decision', title: 'Persistence', content: 'We chose DuckDB.',
    }, 'agent', NOW)
    await memory.create({
      category: 'devops', title: 'Pipeline', content: 'Docker images publish on release.',
    }, 'agent', NOW)

    memory.setEmbedder(fakeEmbedder)
    expect(await memory.drainEmbeddings()).toBe(2)

    const result = await memory.search({ query: 'where does state live' }, NOW, AbortSignal.timeout(5000))
    expect(result.semantic).toBe(true)
    expect(result.hits[0]?.memory.title).toBe('Persistence')
    expect(result.hits[0]?.matched).toContain('vector')
  })

  it('leaves a memory whose text changed without its stale vector', async () => {
    const { memory: stored } = await memory.create({
      category: 'decision', title: 'Persistence', content: 'We chose DuckDB.',
    }, 'agent', NOW)
    memory.setEmbedder(fakeEmbedder)
    await memory.drainEmbeddings()

    await memory.update({ id: stored.id, content: 'Actually Docker matters more.' }, 'user', NOW + 1)
    // The update itself schedules the re-embed, so waiting on that pass is the real path; calling
    // drainEmbeddings() here would race the scheduled one and find the work already taken.
    await memory.whenEmbedded()
    const [reread] = (await memory.list({}, NOW + 1)).memories
    expect(reread?.embedded).toBe(true)

    const result = await memory.search({ query: 'shipping containers' }, NOW + 1, AbortSignal.timeout(5000))
    expect(result.hits[0]?.memory.id).toBe(stored.id)
  })

  it('falls back to lexical ranking when the provider fails', async () => {
    await memory.create({
      category: 'decision', title: 'Persistence', content: 'We chose DuckDB.',
    }, 'agent', NOW)
    memory.setEmbedder({
      model: 'broken',
      embed: () => Promise.reject(new Error('endpoint down')),
    })
    const result = await memory.search({ query: 'duckdb' }, NOW, AbortSignal.timeout(5000))
    expect(result.semantic).toBe(false)
    expect(result.hits[0]?.memory.title).toBe('Persistence')
  })
})
