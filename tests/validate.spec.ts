/**
 * What the two untrusted boundaries accept and reject. Every rejection here is one a model or a
 * browser could produce, so each case is a message someone has to be able to act on.
 */
import { describe, expect, it } from 'vitest'
import {
  MemoryInputError, parseCreate, parseListQuery, parseSearchQuery, parseUpdate, requireRuleCategory,
} from '../src/domain/validate.ts'

describe('parseCreate', () => {
  it('accepts the minimum and fills in the documented defaults', () => {
    expect(parseCreate({ category: 'decision', title: ' Storage ', content: 'DuckDB.' })).toEqual({
      category: 'decision', title: 'Storage', content: 'DuckDB.',
      tags: [], priority: 0, source: 'assistant', relatedIds: [],
    })
  })

  it('accepts both the snake_case and camelCase spellings of related ids', () => {
    expect(parseCreate({ category: 'decision', title: 'A', content: 'B', related_ids: ['x'] }).relatedIds)
      .toEqual(['x'])
    expect(parseCreate({ category: 'decision', title: 'A', content: 'B', relatedIds: ['y'] }).relatedIds)
      .toEqual(['y'])
  })

  it('deduplicates and trims tags', () => {
    expect(parseCreate({ category: 'decision', title: 'A', content: 'B', tags: [' ci ', 'ci', ''] }).tags)
      .toEqual(['ci'])
  })

  it('names the accepted values when the category is wrong', () => {
    expect(() => parseCreate({ category: 'notes', title: 'A', content: 'B' }))
      .toThrow(/category must be one of .*decision/)
  })

  it('rejects a blank title rather than storing an unnamed memory', () => {
    expect(() => parseCreate({ category: 'decision', title: '   ', content: 'B' }))
      .toThrow(MemoryInputError)
  })

  it('rejects a priority outside the accepted band', () => {
    expect(() => parseCreate({ category: 'decision', title: 'A', content: 'B', priority: 9 }))
      .toThrow(/priority must be between 0 and 3/)
  })

  it('rejects metadata that is not a JSON object', () => {
    expect(() => parseCreate({ category: 'decision', title: 'A', content: 'B', metadata: [1, 2] }))
      .toThrow(/metadata must be a JSON object/)
  })
})

describe('parseUpdate', () => {
  it('returns only the fields the caller supplied', () => {
    expect(parseUpdate({ id: 'abc', title: 'New' })).toEqual({ id: 'abc', title: 'New' })
  })

  it('distinguishes clearing metadata from leaving it alone', () => {
    expect(parseUpdate({ id: 'abc', metadata: null }).metadata).toBeNull()
    expect('metadata' in parseUpdate({ id: 'abc', title: 'New' })).toBe(false)
  })

  it('refuses an update that changes nothing', () => {
    expect(() => parseUpdate({ id: 'abc' })).toThrow(/at least one field/)
  })

  it('accepts memory_id as the identity, which is how the tools spell it', () => {
    expect(parseUpdate({ memory_id: 'abc', title: 'New' }).id).toBe('abc')
  })
})

describe('parseSearchQuery', () => {
  it('keeps the query and leaves unnamed options unset', () => {
    expect(parseSearchQuery({ query: ' duckdb ' })).toEqual({ query: 'duckdb' })
  })

  it('rejects a similarity floor outside 0 to 1', () => {
    expect(() => parseSearchQuery({ query: 'a', min_similarity: 2 }))
      .toThrow(/min_similarity must be a number between 0 and 1/)
  })

  it('rejects a limit past the ceiling', () => {
    expect(() => parseSearchQuery({ query: 'a', limit: 5000 })).toThrow(/limit must be between 1 and 100/)
  })
})

describe('parseListQuery', () => {
  it('accepts `all` as a status alongside the real ones', () => {
    expect(parseListQuery({ status: 'all' }).status).toBe('all')
    expect(parseListQuery({ status: 'archived' }).status).toBe('archived')
    expect(() => parseListQuery({ status: 'deleted' })).toThrow(/status must be one of/)
  })

  it('rejects an unknown sort key rather than silently sorting by something else', () => {
    expect(() => parseListQuery({ sort_by: 'relevance' })).toThrow(/sort_by must be one of/)
  })
})

describe('requireRuleCategory', () => {
  it('maps the tool spelling onto the storage category', () => {
    expect(requireRuleCategory('mandatory')).toBe('mandatory_rules')
    expect(requireRuleCategory('forbidden')).toBe('forbidden_rules')
  })

  it('rejects anything else', () => {
    expect(() => requireRuleCategory('optional')).toThrow(/rule_type must be one of/)
  })
})
