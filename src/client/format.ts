/**
 * Rendering helpers shared by the manager's panels: dates, categories, and the tag list.
 *
 * @module @achasoft/dsh-memory/client/format
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryCategoryWire } from '../host/types.ts'

/** Every category, in the order the manager offers them. */
export const CATEGORY_ORDER: readonly MemoryCategoryWire[] = [
  'mandatory_rules', 'forbidden_rules', 'decision', 'architecture', 'devops', 'sprint',
  'project_plan', 'feedback', 'developer_docs', 'reference', 'session',
]

/** The categories the editor offers for an ordinary memory, rules excluded. */
export const AUTHORABLE_CATEGORIES: readonly MemoryCategoryWire[] =
  CATEGORY_ORDER.filter(category => !category.endsWith('_rules'))

/** The two rule categories, in the order the rules tab shows them. */
export const RULE_CATEGORIES: readonly MemoryCategoryWire[] = ['mandatory_rules', 'forbidden_rules']

/**
 * Whether a category is a rule.
 * @param category - the category to test.
 * @returns true for the two rule categories.
 */
export function isRule(category: MemoryCategoryWire): boolean {
  return category.endsWith('_rules')
}

/**
 * The translated name of a category.
 * @param t - the namespace-bound translate.
 * @param category - the category.
 * @returns the display name.
 */
export function categoryLabel(t: TranslateNS<'memory'>, category: MemoryCategoryWire): string {
  return t(`category.${category}` as Parameters<typeof t>[0])
}

/**
 * Render a timestamp as a local date and time.
 *
 * The viewer's own locale and zone, from `Intl` rather than a formatting library: a memory's date is
 * read at a glance, and an absolute local time is what a person compares against their own memory of
 * when something happened.
 * @param at - epoch milliseconds.
 * @returns the formatted instant.
 */
export function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Render a timestamp as a local date.
 * @param at - epoch milliseconds.
 * @returns the formatted date.
 */
export function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Split a comma-separated tag field into tags.
 * @param raw - the field's text.
 * @returns the trimmed, deduplicated, non-empty tags.
 */
export function parseTags(raw: string): string[] {
  const tags: string[] = []
  for (const part of raw.split(',')) {
    const tag = part.trim()
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}
