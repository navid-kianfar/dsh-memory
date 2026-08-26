/**
 * How a project's rules are stated to the model.
 *
 * This is the plugin's whole point of existence rendered as text: everything else stores and ranks,
 * but a rule only works if the model reads it on the request where it matters. The rendering lives
 * in its own pure module so that what the model sees is testable without a database, and so the
 * system-prompt section, the session-start injection, and the `memory_rules` tool cannot each
 * describe the same rules differently.
 *
 * @module @achasoft/dsh-memory/domain/rules
 */

import type { Memory, RuleSet, SessionContext } from './types.ts'

/** Render one memory as a bullet: its title as the claim, its content as the detail. */
function bullet(memory: Memory): string {
  const content = memory.content.trim()
  return content.length === 0 ? `  - ${memory.title}` : `  - ${memory.title}: ${content}`
}

/**
 * Render the binding rules block injected into every model request.
 *
 * Deliberately imperative and short. This text is repeated on every request, so each extra line is
 * paid for on every turn — and a rule block that argues with itself about tone is a rule block the
 * model weighs against the rest of the prompt instead of obeying.
 * @param project - the project slug, so a model working across projects can tell whose rules these are.
 * @param rules - the complete rule set; both halves are rendered in full, never ranked or truncated.
 * @returns the block, or `''` when the project has no rules (so the caller contributes nothing).
 */
export function renderRules(project: string, rules: Pick<RuleSet, 'mandatory' | 'forbidden'>): string {
  if (rules.mandatory.length === 0 && rules.forbidden.length === 0) return ''
  const lines = [`Binding rules for project "${project}". Follow every one of them.`]
  if (rules.mandatory.length > 0) {
    lines.push('MANDATORY — always do this:')
    for (const rule of rules.mandatory) lines.push(bullet(rule))
  }
  if (rules.forbidden.length > 0) {
    lines.push('FORBIDDEN — never do this:')
    for (const rule of rules.forbidden) lines.push(bullet(rule))
  }
  lines.push(
    'If a request conflicts with a rule above, say so and stop rather than proceeding.',
  )
  return lines.join('\n')
}

/** How many characters of a stored session summary are carried into the next session. */
const SUMMARY_LIMIT = 1500

/**
 * Render the context a session opens with: what happened last time, what is in flight, and what was
 * recently decided.
 *
 * Rules are NOT included. They reach the model through the system prompt on every request, and
 * repeating them here would double their token cost while making the two copies able to disagree
 * after a mid-session edit.
 * @param context - the session context loaded at start.
 * @returns the block, or `''` when the project has nothing to carry forward.
 */
export function renderSessionContext(context: SessionContext): string {
  const lines: string[] = []
  if (context.lastSummary !== undefined && context.lastSummary.trim().length > 0) {
    lines.push('Where the last session left off:', context.lastSummary.trim().slice(0, SUMMARY_LIMIT))
  }
  if (context.sprint.length > 0) {
    lines.push('', 'Current sprint goals:')
    for (const memory of context.sprint) lines.push(bullet(memory))
  }
  if (context.recentDecisions.length > 0) {
    lines.push('', 'Recent decisions:')
    for (const memory of context.recentDecisions) lines.push(bullet(memory))
  }
  if (lines.length === 0) return ''
  return [
    `Project memory for "${context.project}".`,
    ...lines,
    '',
    'Search the rest with `memory_search`, and record new decisions and rules as they are made.',
  ].join('\n')
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
