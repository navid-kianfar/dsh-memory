/**
 * The text derivations every write and every query depend on: what counts as a token, what a summary
 * says, and which terms a memory is treated as being *about*.
 */
import { describe, expect, it } from 'vitest'
import {
  embeddingText, estimateTokens, extractEntities, projectSlug, queryTerms, summarize, tokenize,
} from '../src/domain/text.ts'

describe('tokenize', () => {
  it('keeps identifiers whole so a search for a symbol finds the memory naming it', () => {
    expect(tokenize('array_cosine_similarity and tsconfig.base.json in dsh-memory'))
      .toEqual(['array_cosine_similarity', 'tsconfig.base.json', 'dsh-memory'])
  })

  it('trims sentence punctuation so a trailing period does not create a different word', () => {
    expect(tokenize('We chose DuckDB.')).toEqual(tokenize('we chose duckdb'))
  })

  it('drops stop words and single characters', () => {
    expect(tokenize('a b the and of storage')).toEqual(['storage'])
  })

  it('preserves repetition, which term frequency depends on', () => {
    expect(tokenize('cache cache cache')).toEqual(['cache', 'cache', 'cache'])
  })
})

describe('queryTerms', () => {
  it('counts a repeated query word once', () => {
    expect(queryTerms('cache the cache')).toEqual(['cache'])
  })

  it('is empty for a query made entirely of stop words', () => {
    expect(queryTerms('the and of it')).toEqual([])
  })
})

describe('summarize', () => {
  it('uses the first sentence alone once it says enough by itself', () => {
    expect(summarize('Storage', 'We chose DuckDB because the store is queried by hand. It has vectors too.'))
      .toBe('We chose DuckDB because the store is queried by hand.')
  })

  it('cuts an over-long first sentence rather than running it into the listing', () => {
    const long = `${Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')}.`
    const summary = summarize('Title', long)
    expect(summary.endsWith('…')).toBe(true)
    // The ellipsis rides the last kept word, so twenty words is twenty whitespace-separated pieces.
    expect(summary.split(/\s+/)).toHaveLength(20)
  })

  it('prepends the title when the first sentence says too little on its own', () => {
    expect(summarize('Journal mode', 'WAL.')).toBe('Journal mode: WAL.')
  })

  it('falls back to the title for empty content', () => {
    expect(summarize('Only a title', '')).toBe('Only a title')
  })
})

describe('extractEntities', () => {
  it('finds names that end in a capitalised run', () => {
    const entities = extractEntities('We picked DuckDB over SQLite, not PostgreSQL or FastMCP.')
    expect(entities).toContain('DuckDB')
    expect(entities).toContain('PostgreSQL')
    expect(entities).toContain('FastMCP')
  })

  it('finds acronyms but not ordinary uppercase words', () => {
    const entities = extractEntities('The API returns JSON and IT IS NOT XML')
    expect(entities).toEqual(expect.arrayContaining(['API', 'JSON', 'XML']))
    expect(entities).not.toContain('NOT')
    expect(entities).not.toContain('THE')
  })

  it('finds a plain product name in the middle of a sentence but not a sentence-initial word', () => {
    expect(extractEntities('images publish through Docker nightly')).toContain('Docker')
    expect(extractEntities('Nightly builds run.')).not.toContain('Nightly')
  })

  it('finds identifiers, mentions, tags, and short quoted terms', () => {
    const entities = extractEntities('see `array_to_string`, ping @navid about #memory and "wal mode"')
    expect(entities).toEqual(expect.arrayContaining([
      'array_to_string', '@navid', '#memory', 'wal mode',
    ]))
  })

  it('returns a sorted, deduplicated list', () => {
    const entities = extractEntities('DuckDB and DuckDB again, plus API and API')
    expect(entities).toEqual([...new Set(entities)].sort())
  })
})

describe('estimateTokens', () => {
  it('never reports zero for text that exists', () => {
    expect(estimateTokens('a')).toBe(1)
  })

  it('scales with length', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('projectSlug', () => {
  it('derives a slug from the directory name', () => {
    expect(projectSlug('/Users/me/Desktop/DEV/DeepSeek Harness')).toBe('deepseek-harness')
  })

  it('ignores a trailing separator', () => {
    expect(projectSlug('/Users/me/my-app/')).toBe('my-app')
  })

  it('answers something usable for a path with no usable name', () => {
    expect(projectSlug('/')).toBe('project')
  })
})

describe('embeddingText', () => {
  it('carries the title, because content alone loses what framed it', () => {
    expect(embeddingText('Storage', 'DuckDB')).toBe('Storage\nDuckDB')
  })
})
