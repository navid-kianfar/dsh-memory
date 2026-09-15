/**
 * The harness wiring: what the plugin does to a real Cordis context when a session starts.
 *
 * This is the one link the unit tests cannot reach and the browser cannot show. `rulesBlock()` being
 * correct proves nothing on its own — a rule only works if the section carrying it is registered in
 * the agent's own scope and re-read at every assembly. So this test runs the real `SystemPrompt`
 * service, fires the real `agent/session-start` event, and asks the assembly what the model would
 * receive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as MemoryTools from '../src/tools/index.ts'
import { MemoryService } from '../src/host/index.ts'
import type { ProjectMemory } from '../src/host/memory.ts'
import { EmbeddingEngine, type EmbeddingProviderInfo } from '../src/embedding/index.ts'

/** The subset of `Agent` the plugin's hooks actually touch. */
interface FakeAgent {
  id: string
  ctx: Context
  session: { header: { id: string, cwd: string, origin?: 'subagent', delegationDepth?: number, parentSession?: string } }
  inject: (message: unknown) => void
  injected: unknown[]
}

let root: string
let ctx: Context
let fiber: { dispose: () => Promise<void> }
let agent: FakeAgent
/** What the fake `agents` service reports as live, so a plugin (re)start can find running agents. */
let liveAgents: FakeAgent[]

/** The composition entry every test starts the plugin with. */
const CONFIG = {
  injectRules: true,
  injectSessionContext: true,
  autoSession: true,
  remind: 'never' as const,
  vectorWeight: 0.6,
  minSimilarity: 0.05,
  searchLimit: 10,
  candidateLimit: 1000,
  embedBatch: 64,
  toolset: 'core' as const,
}

/**
 * Build an agent whose context is a real child fiber, so a scoped registration behaves as it would
 * in the product.
 * @param parent - the host context.
 * @param cwd - the project directory the session works in.
 * @returns the fake agent and the messages injected into it.
 */
function fakeAgent(parent: Context, cwd: string, id = 'session-1', lineage: { parent?: FakeAgent } = {}): FakeAgent {
  const injected: unknown[] = []
  return {
    id,
    ctx: parent.extend({}),
    session: {
      header: {
        id, cwd,
        ...lineage.parent === undefined
          ? {}
          : { origin: 'subagent' as const, delegationDepth: 1, parentSession: lineage.parent.id },
      },
    },
    inject: (message: unknown) => { injected.push(message) },
    injected,
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-host-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'You are a test agent.' })
  // The plugin lists live agents when it starts, so a reload can re-bind the ones already running.
  liveAgents = []
  ctx.provide('agents', { get: () => undefined, list: () => [...liveAgents] } as never)
  fiber = await ctx.plugin(MemoryService, { ...CONFIG, databasePath: join(root, 'memory.db') })
  agent = fakeAgent(ctx, root)
})

afterEach(async () => {
  // Disposing the plugin fiber is what releases the DuckDB file lock; leaving it open would make the
  // next test in this file open a database another handle still owns.
  await fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Open the project the way a session start would, without waiting on the detached hook.
 * @returns the project's memory.
 */
async function project(): Promise<ProjectMemory> {
  return ctx.memory.project(root)
}

/**
 * Fire the session-start hook and wait for its detached work to settle.
 */
async function startSession(who: FakeAgent = agent): Promise<void> {
  ctx.emit('agent/session-start', { agent: who as never, source: 'startup' as never })
  // The hook is deliberately detached so a slow first open cannot delay the first model request;
  // opening the project here settles the same promise chain the hook is waiting on.
  await project()
  await new Promise(resolve => setTimeout(resolve, 50))
}

/**
 * Render what the model would receive on this agent's next request.
 * @returns the assembled system prompt.
 */
async function assembled(who: FakeAgent = agent): Promise<string> {
  return renderPrompt(await who.ctx.systemPrompt.assemble())
}

/**
 * Replace the service's live settings, as a committed settings change would, and notify it.
 * @param patch - the fields to change.
 */
function changeSettings(patch: Record<string, unknown>): void {
  const service = ctx.memory as unknown as { source: () => Record<string, unknown>, applySettings: () => void }
  const current = service.source()
  service.source = () => ({ ...current, ...patch })
  service.applySettings()
}

/**
 * Let detached hook work settle.
 * @param ms - how long to wait.
 */
async function settle(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('binding rules reaching the model', () => {
  it('puts the project\'s rules into the agent\'s system prompt', async () => {
    const memory = await project()
    await memory.create({
      category: 'mandatory_rules', title: 'Run doc-sync', content: 'Always run doc-sync before pushing.',
    }, 'user', Date.now())
    await memory.create({
      category: 'forbidden_rules', title: 'No credentials', content: 'Never commit credentials.',
    }, 'user', Date.now())

    await startSession()

    const prompt = await assembled()
    expect(prompt).toContain('You are a test agent.')
    expect(prompt).toContain('MANDATORY — always do this:')
    expect(prompt).toContain('Run doc-sync: Always run doc-sync before pushing.')
    expect(prompt).toContain('FORBIDDEN — never do this:')
    expect(prompt).toContain('No credentials: Never commit credentials.')
  })

  it('reflects a rule added MID-SESSION on the very next assembly', async () => {
    await startSession()
    expect(await assembled()).not.toContain('MANDATORY')

    const memory = await project()
    await memory.create({
      category: 'mandatory_rules', title: 'Ask first', content: 'Ask before deleting a file.',
    }, 'user', Date.now())

    // No re-registration and no new session: the section's text provider re-reads the cached block,
    // which is what makes an edit in the manager bind the very next request.
    expect(await assembled()).toContain('Ask first: Ask before deleting a file.')
  })

  it('drops an archived rule from the prompt', async () => {
    const memory = await project()
    const { memory: rule } = await memory.create({
      category: 'mandatory_rules', title: 'Temporary', content: 'This will be retired.',
    }, 'user', Date.now())
    await startSession()
    expect(await assembled()).toContain('Temporary')

    await memory.archive(rule.id, 'user', Date.now())
    expect(await assembled()).not.toContain('Temporary')
  })

  it('contributes nothing to a project with no rules', async () => {
    await startSession()
    const prompt = await assembled()
    expect(prompt).toBe('You are a test agent.')
  })

  it('stops injecting when the deployment turns enforcement off', async () => {
    const memory = await project()
    await memory.create({
      category: 'mandatory_rules', title: 'Run doc-sync', content: 'Always run doc-sync before pushing.',
    }, 'user', Date.now())
    await startSession()
    expect(await assembled()).toContain('Run doc-sync')

    // The section stays registered and reads the switch at assembly time, so turning enforcement off
    // takes effect on the next request rather than needing the agent to be rebuilt.
    const service = ctx.memory as unknown as { source: () => { injectRules: boolean } }
    const current = service.source()
    ;(service as unknown as { source: () => unknown }).source = () => ({ ...current, injectRules: false })
    expect(await assembled()).not.toContain('Run doc-sync')
  })
})

describe('the model-facing tools', () => {
  /**
   * Apply the tools plugin over the same context and list what it registered.
   * @param toolset - which set the deployment composes.
   * @returns the registered tool names, sorted.
   */
  async function registered(toolset: 'core' | 'full'): Promise<string[]> {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset })
    return ctx.tools.schemas().map(schema => schema.name).sort()
  }

  it('registers the core set a deployment gets by default', async () => {
    expect(await registered('core')).toEqual([
      'memory_add_rule', 'memory_recall', 'memory_rules', 'memory_search', 'memory_session_end',
      'memory_store',
    ])
  })

  it('adds the curation tools only when the deployment asks for them', async () => {
    expect(await registered('full')).toEqual([
      'memory_add_rule', 'memory_archive', 'memory_list', 'memory_provenance', 'memory_recall',
      'memory_rules', 'memory_search', 'memory_session_end', 'memory_store', 'memory_update',
    ])
  })

  it('stores and recalls through the tool surface the model actually calls', async () => {
    await registered('core')
    const exec = { signal: AbortSignal.timeout(5000), callId: 'c1', agent: agent as never }
    const stored = await ctx.tools.execute({ ...exec, name: 'memory_store', arguments: {
      category: 'decision', title: 'Storage engine', content: 'DuckDB, because the memory is queried by hand.',
    } } as never)
    expect(stored.isError).toBe(false)

    const found = await ctx.tools.execute({ ...exec, callId: 'c2', name: 'memory_search', arguments: {
      query: 'why duckdb',
    } } as never)
    expect(found.isError).toBe(false)
    expect(JSON.stringify(found.content)).toContain('Storage engine')
  })

  it('makes a rule stated through the tool bind the next request', async () => {
    await registered('core')
    await startSession()
    await ctx.tools.execute({
      signal: AbortSignal.timeout(5000), callId: 'c3', agent: agent as never,
      name: 'memory_add_rule',
      arguments: { rule_type: 'forbidden', title: 'No force pushes', content: 'Never force-push to master.' },
    } as never)
    expect(await assembled()).toContain('No force pushes: Never force-push to master.')
  })
})

describe('session context', () => {
  it('injects the last summary, sprint goals, and recent decisions once at session start', async () => {
    const memory = await project()
    const first = await memory.startSession(Date.now())
    await memory.create({
      category: 'sprint', title: 'Ship the plugin', content: 'Land dsh-memory this week.',
    }, 'user', Date.now())
    await memory.create({
      category: 'decision', title: 'Storage', content: 'DuckDB, because the memory is queried by hand.',
    }, 'user', Date.now())
    await memory.endSession(first.sessionId, 'We picked the storage engine.', Date.now())

    await startSession()

    expect(agent.injected).toHaveLength(1)
    const text = JSON.stringify(agent.injected[0])
    expect(text).toContain('Where the last session left off')
    expect(text).toContain('We picked the storage engine.')
    expect(text).toContain('Ship the plugin')
    expect(text).toContain('Storage')
    // Rules reach the model through the system prompt; repeating them here would double their cost
    // and let the two copies disagree after a mid-session edit.
    expect(text).not.toContain('MANDATORY')
  })

  it('injects nothing into a project with no history', async () => {
    await startSession()
    expect(agent.injected).toHaveLength(0)
  })
})

describe('rule text the prompt renderer would otherwise reject', () => {
  it('delivers a rule containing a workflow expression verbatim instead of breaking every turn', async () => {
    const memory = await project()
    await memory.create({
      category: 'mandatory_rules', title: 'Use secrets in CI',
      content: 'Reference tokens as ${{ secrets.GITHUB_TOKEN }} and never {{inline}} them.', source: 'user',
    }, 'user', Date.now())
    await startSession()
    const prompt = await assembled()
    expect(prompt).toContain('Reference tokens as ${{ secrets.GITHUB_TOKEN }} and never {{inline}} them.')
  })
})

describe('subagents', () => {
  it('bind a child to the rules without replacing the parent\'s memory session or re-sending history', async () => {
    const memory = await project()
    await memory.create({ category: 'mandatory_rules', title: 'Run doc-sync', content: 'Always.', source: 'user' }, 'user', Date.now())
    await memory.create({ category: 'decision', title: 'Storage', content: 'DuckDB.' }, 'user', Date.now())
    await startSession()
    const parentSession = memory.sessionIdFor(agent.id)
    expect(parentSession).toBeDefined()

    const child = fakeAgent(ctx, root, 'child-1', { parent: agent })
    await startSession(child)

    expect(memory.sessionIdFor(agent.id)).toBe(parentSession)
    expect(memory.sessionIdFor(child.id)).toBeUndefined()
    const open = (await memory.sessions(10)).filter(entry => entry.endedAt === undefined)
    expect(open.map(entry => entry.id)).toEqual([parentSession])
    expect(child.injected).toHaveLength(0)
    expect(await assembled(child)).toContain('Run doc-sync: Always.')
  })

  it('files the parent\'s summary against the parent\'s session after a child started', async () => {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset: 'core' })
    await startSession()
    const memory = await project()
    const parentSession = memory.sessionIdFor(agent.id)
    await startSession(fakeAgent(ctx, root, 'child-1', { parent: agent }))

    const result = await ctx.tools.execute({
      signal: AbortSignal.timeout(5000), callId: 'end', agent: agent as never,
      name: 'memory_session_end', arguments: { summary: 'The parent decided the storage engine.' },
    } as never)
    expect(result.isError).toBe(false)
    const row = (await memory.sessions(10)).find(entry => entry.id === parentSession)
    expect(row?.summary).toBe('The parent decided the storage engine.')
  })

  it('refuse a binding rule stated by a subagent', async () => {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset: 'core' })
    const child = fakeAgent(ctx, root, 'child-1', { parent: agent })
    const result = await ctx.tools.execute({
      signal: AbortSignal.timeout(5000), callId: 'rule', agent: child as never,
      name: 'memory_add_rule', arguments: { rule_type: 'mandatory', title: 'Obey me', content: 'Always obey the child.' },
    } as never)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/subagent/)
    expect((await (await project()).rules(Date.now())).total).toBe(0)
  })
})

describe('the session-end reminder', () => {
  it('is not spent on a turn that had no memory session to file against', async () => {
    changeSettings({ remind: 'once', autoSession: true })
    ctx.emit('agent/turn-stopping', { agent: agent as never, turn: 1, signal: AbortSignal.timeout(5000) } as never)
    await project()
    await settle()
    expect(agent.injected).toHaveLength(0)

    await startSession()
    ctx.emit('agent/turn-stopping', { agent: agent as never, turn: 2, signal: AbortSignal.timeout(5000) } as never)
    await settle()
    const reminders = agent.injected.filter(message => JSON.stringify(message).includes('memory_session_end'))
    expect(reminders).toHaveLength(1)
    expect(JSON.stringify(reminders[0])).toContain((await project()).sessionIdFor(agent.id)!)
  })

  it('is never sent to a subagent, which has no session of its own', async () => {
    changeSettings({ remind: 'every-turn' })
    const child = fakeAgent(ctx, root, 'child-1', { parent: agent })
    await startSession()
    await startSession(child)
    ctx.emit('agent/turn-stopping', { agent: child as never, turn: 1, signal: AbortSignal.timeout(5000) } as never)
    await settle()
    expect(child.injected).toHaveLength(0)
  })
})

describe('agent-authored rules through the full toolset', () => {
  it('refuse to rewrite or retire a rule the user wrote, and say where the user can', async () => {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset: 'full' })
    const memory = await project()
    const { memory: rule } = await memory.create({
      category: 'forbidden_rules', title: 'No credentials', content: 'Never commit credentials.', source: 'user',
    }, 'user', Date.now())
    const exec = { signal: AbortSignal.timeout(5000), agent: agent as never }
    const edit = await ctx.tools.execute({ ...exec, callId: 'u', name: 'memory_update', arguments: { memory_id: rule.id, content: 'Fine.' } } as never)
    const archive = await ctx.tools.execute({ ...exec, callId: 'a', name: 'memory_archive', arguments: { memory_id: rule.id } } as never)
    expect(edit.isError).toBe(true)
    expect(archive.isError).toBe(true)
    expect(JSON.stringify(archive.content)).toContain('Memory tab')
    expect((await memory.rules(Date.now())).forbidden[0]?.content).toBe('Never commit credentials.')
  })

  it('label a rule the agent added, in the prompt the model reads', async () => {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset: 'core' })
    await startSession()
    await ctx.tools.execute({
      signal: AbortSignal.timeout(5000), callId: 'r', agent: agent as never, name: 'memory_add_rule',
      arguments: { rule_type: 'mandatory', title: 'Lint first', content: 'Run lint before committing.' },
    } as never)
    expect(await assembled()).toContain('[added by an agent] Lint first: Run lint before committing.')
  })
})

describe('settings changes reaching open projects and live agents', () => {
  it('honours a retention of 0 as "never expires"', async () => {
    changeSettings({ retentionDays: { session: 0 } })
    const { memory: note } = await (await project()).create({ category: 'session', title: 'Keep', content: 'forever' }, 'user', Date.now())
    expect(note.expiresAt).toBeUndefined()
  })

  it('moves tools AND the live rule section to a changed database path together', async () => {
    await ctx.plugin(Tools, {})
    await ctx.plugin(MemoryTools, { toolset: 'core' })
    const before = await project()
    await before.create({ category: 'mandatory_rules', title: 'Old rule', content: 'From the old file.', source: 'user' }, 'user', Date.now())
    await startSession()
    expect(await assembled()).toContain('Old rule')

    changeSettings({ databasePath: join(root, 'moved.db') })
    await settle(150)
    const after = await project()
    expect(after.databasePath).toContain('moved.db')
    await after.create({ category: 'mandatory_rules', title: 'New rule', content: 'From the new file.', source: 'user' }, 'user', Date.now())

    const prompt = await assembled()
    expect(prompt).toContain('New rule')
    expect(prompt).not.toContain('Old rule')

    const stored = await ctx.tools.execute({
      signal: AbortSignal.timeout(5000), callId: 's', agent: agent as never, name: 'memory_store',
      arguments: { category: 'decision', title: 'Where am I', content: 'In the moved file.' },
    } as never)
    expect(stored.isError).toBe(false)
    expect((await after.list({ text: 'moved file' }, Date.now())).total).toBe(1)
  })
})

describe('a plugin reload', () => {
  it('re-binds agents that were already running to the rule set', async () => {
    const memory = await project()
    await memory.create({ category: 'mandatory_rules', title: 'Survive reloads', content: 'Always.', source: 'user' }, 'user', Date.now())
    await startSession()
    liveAgents.push(agent)
    await fiber.dispose()
    expect(await assembled()).not.toContain('Survive reloads')

    fiber = await ctx.plugin(MemoryService, { ...CONFIG, databasePath: join(root, 'memory.db') })
    await project()
    await settle(100)
    expect(await assembled()).toContain('Survive reloads: Always.')
    // The running agent gets a memory session to file its summary against, but not a second copy of
    // the history it already received.
    expect((await project()).sessionIdFor(agent.id)).toBeDefined()
    expect(agent.injected).toHaveLength(0)
  })
})

describe('the embedding provider', () => {
  /** A provider reporting a fixed identity and emitting 3-dimensional vectors. */
  class FakeEmbeddings extends EmbeddingEngine {
    static calls = 0
    async describe(): Promise<EmbeddingProviderInfo> {
      return { provider: 'fake', model: 'fake-model', dimensions: 3, ready: true }
    }

    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      FakeEmbeddings.calls += texts.length
      return texts.map(text => [text.length % 7, 1, 0.5])
    }
  }

  it('is attached to an open project when it mounts later, and detached when it goes away', async () => {
    const memory = await project()
    await memory.create({ category: 'decision', title: 'Alpha', content: 'beta' }, 'user', Date.now())
    expect(memory.semantic).toBe(false)

    const provider = await ctx.plugin(FakeEmbeddings)
    await settle()
    expect(memory.semantic).toBe(true)
    await memory.whenEmbedded()
    const result = await ctx.memory.reembed({ project: root })
    expect(result).toMatchObject({ ok: true, remaining: 0 })

    await provider.dispose()
    await settle()
    expect(memory.semantic).toBe(false)
  })
})

describe('RPC input validation', () => {
  it('rejects a listing page outside the accepted bounds as invalid input', async () => {
    expect(await ctx.memory.list({ project: root, limit: 100_000 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await ctx.memory.list({ project: root, offset: -1 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await ctx.memory.list({ project: root, tags: ['x'.repeat(500)] })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('rejects a search with an out-of-range limit or floor, and keeps a floor of 0', async () => {
    const signal = AbortSignal.timeout(5000)
    expect(await ctx.memory.search({ project: root, query: 'x', limit: 0 }, signal)).toMatchObject({ ok: false, code: 'invalid' })
    expect(await ctx.memory.search({ project: root, query: 'x', minSimilarity: 5 }, signal)).toMatchObject({ ok: false, code: 'invalid' })
    await (await project()).create({ category: 'decision', title: 'Zeta', content: 'eta' }, 'user', Date.now())
    const found = await ctx.memory.search({ project: root, query: 'zeta', minSimilarity: 0 }, signal)
    expect(found).toMatchObject({ ok: true })
  })

  it('applies the same caps to an imported file as to a memory typed into the manager', async () => {
    const huge = `# Rules\n- ${'x'.repeat(250_000)}\n- A normal rule\n`
    expect(await ctx.memory.importInstructions({ project: root, text: huge, source: 'CLAUDE.md' }))
      .toMatchObject({ ok: false, code: 'invalid' })
    expect(await ctx.memory.importInstructions({ project: root, text: '# Rules\n- A rule', source: 'x'.repeat(200) }))
      .toMatchObject({ ok: false, code: 'invalid' })
    expect((await (await project()).rules(Date.now())).total).toBe(0)
  })
})
