/**
 * Turning an existing instructions file — `CLAUDE.md`, `AGENTS.md`, a house style guide — into
 * structured memory.
 *
 * A project that already writes its conventions down should not have to retype them to make them
 * binding. The parse is heading-driven: a heading names what its section is about, keywords in that
 * name decide the category, and a section that reads as rules is split so each rule is separately
 * editable, revocable, and auditable — which is the whole difference between a rule the plugin can
 * enforce and a paragraph it can only recall.
 *
 * @module @achasoft/dsh-memory/host/import
 */

import type { CreateMemoryInput, MemoryCategory } from '../domain/types.ts'

/** A Markdown ATX heading and its text. */
const HEADING = /^(#{1,6})\s+(.*)$/

/** A Markdown list item, bulleted or numbered. */
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

/**
 * Heading keywords that decide a section's category, in priority order.
 *
 * Forbidden is tested before mandatory on purpose: a heading reading "Never commit secrets" contains
 * both a prohibition and the word "commit", and classifying it as something to always do would
 * invert the rule.
 */
const CATEGORY_KEYWORDS: readonly (readonly [MemoryCategory, readonly string[]])[] = [
  ['forbidden_rules', ['forbidden', 'never', "don't", 'do not', 'avoid', 'prohibit', 'must not']],
  ['mandatory_rules', ['mandatory', 'must', 'always', 'rule', 'required', 'convention', 'guideline', 'policy']],
  ['architecture', ['architecture', 'structure', 'design', 'stack', 'module', 'component', 'layout']],
  ['devops', ['devops', 'deploy', 'ci/cd', 'pipeline', 'infra', 'build', 'release', 'command']],
  ['decision', ['decision', 'chose', 'rationale', 'why we', 'trade-off']],
  ['sprint', ['sprint', 'milestone', 'roadmap', 'backlog']],
  ['reference', ['reference', 'resource', 'link', 'external']],
]

/** Longest title derived from a heading or a bullet before it is cut. */
const TITLE_MAX = 90

/** Categories whose sections are split into one memory per list item. */
const SPLIT_CATEGORIES: readonly MemoryCategory[] = ['mandatory_rules', 'forbidden_rules']

/**
 * Classify a section by its heading.
 * @param heading - the heading text.
 * @returns the matching category, or `developer_docs` when nothing matches.
 */
export function categoryForHeading(heading: string): MemoryCategory {
  const lower = heading.toLowerCase()
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(keyword => lower.includes(keyword))) return category
  }
  return 'developer_docs'
}

/**
 * Derive a title from a line of prose.
 * @param text - the heading or list item.
 * @returns the collapsed text, cut at {@link TITLE_MAX} with an ellipsis.
 */
function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').replace(/^[*_`#\s]+|[*_`\s]+$/g, '').trim()
  return collapsed.length <= TITLE_MAX ? collapsed : `${collapsed.slice(0, TITLE_MAX - 1)}…`
}

/** One heading and the body beneath it. */
interface Section {
  readonly heading: string
  readonly body: string
}

/**
 * Split Markdown into sections at every heading.
 *
 * Text before the first heading becomes an `Overview` section rather than being dropped: a file
 * whose first paragraph states the project's whole purpose is common, and losing it would make the
 * import quietly incomplete.
 * @param text - the file's contents.
 * @returns the sections in document order; a section with an empty body is omitted.
 */
export function splitSections(text: string): Section[] {
  const sections: Section[] = []
  let heading: string | undefined
  let body: string[] = []

  const flush = (): void => {
    const joined = body.join('\n').trim()
    if (heading !== undefined) sections.push({ heading, body: joined })
    else if (joined.length > 0) sections.push({ heading: 'Overview', body: joined })
  }

  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line)
    if (match === null) { body.push(line); continue }
    flush()
    heading = (match[2] ?? '').trim()
    body = []
  }
  flush()
  return sections.filter(section => section.body.length > 0)
}

/**
 * Read the list items of a section body.
 * @param body - the section body.
 * @returns each item's text, in order; empty when the body is prose.
 */
export function listItems(body: string): string[] {
  const items: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = BULLET.exec(line)
    const item = match?.[1]?.trim()
    if (item !== undefined && item.length > 0) items.push(item)
  }
  return items
}

/**
 * Parse an instructions file into memories ready to store.
 *
 * A rules section becomes one memory per list item; every other section becomes one memory carrying
 * its whole body. A rules section written as prose rather than a list is stored whole too — splitting
 * paragraphs on guesswork would produce rules nobody wrote.
 * @param text - the file's contents.
 * @returns the memories to create, in document order; empty when nothing parsed.
 */
export function parseInstructions(text: string): CreateMemoryInput[] {
  const created: CreateMemoryInput[] = []
  for (const section of splitSections(text)) {
    const category = categoryForHeading(section.heading)
    if (SPLIT_CATEGORIES.includes(category)) {
      const items = listItems(section.body)
      if (items.length > 0) {
        for (const item of items) {
          created.push({
            category, title: titleFrom(item), content: item, tags: ['imported'],
          })
        }
        continue
      }
    }
    created.push({
      category,
      title: titleFrom(section.heading) || 'Untitled',
      content: section.body,
      tags: ['imported'],
    })
  }
  return created
}
