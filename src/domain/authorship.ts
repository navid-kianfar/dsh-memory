/**
 * Who may change what binds the model.
 *
 * An agent recording a rule is intended: "always run doc-sync" said once in conversation should
 * outlive the session. But a rule is injected into every request under "follow every one of them",
 * so the rule set is also the most valuable thing in a project for a confused or manipulated agent
 * to write to. This module is the line between the two. An agent may add rules and curate the ones
 * it added; a rule the user wrote is the user's, and only the user changes it; a subagent — whose
 * brief came from another agent rather than from the person — cannot touch the rule set at all.
 *
 * The checks are pure and run inside the write's transaction, against the row as it is at that
 * moment, so an edit cannot slip past them on a stale read.
 *
 * @module @achasoft/dsh-memory/domain/authorship
 */

import { RULE_CATEGORIES, type Memory, type MemoryCategory } from './types.ts'

/**
 * The `source` every model-facing tool stamps on what it writes.
 *
 * Everything else — `user` from the manager, a file name from an import — was put there by a person.
 * The test is deliberately "exactly this label" rather than "anything that is not `user`", so an
 * unfamiliar label errs towards protecting the entry rather than exposing it to agent edits.
 */
export const AGENT_SOURCE = 'assistant'

/**
 * The audit actor recorded for anything a subagent writes, whatever label its caller passed.
 *
 * A subagent's brief came from another agent rather than from the person, so what it records is kept
 * out of the context the next top-level session opens with (it stays searchable). The provenance
 * trail carries that fact rather than `source`, for two reasons. `source` is the authorship contract
 * — documented, and tested by every consumer, as exactly {@link AGENT_SOURCE} for agent-written — so
 * a new value would read as a person's entry everywhere that test runs. And the trail records every
 * write, not just the first: a subagent that rewrites an entry someone else created has written the
 * text the next session would read, and that edit marks the entry too. The trail is written by this
 * plugin inside the write's transaction, never by the model.
 */
export const SUBAGENT_ACTOR = 'subagent'

/** Most live rules agents may hold in one project; the user's own rules do not count against it. */
export const AGENT_RULE_LIMIT = 100

/**
 * Longest rule body an agent may write.
 *
 * Far below the general content ceiling on purpose: a rule is repeated on every request, and one
 * obligation stated well does not need more than this. A person may still write longer rules, which
 * the rule block truncates with a marker rather than refusing.
 */
export const AGENT_RULE_CONTENT_MAX_CHARS = 4000

/** Raised when a caller asks for a change its authorship does not allow. */
export class MemoryForbiddenError extends Error {
  /**
   * @param message - what was refused and who can do it instead.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MemoryForbiddenError'
  }
}

/**
 * Who is writing, beyond the audit label.
 *
 * Absent entirely for a person using the manager. Present for a tool call, where `session` is the
 * calling agent's harness session id — its memory session and counters are keyed by it — and `agent`
 * says whether that agent is a delegated subagent.
 */
export interface WriteOrigin {
  /** The calling agent's harness session id. */
  readonly session?: string
  /** Present when a model is writing through a tool rather than a person through the manager. */
  readonly agent?: {
    /** True for a delegated child agent, which may not change the binding rule set. */
    readonly subagent: boolean
  }
}

/**
 * Whether a category is enforced as a rule.
 * @param category - the category to test.
 * @returns true for the two rule categories.
 */
export function isRuleCategory(category: MemoryCategory): boolean {
  return (RULE_CATEGORIES as readonly string[]).includes(category)
}

/**
 * Whether an agent, rather than a person, wrote a memory.
 * @param memory - the memory, or just its source.
 * @returns true when the source is {@link AGENT_SOURCE}.
 */
export function isAgentAuthored(memory: Pick<Memory, 'source'>): boolean {
  return memory.source === AGENT_SOURCE
}

/**
 * The actor a write is audited under.
 * @param actor - the label the caller passed: `agent`, `user`, or its own.
 * @param origin - who is writing.
 * @returns {@link SUBAGENT_ACTOR} for a subagent's write, otherwise the caller's label.
 */
export function auditActor(actor: string, origin: WriteOrigin | undefined): string {
  return origin?.agent?.subagent === true ? SUBAGENT_ACTOR : actor
}

/**
 * Refuse an agent's new memory when it would be a rule the agent may not add.
 * @param category - the new memory's category.
 * @param content - its body, for the length check.
 * @param origin - who is writing; a person's write is never refused here.
 * @param agentRules - live agent-authored rules the project already holds.
 * @throws MemoryForbiddenError when a subagent states a rule, or the agent's rule quota is full.
 * @throws MemoryForbiddenError when the rule body exceeds {@link AGENT_RULE_CONTENT_MAX_CHARS}.
 */
export function assertAgentMayCreate(
  category: MemoryCategory, content: string, origin: WriteOrigin | undefined, agentRules: number,
): void {
  if (origin?.agent === undefined || !isRuleCategory(category)) return
  if (origin.agent.subagent) throw subagentRefusal()
  assertRuleLength(content)
  if (agentRules >= AGENT_RULE_LIMIT) {
    throw new MemoryForbiddenError(
      `agents may hold at most ${AGENT_RULE_LIMIT} rules in this project; retire one that no longer `
      + 'applies, or ask the user to add this rule in the Memory tab',
    )
  }
}

/**
 * Refuse an agent's edit, archive, or restore when it touches a rule the agent may not change.
 * @param existing - the memory as it is right now.
 * @param category - the category it will have after the change.
 * @param content - the body it will have after the change.
 * @param origin - who is writing; a person's write is never refused here.
 * @throws MemoryForbiddenError when a subagent touches the rule set, when the entry is a rule the
 *   user wrote, or when a person's memory would become a rule on an agent's say-so.
 */
export function assertAgentMayChange(
  existing: Memory, category: MemoryCategory, content: string, origin: WriteOrigin | undefined,
): void {
  if (origin?.agent === undefined) return
  const touchesRules = isRuleCategory(existing.category) || isRuleCategory(category)
  if (!touchesRules) return
  if (origin.agent.subagent) throw subagentRefusal()
  if (!isAgentAuthored(existing)) {
    throw new MemoryForbiddenError(
      isRuleCategory(existing.category)
        ? `"${existing.title}" is a rule the user wrote; only the user can change or retire it, from the Memory tab`
        : `"${existing.title}" was written by the user; only the user can make it a binding rule, from the `
          + 'Memory tab. Use memory_add_rule to record a rule of your own instead',
    )
  }
  if (isRuleCategory(category)) assertRuleLength(content)
}

/**
 * Refuse a rule body over the agent ceiling.
 * @param content - the rule body.
 * @throws MemoryForbiddenError when it is longer than {@link AGENT_RULE_CONTENT_MAX_CHARS}.
 */
function assertRuleLength(content: string): void {
  if (content.length <= AGENT_RULE_CONTENT_MAX_CHARS) return
  throw new MemoryForbiddenError(
    `a rule an agent records must be at most ${AGENT_RULE_CONTENT_MAX_CHARS} characters (got ${content.length}); `
    + 'state one obligation per rule',
  )
}

/**
 * The refusal a subagent receives for any change to the rule set.
 * @returns the error.
 */
function subagentRefusal(): MemoryForbiddenError {
  return new MemoryForbiddenError(
    'a subagent cannot change the project\'s binding rules; report the rule in your reply so the '
    + 'delegating agent or the user can record it',
  )
}
