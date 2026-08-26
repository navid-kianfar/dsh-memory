/**
 * Ranking: how well a memory matches a query, and how that match combines with the memory's age and
 * how often it has been useful before.
 *
 * The lexical half is BM25F — BM25 with per-field weighting — computed here rather than in SQL
 * because the plugin refuses to depend on a DuckDB extension that has to be downloaded on first use.
 * The vector half arrives as a cosine similarity the database computed. Both are normalized to
 * `0`–`1` before they are combined, so a deployment can move the blend without the weights changing
 * meaning.
 *
 * @module @achasoft/dsh-memory/domain/score
 */

import { tokenize } from './text.ts'

/** The searchable fields of a memory, in the order their weights are declared. */
export const LEXICAL_FIELDS = ['title', 'entities', 'tags', 'summary', 'content'] as const

/** One of {@link LEXICAL_FIELDS}. */
export type LexicalField = typeof LEXICAL_FIELDS[number]

/**
 * How much each field contributes to a lexical match.
 *
 * A term in the title or in an extracted entity is evidence the memory is *about* that term; the
 * same term in the body may be an aside. The spread is what makes a search for `DuckDB` rank the
 * decision that names it above the ten memories that mention it in passing.
 */
export const FIELD_WEIGHTS: Readonly<Record<LexicalField, number>> = {
  title: 3,
  entities: 2.5,
  tags: 2,
  summary: 1.5,
  content: 1,
}

/**
 * BM25 term-frequency saturation. The standard value; raising it makes repeated terms count for
 * longer before the curve flattens.
 */
const K1 = 1.2

/**
 * BM25 length normalization. At `0.75` a long memory is discounted for its length but not erased,
 * which matters here because architecture notes are legitimately long.
 */
const B = 0.75

/** The text of one candidate memory, split by field. */
export interface LexicalDocument {
  readonly id: string
  readonly fields: Readonly<Record<LexicalField, string>>
}

/**
 * Corpus-wide facts BM25 needs that a candidate set cannot supply on its own.
 *
 * Field lengths are measured in CHARACTERS, both here and per document. BM25 uses only the ratio of
 * a document's length to the corpus average, and that ratio is the same whether both sides count
 * characters or tokens — so counting characters lets the average come from one cheap SQL aggregate
 * instead of tokenizing every stored memory on every query.
 */
export interface CorpusStats {
  /** Active memories in the project, including those that matched nothing. */
  readonly documentCount: number
  /** Mean character length of each field across those memories; `0` when the corpus is empty. */
  readonly averageLength: Readonly<Record<LexicalField, number>>
}

/** A document's lexical score together with the ceiling it was measured against. */
export interface LexicalScore {
  /** The raw BM25F score; comparable only within one query. */
  readonly raw: number
  /**
   * `raw` divided by the largest score this query could produce, so it lands in `0`–`1` and means
   * "the share of the query's information content this memory matched". Comparable across queries.
   */
  readonly normalized: number
}

/**
 * Inverse document frequency: how much a term narrows the corpus.
 *
 * The `+0.5` terms are the standard Robertson smoothing, and the outer `1 +` keeps the result
 * positive for a term present in every document (which would otherwise score negative and let a
 * common word subtract from a match).
 * @param documentCount - documents in the corpus.
 * @param documentFrequency - documents containing the term.
 * @returns the term's weight; `0` when the corpus is empty.
 */
export function inverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  if (documentCount <= 0) return 0
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

/** A document's tokens per field, plus each field's character length. */
interface PreparedDocument {
  readonly id: string
  readonly counts: ReadonlyMap<string, Readonly<Record<LexicalField, number>>>
  readonly lengths: Readonly<Record<LexicalField, number>>
}

/**
 * Tokenize one candidate's fields once, so a multi-term query does not re-split the same text per
 * term.
 * @param document - the candidate to prepare.
 * @returns per-term field counts and per-field character lengths.
 */
function prepare(document: LexicalDocument): PreparedDocument {
  const counts = new Map<string, Record<LexicalField, number>>()
  const lengths = { title: 0, entities: 0, tags: 0, summary: 0, content: 0 }
  for (const field of LEXICAL_FIELDS) {
    const text = document.fields[field]
    lengths[field] = text.length
    for (const token of tokenize(text)) {
      let entry = counts.get(token)
      if (entry === undefined) {
        entry = { title: 0, entities: 0, tags: 0, summary: 0, content: 0 }
        counts.set(token, entry)
      }
      entry[field] += 1
    }
  }
  return { id: document.id, counts, lengths }
}

/**
 * Score every candidate against one query with BM25F.
 *
 * Document frequency is counted over the candidates, which is exact rather than approximate: a
 * document containing none of the query's terms cannot be in any term's document frequency, and
 * every document that contains one is in the candidate set by construction.
 * @param terms - the query's distinct terms, from `queryTerms`.
 * @param documents - the candidate memories' searchable text.
 * @param stats - corpus size and per-field average lengths.
 * @returns each candidate's score by memory id; a candidate scoring `0` is present with `0`.
 */
export function scoreLexical(
  terms: readonly string[],
  documents: readonly LexicalDocument[],
  stats: CorpusStats,
): Map<string, LexicalScore> {
  const prepared = documents.map(prepare)
  const scores = new Map<string, LexicalScore>()
  if (terms.length === 0) {
    for (const document of prepared) scores.set(document.id, { raw: 0, normalized: 0 })
    return scores
  }

  const idf = new Map<string, number>()
  for (const term of terms) {
    const frequency = prepared.reduce((total, document) => total + (document.counts.has(term) ? 1 : 0), 0)
    idf.set(term, inverseDocumentFrequency(stats.documentCount, frequency))
  }
  // The largest score any document could reach: each term's weight saturates at its own idf, since
  // the BM25 factor `wtf / (K1 + wtf)` approaches 1 as the weighted term frequency grows.
  const ceiling = terms.reduce((total, term) => total + (idf.get(term) ?? 0), 0)

  for (const document of prepared) {
    let raw = 0
    for (const term of terms) {
      const perField = document.counts.get(term)
      if (perField === undefined) continue
      let weighted = 0
      for (const field of LEXICAL_FIELDS) {
        const frequency = perField[field]
        if (frequency === 0) continue
        const average = stats.averageLength[field]
        // With no corpus average (an empty or single-field corpus) length normalization has nothing
        // to normalize against, so the term contributes its unnormalized frequency.
        const normalization = average > 0 ? 1 - B + B * (document.lengths[field] / average) : 1
        weighted += FIELD_WEIGHTS[field] * frequency / normalization
      }
      raw += (idf.get(term) ?? 0) * weighted / (K1 + weighted)
    }
    scores.set(document.id, { raw, normalized: ceiling > 0 ? Math.min(1, raw / ceiling) : 0 })
  }
  return scores
}

/** How the three relevance signals are weighted against each other. */
export interface RelevanceWeights {
  /** Weight of the match itself. */
  readonly similarity: number
  /** Weight of how recently the memory was written or edited. */
  readonly recency: number
  /** Weight of how often the memory has proven useful before. */
  readonly access: number
}

/**
 * The reference blend, carried over from the Claude Memory MCP this plugin reimplements: the match
 * dominates, with recency and frequency breaking ties among comparable matches.
 */
export const DEFAULT_RELEVANCE_WEIGHTS: RelevanceWeights = {
  similarity: 0.7,
  recency: 0.15,
  access: 0.15,
}

/** Milliseconds in a day, for the recency curve. */
const DAY_MS = 86_400_000

/**
 * How fast recency decays: at `0.1` a memory scores half on age alone after ten days and keeps
 * decaying gently rather than falling off a cliff.
 */
const RECENCY_DECAY = 0.1

/** Access count at which the frequency signal saturates. */
const ACCESS_SATURATION = 10

/**
 * Age component of relevance.
 * @param updatedAt - when the memory last changed, epoch milliseconds.
 * @param now - the current time, epoch milliseconds.
 * @returns `1` for a memory touched right now, decaying toward `0`; never negative.
 */
export function recencyScore(updatedAt: number, now: number): number {
  const days = Math.max(0, (now - updatedAt) / DAY_MS)
  return 1 / (1 + days * RECENCY_DECAY)
}

/**
 * Usefulness component of relevance.
 * @param accessCount - how many times the memory has been recalled or returned by a search.
 * @returns `0`–`1`, saturating at {@link ACCESS_SATURATION} accesses.
 */
export function accessScore(accessCount: number): number {
  return Math.min(1, Math.max(0, accessCount) / ACCESS_SATURATION)
}

/**
 * Combine a match with the memory's age and history into the value results are ordered by.
 * @param similarity - the `0`–`1` match strength.
 * @param updatedAt - when the memory last changed, epoch milliseconds.
 * @param accessCount - how many times it has been recalled.
 * @param now - the current time, epoch milliseconds.
 * @param weights - the blend to apply.
 * @returns the ordering score.
 */
export function relevance(
  similarity: number,
  updatedAt: number,
  accessCount: number,
  now: number,
  weights: RelevanceWeights = DEFAULT_RELEVANCE_WEIGHTS,
): number {
  return weights.similarity * similarity
    + weights.recency * recencyScore(updatedAt, now)
    + weights.access * accessScore(accessCount)
}

/**
 * Blend the lexical and vector signals into the single `0`–`1` similarity results are filtered by.
 *
 * A negative cosine means the query and the memory point in opposite directions in the embedding
 * space, which is no evidence of a match rather than evidence against one, so it is floored at zero
 * instead of subtracting from the lexical score.
 * @param lexical - the normalized BM25F score.
 * @param cosine - the stored vector's cosine similarity to the query vector, or undefined when this
 *   memory has no vector or the search ran without one.
 * @param vectorWeight - the vector signal's share, `0`–`1`; ignored when `cosine` is undefined so a
 *   memory that predates embedding is ranked on its lexical score rather than penalised for the gap.
 * @returns the blended similarity.
 */
export function blendSimilarity(lexical: number, cosine: number | undefined, vectorWeight: number): number {
  if (cosine === undefined) return lexical
  const vector = Math.max(0, cosine)
  return (1 - vectorWeight) * lexical + vectorWeight * vector
}
