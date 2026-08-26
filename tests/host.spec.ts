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

/** The subset of `Agent` the plugin's hooks actually touch. */
interface FakeAgent {
  id: string
  ctx: Context
  session: { header: { cwd: string } }
  inject: (message: unknown) => void
  injected: unknown[]
}

let root: string
let ctx: Context
let fiber: { dispose: () => Promise<void> }
let agent: FakeAgent

/**
 * Build an agent whose context is a real child fiber, so a scoped registration behaves as it would
 * in the product.
 * @param parent - the host context.
 * @param cwd - the project directory the session works in.
 * @returns the fake agent and the messages injected into it.
 */
function fakeAgent(parent: Context, cwd: string): FakeAgent {
  const injected: unknown[] = []
  return {
    id: 'session-1',
    ctx: parent.extend({}),
    session: { header: { cwd } },
    inject: (message: unknown) => { injected.push(message) },
    injected,
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-host-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, persona: 'You are a test agent.' })
  // The plugin injects `agents` for its own lookups; the hooks under test never call into it.
  ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
  fiber = await ctx.plugin(MemoryService, {
    databasePath: join(root, 'memory.db'),
    injectRules: true,
    injectSessionContext: true,
    autoSession: true,
    remind: 'never',
    vectorWeight: 0.6,
    minSimilarity: 0.05,
    searchLimit: 10,
    candidateLimit: 1000,
    embedBatch: 64,
    toolset: 'core',
  })
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
async function startSession(): Promise<void> {
  ctx.emit('agent/session-start', { agent: agent as never, source: 'fresh' as never })
  // The hook is deliberately detached so a slow first open cannot delay the first model request;
  // opening the project here settles the same promise chain the hook is waiting on.
  await project()
  await new Promise(resolve => setTimeout(resolve, 50))
}

/**
 * Render what the model would receive on this agent's next request.
 * @returns the assembled system prompt.
 */
async function assembled(): Promise<string> {
  return renderPrompt(await agent.ctx.systemPrompt.assemble())
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
