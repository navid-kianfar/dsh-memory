/**
 * What the model is actually handed: the rule block and the session context, rendered from stored
 * memories that neither the plugin nor the user fully controls.
 *
 * Two properties matter more than wording. The text must survive the harness's prompt renderer
 * verbatim — a single rule containing `${{ secrets.GITHUB_TOKEN }}` used to make every assembly in
 * the project throw — and it must stay bounded and attributed, because an agent can write rules and
 * a person has to be able to tell which ones they wrote themselves.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderPrompt as checkoutRenderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  CONTEXT_ENTRY_MAX_CHARS, PROMPT_LITERAL_BRACES, RULES_BLOCK_MAX_CHARS, RULE_TEXT_MAX_CHARS,
  SESSION_CONTEXT_MAX_CHARS, escapePromptText, renderRules, renderSessionContext,
} from '../src/domain/rules.ts'
import type { Memory, MemoryCategory, SessionContext } from '../src/domain/types.ts'

/** The prompt renderer's input, as both the checkout and the installed harness define it. */
type Render = (assembly: {
  sections: { name: string, text: string }[]
  contexts: { name: string, text: string }[]
  tools: never[]
  variables: Record<string, string | undefined>
}) => string

/**
 * The renderer of the harness installed on this machine, when there is one.
 *
 * The dev dependency is a linked checkout that can lag the release users run, so the escape is also
 * proven against the installed build when it is reachable: `DSH_SYSTEM_PROMPT_MODULE` names it
 * explicitly, otherwise the global npm prefix beside the running `node` is tried.
 */
const INSTALLED_RENDERER = process.env['DSH_SYSTEM_PROMPT_MODULE']
  ?? join(dirname(dirname(process.execPath)), 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js')

let counter = 0

/**
 * Build a stored memory for rendering.
 * @param category - the memory's category.
 * @param title - its title.
 * @param content - its body.
 * @param source - who wrote it.
 * @param priority - its priority.
 * @returns the memory.
 */
function memory(category: MemoryCategory, title: string, content: string, source = 'user', priority = 2): Memory {
  counter += 1
  return {
    id: `m${counter}`, category, title, content, summary: '', tags: [], status: 'active', priority, source,
    relatedIds: [], entities: [], accessCount: 0, createdAt: counter, updatedAt: counter, embedded: false,
  }
}

/**
 * Render one section through a renderer with the literal-brace variable registered, as the host does.
 * @param render - the renderer under test.
 * @param text - the escaped section text.
 * @returns what the model would receive.
 */
function throughRenderer(render: Render, text: string): string {
  return render({
    sections: [{ name: 'memory:rules', text }],
    contexts: [],
    tools: [],
    variables: { [PROMPT_LITERAL_BRACES.name]: PROMPT_LITERAL_BRACES.value, cwd: '/work', model: 'm' },
  })
}

/**
 * Strings built to hit every branch of the renderer's scanner: complete groups, malformed groups,
 * lone openers, odd brace runs, and pairs split across words.
 * @returns the samples, deterministic across runs.
 */
function braceSamples(): string[] {
  const fixed = [
    'Reference tokens as ${{ secrets.GITHUB_TOKEN }} in workflows',
    '{{cwd}}', '{{model}}', '{{', '}}', '{{{', '{{{{', '{{{{{', '{{ }}', '{{}}', '{{{x}}}', '}}{{',
    'x{{y', 'a {{b}} c {{', '{ { } }', '{{a}}{{b}}', '{{unknown_var}}', '{{Upper}}', 'a{b}c',
  ]
  const alphabet = ['{', '{', '}', '}', 'a', ' ', '_', 'x']
  let seed = 7
  const next = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed }
  const random: string[] = []
  for (let sample = 0; sample < 800; sample += 1) {
    const length = 1 + (next() % 14)
    let text = ''
    for (let index = 0; index < length; index += 1) text += alphabet[next() % alphabet.length]
    random.push(text)
  }
  return [...fixed, ...random]
}

describe('escaping memory text for the prompt renderer', () => {
  it('is why the fix exists: an unescaped workflow expression throws at assembly', () => {
    expect(() => throughRenderer(checkoutRenderPrompt as Render, 'use ${{ secrets.GITHUB_TOKEN }}'))
      .toThrow(/prompt variable reference/)
  })

  it('round-trips every brace pattern through the linked harness renderer verbatim', () => {
    for (const sample of braceSamples()) {
      expect(throughRenderer(checkoutRenderPrompt as Render, escapePromptText(sample))).toBe(sample)
    }
  })

  it.skipIf(!existsSync(INSTALLED_RENDERER))('round-trips through the INSTALLED harness renderer too', async () => {
    const installed = await import(pathToFileURL(INSTALLED_RENDERER).href) as { renderPrompt: Render }
    for (const sample of braceSamples()) {
      expect(throughRenderer(installed.renderPrompt, escapePromptText(sample))).toBe(sample)
    }
  })

  it('leaves text without a double brace untouched, so the common case costs nothing', () => {
    expect(escapePromptText('Run doc-sync before pushing {once}.')).toBe('Run doc-sync before pushing {once}.')
  })
})

describe('the rule block', () => {
  it('labels rules an agent recorded, and leaves the user\'s own rules unlabelled', () => {
    const block = renderRules('demo', {
      mandatory: [memory('mandatory_rules', 'Run doc-sync', 'Always.', 'user')],
      forbidden: [memory('forbidden_rules', 'No force push', 'Never.', 'assistant')],
    })
    expect(block).toContain('  - Run doc-sync: Always.')
    expect(block).toContain('  - [added by an agent] No force push: Never.')
    expect(block).toMatch(/added by an agent\].*user/i)
  })

  it('does not explain agent labels to a project whose rules are all the user\'s', () => {
    const block = renderRules('demo', { mandatory: [memory('mandatory_rules', 'A', 'b', 'user')], forbidden: [] })
    expect(block).not.toContain('added by an agent')
  })

  it('cuts an oversized rule and says so, instead of injecting it whole on every request', () => {
    const block = renderRules('demo', {
      mandatory: [memory('mandatory_rules', 'Huge', 'x'.repeat(RULE_TEXT_MAX_CHARS * 5))], forbidden: [],
    })
    expect(block.length).toBeLessThan(RULE_TEXT_MAX_CHARS + 1000)
    expect(block).toMatch(/truncated: \d+ more characters/)
    expect(block).toContain('memory_rules')
  })

  it('keeps the block within its budget, dropping agent rules before any rule the user wrote', () => {
    const user = Array.from({ length: 12 }, (_, index) =>
      memory(index % 2 === 0 ? 'mandatory_rules' : 'forbidden_rules', `User rule ${index}`, 'u'.repeat(1500), 'user'))
    const agent = Array.from({ length: 40 }, (_, index) =>
      memory('mandatory_rules', `Agent rule ${index}`, 'a'.repeat(1500), 'assistant', 3))
    const block = renderRules('demo', {
      mandatory: [...agent, ...user.filter(rule => rule.category === 'mandatory_rules')],
      forbidden: user.filter(rule => rule.category === 'forbidden_rules'),
    })
    expect(block.length).toBeLessThanOrEqual(RULES_BLOCK_MAX_CHARS)
    for (const rule of user) expect(block).toContain(rule.title)
    expect(block).toMatch(/\d+ more rules? not shown/)
  })
})

describe('the session context', () => {
  /**
   * A session context with the given sprint goals and decisions.
   * @param sprint - sprint memories.
   * @param decisions - recent decisions.
   * @returns the context.
   */
  function context(sprint: Memory[], decisions: Memory[]): SessionContext {
    return {
      sessionId: 's', project: 'demo', mandatory: [], forbidden: [], sprint, recentDecisions: decisions,
      orphansClosed: 0,
    }
  }

  it('cuts each carried memory to a bounded excerpt', () => {
    const text = renderSessionContext(context([], [memory('decision', 'Big', 'd'.repeat(CONTEXT_ENTRY_MAX_CHARS * 4), 'user', 0)]))
    expect(text.length).toBeLessThan(CONTEXT_ENTRY_MAX_CHARS + 600)
    expect(text).toMatch(/truncated/)
  })

  it('stays within its total budget and points at search for the rest', () => {
    const decisions = Array.from({ length: 40 }, (_, index) =>
      memory('decision', `Decision ${index}`, 'd'.repeat(CONTEXT_ENTRY_MAX_CHARS), 'user', 0))
    const text = renderSessionContext(context(decisions.slice(0, 10), decisions.slice(10)))
    expect(text.length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_CHARS)
    expect(text).toMatch(/\d+ more not shown/)
    expect(text).toContain('memory_search')
  })
})
