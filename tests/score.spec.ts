/**
 * Ranking behaviour that must not drift: which of two memories a query prefers, and what the
 * normalized similarity means.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEVANCE_WEIGHTS, accessScore, blendSimilarity, inverseDocumentFrequency, recencyScore,
  relevance, scoreLexical, type CorpusStats, type LexicalDocument,
} from '../src/domain/score.ts'

/** Build a candidate with only the fields a case exercises. */
function doc(id: string, fields: Partial<LexicalDocument['fields']>): LexicalDocument {
  return { id, fields: { title: '', entities: '', tags: '', summary: '', content: '', ...fields } }
}

const STATS: CorpusStats = {
  documentCount: 10,
  averageLength: { title: 20, entities: 20, tags: 10, summary: 60, content: 200 },
}

describe('scoreLexical', () => {
  it('prefers a title match over the same term buried in a body', () => {
    const scores = scoreLexical(['deployment'], [
      doc('title', { title: 'Deployment', content: 'Docker images publish on release.' }),
      doc('body', { title: 'Notes', content: 'Deployment is mentioned here in passing only.' }),
    ], STATS)
    expect(scores.get('title')!.raw).toBeGreaterThan(scores.get('body')!.raw)
  })

  it('prefers a memory matching both query terms over one matching either alone', () => {
    const scores = scoreLexical(['duckdb', 'vectors'], [
      doc('both', { title: 'Storage', content: 'We chose DuckDB because it stores vectors.' }),
      doc('one', { title: 'Storage', content: 'We chose DuckDB for everything else.' }),
    ], STATS)
    expect(scores.get('both')!.raw).toBeGreaterThan(scores.get('one')!.raw)
  })

  it('normalizes to the share of the query a memory matched', () => {
    const scores = scoreLexical(['duckdb', 'kubernetes'], [
      doc('half', { title: 'DuckDB DuckDB DuckDB DuckDB DuckDB DuckDB DuckDB DuckDB' }),
    ], STATS)
    const { normalized } = scores.get('half')!
    // One of two equally rare terms, matched heavily: near half the query's information content.
    expect(normalized).toBeGreaterThan(0.35)
    expect(normalized).toBeLessThan(0.5)
  })

  it('never exceeds 1 however often a term repeats', () => {
    const scores = scoreLexical(['cache'], [doc('a', { title: 'cache '.repeat(500) })], STATS)
    expect(scores.get('a')!.normalized).toBeLessThanOrEqual(1)
  })

  it('scores every candidate zero for a query with no terms', () => {
    const scores = scoreLexical([], [doc('a', { title: 'anything' })], STATS)
    expect(scores.get('a')).toEqual({ raw: 0, normalized: 0 })
  })

  it('discounts a long memory against a short one carrying the same term once', () => {
    const scores = scoreLexical(['cache'], [
      doc('short', { content: 'The cache.' }),
      doc('long', { content: `The cache. ${'filler words here. '.repeat(60)}` }),
    ], STATS)
    expect(scores.get('short')!.raw).toBeGreaterThan(scores.get('long')!.raw)
  })

  it('weights a rare term above one that is nearly everywhere', () => {
    const documents = [
      doc('rare', { content: 'duckdb' }),
      ...Array.from({ length: 8 }, (_, index) => doc(`common${index}`, { content: 'storage' })),
      doc('common8', { content: 'storage duckdb' }),
    ]
    const scores = scoreLexical(['duckdb', 'storage'], documents, STATS)
    // 'duckdb' appears in two of ten candidates and 'storage' in nine, so the memory carrying only
    // the rare term outscores any carrying only the common one.
    expect(scores.get('rare')!.raw).toBeGreaterThan(scores.get('common0')!.raw)
  })

  it('survives an empty corpus without dividing by a zero average', () => {
    const scores = scoreLexical(['cache'], [doc('a', { title: 'cache' })], {
      documentCount: 0,
      averageLength: { title: 0, entities: 0, tags: 0, summary: 0, content: 0 },
    })
    expect(Number.isFinite(scores.get('a')!.raw)).toBe(true)
    expect(scores.get('a')!.normalized).toBe(0)
  })
})

describe('inverseDocumentFrequency', () => {
  it('stays positive for a term present in every document', () => {
    expect(inverseDocumentFrequency(10, 10)).toBeGreaterThan(0)
  })

  it('rises as a term gets rarer', () => {
    expect(inverseDocumentFrequency(100, 1)).toBeGreaterThan(inverseDocumentFrequency(100, 50))
  })
})

describe('recency and access', () => {
  it('scores a memory touched now at 1 and decays with age', () => {
    const now = 1_800_000_000_000
    expect(recencyScore(now, now)).toBe(1)
    expect(recencyScore(now - 10 * 86_400_000, now)).toBeCloseTo(0.5, 5)
    expect(recencyScore(now - 365 * 86_400_000, now)).toBeLessThan(0.03)
  })

  it('treats a future timestamp as current rather than as negative age', () => {
    const now = 1_800_000_000_000
    expect(recencyScore(now + 86_400_000, now)).toBe(1)
  })

  it('saturates the access signal so one hot memory cannot dominate forever', () => {
    expect(accessScore(0)).toBe(0)
    expect(accessScore(5)).toBe(0.5)
    expect(accessScore(1000)).toBe(1)
  })
})

describe('relevance', () => {
  it('lets the match dominate but breaks a tie on recency', () => {
    const now = 1_800_000_000_000
    const fresh = relevance(0.5, now, 0, now)
    const stale = relevance(0.5, now - 365 * 86_400_000, 0, now)
    expect(fresh).toBeGreaterThan(stale)
    // A far better match still wins against a fresher weak one.
    expect(relevance(0.9, now - 365 * 86_400_000, 0, now)).toBeGreaterThan(fresh)
  })

  it('sums to the weights when every signal is full', () => {
    const now = 1_800_000_000_000
    const { similarity, recency, access } = DEFAULT_RELEVANCE_WEIGHTS
    expect(relevance(1, now, 100, now)).toBeCloseTo(similarity + recency + access, 6)
  })
})

describe('blendSimilarity', () => {
  it('returns the lexical score untouched when the memory has no vector', () => {
    expect(blendSimilarity(0.4, undefined, 0.6)).toBe(0.4)
  })

  it('mixes the two signals by the configured weight', () => {
    expect(blendSimilarity(0.4, 0.9, 0.5)).toBeCloseTo(0.65, 6)
  })

  it('treats an opposing vector as no evidence rather than as evidence against', () => {
    expect(blendSimilarity(0.4, -0.8, 0.5)).toBeCloseTo(0.2, 6)
  })
})
