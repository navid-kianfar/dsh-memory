/**
 * Retention: when a stored memory stops being current.
 *
 * A project's memory is only useful while it is trustworthy, and a sprint note from eighteen months
 * ago is worse than no note at all — it reads as current and is not. Expiry is therefore part of
 * writing a memory rather than a cleanup job bolted on later: each category carries a default
 * lifetime, priority extends it, and rules are exempt because a rule the model stops seeing is a
 * rule that silently stopped applying.
 *
 * @module @achasoft/dsh-memory/domain/retention
 */

import { RULE_MIN_PRIORITY, type Memory, type MemoryCategory, type MemoryStatus } from './types.ts'

/** Milliseconds in a day. */
const DAY_MS = 86_400_000

/**
 * Default lifetime of each category in days; `null` means it never expires.
 *
 * These are defaults a deployment overrides through the plugin's `retentionDays` config, not fixed
 * policy. The shape of the table is the fixed part: a decision outlives a sprint, and a rule outlives
 * both.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<MemoryCategory, number | null>> = {
  session: 30,
  sprint: 90,
  feedback: 90,
  devops: 180,
  developer_docs: 180,
  decision: 365,
  project_plan: 365,
  architecture: 365,
  reference: 365,
  mandatory_rules: null,
  forbidden_rules: null,
}

/**
 * How much a memory's priority extends its lifetime. Priority {@link RULE_MIN_PRIORITY} and above
 * never expires — that band is where rules live, and where an author has said this outlasts the
 * work that produced it.
 */
const PRIORITY_MULTIPLIER: Readonly<Record<number, number | null>> = {
  0: 1,
  1: 1.5,
}

/**
 * Compute a memory's expiry.
 * @param category - the memory's category.
 * @param priority - its priority; at or above {@link RULE_MIN_PRIORITY} nothing expires.
 * @param now - the current time, epoch milliseconds.
 * @param table - per-category lifetimes; defaults to {@link DEFAULT_RETENTION_DAYS}. A category the
 *   table leaves out (or maps to `undefined`) takes the default; a category it maps to `null` never
 *   expires. The two must stay distinct: `null` is how a deployment's "0 days" arrives, and a `??`
 *   fallback would silently turn "never" back into the default.
 * @returns the expiry in epoch milliseconds, or undefined when this memory never expires.
 */
export function expiresAt(
  category: MemoryCategory,
  priority: number,
  now: number,
  table: Readonly<Partial<Record<MemoryCategory, number | null | undefined>>> = DEFAULT_RETENTION_DAYS,
): number | undefined {
  if (priority >= RULE_MIN_PRIORITY) return undefined
  const configured = table[category]
  const days = configured === undefined ? DEFAULT_RETENTION_DAYS[category] : configured
  if (days === null || days === undefined) return undefined
  const multiplier = PRIORITY_MULTIPLIER[priority]
  if (multiplier === null || multiplier === undefined) return undefined
  return now + Math.round(days * multiplier) * DAY_MS
}

/**
 * The status a memory has at a moment, rather than the one stored for it.
 *
 * The stored status only turns `expired` when a session start sweeps, so between a memory's
 * retention date and that sweep the row still says `active`. Everything a person or a model is shown
 * is classified through this, so that window cannot make a memory active to one reader and expired
 * to another.
 * @param memory - the stored status and retention date.
 * @param memory.status - the status as stored.
 * @param memory.expiresAt - the retention date, absent when it never expires.
 * @param now - the moment to classify at, epoch milliseconds.
 * @returns `expired` for an active memory at or past its date, otherwise the stored status.
 */
export function effectiveStatus(memory: Pick<Memory, 'status' | 'expiresAt'>, now: number): MemoryStatus {
  if (memory.status !== 'active' || memory.expiresAt === undefined) return memory.status
  return memory.expiresAt > now ? 'active' : 'expired'
}

/**
 * A memory as it stands at a moment: its status replaced by {@link effectiveStatus}.
 * @param memory - the stored memory.
 * @param now - the moment to classify at.
 * @returns the same memory when nothing changed, or a copy carrying the effective status.
 */
export function asOf<M extends Memory>(memory: M, now: number): M {
  const status = effectiveStatus(memory, now)
  return status === memory.status ? memory : { ...memory, status }
}
