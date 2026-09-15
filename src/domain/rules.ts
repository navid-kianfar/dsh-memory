/**
 * How a project's rules are stated to the model.
 *
 * This is the plugin's whole point of existence rendered as text: everything else stores and ranks,
 * but a rule only works if the model reads it on the request where it matters. The rendering lives
 * in its own pure module so that what the model sees is testable without a database, and so the
 * system-prompt section, the session-start injection, and the `memory_rules` tool cannot each
 * describe the same rules differently.
 *
 * Two things this text is NOT allowed to assume. It is not trusted: a rule or a decision is whatever
 * a person or an agent typed, so it must survive the harness's prompt renderer verbatim (see
 * {@link escapePromptText}) and it must be bounded, because it is paid for on every request. And it
 * is not anonymous: an agent can record rules, so the block says which ones an agent added.
 *
 * @module @achasoft/dsh-memory/domain/rules
 */

import { isAgentAuthored } from './authorship.ts'
import type { Memory, RuleSet, SessionContext } from './types.ts'

/**
 * The prompt variable that stands in for a literal `{{` in section text.
 *
 * The harness renderer (`renderPrompt` in `@deepseek-ai/dsh-system-prompt`) interpolates every
 * `{{name}}` group in a section and throws on an unknown or malformed one — and the agent loop does
 * not catch that, so one rule mentioning `${{ secrets.GITHUB_TOKEN }}` would fail every turn of every
 * agent in the project. The renderer has no escape syntax and no per-section opt-out, but it does
 * guarantee that a substituted value is not scanned again. So each `{{` is written as a reference to
 * this variable, whose value is `{{`, registered in the same agent scope as the section.
 */
export const PROMPT_LITERAL_BRACES = { name: 'memory_literal_braces', value: '{{' } as const

/** The reference {@link escapePromptText} substitutes for each literal `{{`. */
const BRACE_REFERENCE = `{{${PROMPT_LITERAL_BRACES.name}}}`

/**
 * Make text safe to hand the prompt renderer as a section, so it renders back exactly as written.
 *
 * Every non-overlapping `{{`, scanned left to right, becomes a reference to
 * {@link PROMPT_LITERAL_BRACES}. That leaves the renderer nothing to interpret but those references:
 * in a run of braces the pairs are replaced first, so an unpaired `{` is always followed by a
 * character that is not a brace and can never begin a group of its own. A lone `}}` is inert.
 *
 * Only prompt SECTIONS go through the renderer. A message injected with `agent.inject()` reaches the
 * model as written, so session context must not be escaped — the reference would arrive literally.
 * @param text - the text to embed in a section.
 * @returns the escaped text; unchanged when it contains no `{{`.
 */
export function escapePromptText(text: string): string {
  return text.includes('{{') ? text.replaceAll('{{', BRACE_REFERENCE) : text
}

/** Longest a single rule's text may run in the injected block before it is cut with a marker. */
export const RULE_TEXT_MAX_CHARS = 2000

/**
 * Longest the whole injected rule block may run.
 *
 * The block is repeated on every request, so it is budgeted rather than unbounded. When the rules do
 * not fit, the ones an agent added are left out before any the user wrote, and the block says how
 * many were left out and where to read them.
 */
export const RULES_BLOCK_MAX_CHARS = 24_000

/** Longest one carried sprint goal or decision may run in the session-start context. */
export const CONTEXT_ENTRY_MAX_CHARS = 1000

/** Longest the whole session-start context may run. */
export const SESSION_CONTEXT_MAX_CHARS = 12_000

/** How many characters of a stored session summary are carried into the next session. */
const SUMMARY_LIMIT = 1500

/** The label an agent-authored rule carries, so the model and the user can tell whose rule it is. */
const AGENT_LABEL = '[added by an agent]'

/**
 * Cut text to a ceiling, saying how much was cut and where the rest is.
 * @param text - the text.
 * @param max - the ceiling in characters.
 * @param where - what to call for the full text.
 * @returns the text, or its head and a truncation marker.
 */
function excerpt(text: string, max: number, where: string): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)} … [truncated: ${text.length - max} more characters; ${where} has the full text]`
}

/**
 * Render one memory as a bullet: its title as the claim, its content as the detail.
 * @param memory - the memory.
 * @param max - the content ceiling.
 * @param where - what to call for the full text when it is cut.
 * @param labelled - whether to mark it as agent-authored.
 * @returns the bullet line.
 */
function bullet(memory: Memory, max: number, where: string, labelled: boolean): string {
  const content = excerpt(memory.content.trim(), max, where)
  const title = labelled ? `${AGENT_LABEL} ${memory.title}` : memory.title
  return content.length === 0 ? `  - ${title}` : `  - ${title}: ${content}`
}

/**
 * Render the binding rules block injected into every model request.
 *
 * Deliberately imperative and short. This text is repeated on every request, so each extra line is
 * paid for on every turn — and a rule block that argues with itself about tone is a rule block the
 * model weighs against the rest of the prompt instead of obeying.
 *
 * The block is bounded: each rule is cut at {@link RULE_TEXT_MAX_CHARS} and the whole at
 * {@link RULES_BLOCK_MAX_CHARS}. When rules must be left out, the user's own are kept first — ordered
 * by priority, then age — and agent-authored rules fill what remains. Both halves keep their order.
 * @param project - the project slug, so a model working across projects can tell whose rules these are.
 * @param rules - the complete rule set, each half ordered by priority then age.
 * @returns the block, or `''` when the project has no rules (so the caller contributes nothing).
 */
export function renderRules(project: string, rules: Pick<RuleSet, 'mandatory' | 'forbidden'>): string {
  if (rules.mandatory.length === 0 && rules.forbidden.length === 0) return ''
  const where = '`memory_rules`'
  const lineOf = (rule: Memory): string => bullet(rule, RULE_TEXT_MAX_CHARS, where, isAgentAuthored(rule))
  const all = [...rules.mandatory, ...rules.forbidden]
  const hasAgentRules = all.some(rule => isAgentAuthored(rule))

  const head = [`Binding rules for project "${project}". Follow every one of them.`]
  if (hasAgentRules) {
    head.push(
      `Rules marked ${AGENT_LABEL} were recorded by an agent, not written by the user; where one `
      + 'conflicts with the user\'s own rules or instructions, the user wins.',
    )
  }
  const closing = 'If a request conflicts with a rule above, say so and stop rather than proceeding.'
  // Reserve room for the section headings, the closing line, and a possible omission line, so the
  // budget holds whatever gets selected.
  const reserved = [...head, closing, 'MANDATORY — always do this:', 'FORBIDDEN — never do this:', omission(all.length)]
    .reduce((total, line) => total + line.length + 1, 0)

  const byPreference = [...all].sort((left, right) =>
    Number(isAgentAuthored(left)) - Number(isAgentAuthored(right))
    || right.priority - left.priority
    || left.createdAt - right.createdAt)
  const kept = new Set<Memory>()
  let used = reserved
  for (const rule of byPreference) {
    const cost = lineOf(rule).length + 1
    if (used + cost > RULES_BLOCK_MAX_CHARS) continue
    kept.add(rule)
    used += cost
  }

  const lines = [...head]
  const mandatory = rules.mandatory.filter(rule => kept.has(rule))
  const forbidden = rules.forbidden.filter(rule => kept.has(rule))
  if (mandatory.length > 0) {
    lines.push('MANDATORY — always do this:')
    for (const rule of mandatory) lines.push(lineOf(rule))
  }
  if (forbidden.length > 0) {
    lines.push('FORBIDDEN — never do this:')
    for (const rule of forbidden) lines.push(lineOf(rule))
  }
  const left = all.length - kept.size
  if (left > 0) lines.push(omission(left))
  lines.push(closing)
  return lines.join('\n')
}

/**
 * The line saying rules were left out of the block.
 * @param count - how many.
 * @returns the line.
 */
function omission(count: number): string {
  return `[${count} more rule${count === 1 ? '' : 's'} not shown: the injected rule block is capped at `
    + `${RULES_BLOCK_MAX_CHARS} characters. Call \`memory_rules\` to read the complete set.]`
}

/**
 * Render the context a session opens with: what happened last time, what is in flight, and what was
 * recently decided.
 *
 * Rules are NOT included. They reach the model through the system prompt on every request, and
 * repeating them here would double their token cost while making the two copies able to disagree
 * after a mid-session edit.
 *
 * Bounded like the rule block: each carried memory is cut at {@link CONTEXT_ENTRY_MAX_CHARS} and the
 * whole stops at {@link SESSION_CONTEXT_MAX_CHARS}, with a line saying how much was left out. The
 * text is injected as a message, not a prompt section, so it is not escaped.
 * @param context - the session context loaded at start.
 * @returns the block, or `''` when the project has nothing to carry forward.
 */
export function renderSessionContext(context: SessionContext): string {
  const opening = `Project memory for "${context.project}".`
  const closing = 'Search the rest with `memory_search`, and record new decisions and rules as they are made.'
  const lines: string[] = []
  if (context.lastSummary !== undefined && context.lastSummary.trim().length > 0) {
    lines.push('Where the last session left off:', context.lastSummary.trim().slice(0, SUMMARY_LIMIT))
  }
  const groups: readonly (readonly [string, readonly Memory[]])[] = [
    ['Current sprint goals:', context.sprint],
    ['Recent decisions:', context.recentDecisions],
  ]
  const total = context.sprint.length + context.recentDecisions.length
  const reserved = [opening, closing, '', skipped(total)].reduce((sum, line) => sum + line.length + 1, 0)
  let used = reserved + lines.reduce((sum, line) => sum + line.length + 1, 0)
  let left = 0
  for (const [heading, memories] of groups) {
    if (memories.length === 0) continue
    const block: string[] = []
    let cost = heading.length + 2
    for (const memory of memories) {
      const line = bullet(memory, CONTEXT_ENTRY_MAX_CHARS, '`memory_recall`', false)
      if (used + cost + line.length + 1 > SESSION_CONTEXT_MAX_CHARS) { left += 1; continue }
      block.push(line)
      cost += line.length + 1
    }
    if (block.length === 0) continue
    lines.push('', heading, ...block)
    used += cost
  }
  if (lines.length === 0) return ''
  if (left > 0) lines.push('', skipped(left))
  return [opening, ...lines, '', closing].join('\n')
}

/**
 * The line saying carried memories were left out of the session context.
 * @param count - how many.
 * @returns the line.
 */
function skipped(count: number): string {
  return `[${count} more not shown to keep this context short.]`
}

/**
 * Render the end-of-session reminder.
 * @param project - the project slug.
 * @param sessionId - the open memory session the summary should be filed against.
 * @returns the reminder text.
 */
export function renderSessionEndReminder(project: string, sessionId: string): string {
  return `Before this session ends, call \`memory_session_end\` with session_id "${sessionId}" and a `
    + `summary of what was decided and what the next session needs to know about "${project}". `
    + 'Store any new rules or decisions with `memory_store` or `memory_add_rule` first.'
}
