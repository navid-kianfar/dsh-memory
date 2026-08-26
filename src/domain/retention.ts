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

import { RULE_MIN_PRIORITY, type MemoryCategory } from './types.ts'

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
 * @param table - per-category lifetimes; defaults to {@link DEFAULT_RETENTION_DAYS}.
 * @returns the expiry in epoch milliseconds, or undefined when this memory never expires.
 */
export function expiresAt(
  category: MemoryCategory,
  priority: number,
  now: number,
  table: Readonly<Partial<Record<MemoryCategory, number | null>>> = DEFAULT_RETENTION_DAYS,
): number | undefined {
  if (priority >= RULE_MIN_PRIORITY) return undefined
  const days = table[category] ?? DEFAULT_RETENTION_DAYS[category]
  if (days === null || days === undefined) return undefined
  const multiplier = PRIORITY_MULTIPLIER[priority]
  if (multiplier === null || multiplier === undefined) return undefined
  return now + Math.round(days * multiplier) * DAY_MS
}
