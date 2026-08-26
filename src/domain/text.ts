/**
 * Text derivations shared by writes and by search: tokenization, the auto-summary, entity
 * extraction, and the token estimate that bounds a budgeted search result.
 *
 * Every function here is pure and synchronous. They run on the write path for each stored memory and
 * on the read path for each query, and they are the only place the plugin decides what a "word" is,
 * so the writer and the searcher cannot drift apart on that answer.
 *
 * @module @achasoft/dsh-memory/domain/text
 */

/**
 * Words carrying no retrieval signal, removed from queries and from indexed text alike.
 *
 * Deliberately short. An aggressive list hurts a small corpus more than it helps: with a few hundred
 * memories, a rare-ish word that a longer list would discard is often the only thing separating two
 * documents, and BM25's inverse document frequency already discounts common words on its own.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'were', 'will', 'with',
])

/** Shortest token kept; single characters match too much to be worth an index entry. */
const MIN_TOKEN_LENGTH = 2

/**
 * Split text into lowercase search tokens.
 *
 * Splitting on anything that is not a letter, digit, or one of `_ . -` keeps identifiers whole:
 * `array_cosine_similarity`, `tsconfig.base.json`, and `dsh-memory` each stay one token, which is
 * what makes a search for a symbol find the memory that names it. Leading and trailing punctuation
 * is then trimmed so a sentence-final `DuckDB.` matches a bare `DuckDB`.
 * @param text - the raw text to tokenize.
 * @returns lowercase tokens in order, without stop words, duplicates preserved.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_.\-]+/u)) {
    const token = raw.replace(/^[._\-]+/, '').replace(/[._\-]+$/, '')
    if (token.length < MIN_TOKEN_LENGTH) continue
    if (STOP_WORDS.has(token)) continue
    tokens.push(token)
  }
  return tokens
}

/**
 * The distinct tokens of a query, in first-appearance order.
 *
 * Repeating a word in a query is emphasis a person rarely means, and BM25 term weights already
 * account for how often a term appears in the DOCUMENT; counting the query repetition too would
 * square that effect.
 * @param query - the raw query text.
 * @returns each distinct token once.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const token of tokenize(query)) {
    if (seen.has(token)) continue
    seen.add(token)
    terms.push(token)
  }
  return terms
}

/** Longest auto-summary in characters; past this a listing row wraps rather than scans. */
const SUMMARY_MAX_CHARS = 200

/** Word count past which the first sentence is cut rather than used whole. */
const SUMMARY_MAX_WORDS = 20

/** Below this many words the first sentence says too little to stand alone without the title. */
const SUMMARY_MIN_WORDS = 5

/**
 * Derive the one-line abstract shown in listings and in budgeted search indexes.
 *
 * The first sentence of the content, cut at {@link SUMMARY_MAX_WORDS}; when that sentence is too
 * short to mean anything by itself the title is prepended rather than the next sentence appended,
 * because a truncated two-sentence summary reads as a mangled quotation while `title: fragment`
 * reads as a label.
 * @param title - the memory's title.
 * @param content - the memory's full text.
 * @returns the summary, never longer than {@link SUMMARY_MAX_CHARS}.
 */
export function summarize(title: string, content: string): string {
  const firstSentence = (content.split(/(?<=[.!?])\s|\n/)[0] ?? '').trim()
  const words = firstSentence.split(/\s+/).filter(word => word.length > 0)
  let summary = words.length <= SUMMARY_MAX_WORDS
    ? firstSentence
    : `${words.slice(0, SUMMARY_MAX_WORDS).join(' ')}…`
  if (words.length < SUMMARY_MIN_WORDS) {
    summary = summary.length === 0 ? title : `${title}: ${summary}`
  }
  return summary.slice(0, SUMMARY_MAX_CHARS)
}

/** Uppercase words that are ordinary English rather than acronyms worth indexing. */
const NON_ACRONYMS: ReadonlySet<string> = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'BUT', 'ARE', 'WAS', 'HAS', 'ALL', 'ANY', 'CAN', 'YOU', 'USE', 'ADD',
])

/** Longest quoted run still treated as a term rather than as a sentence someone quoted. */
const QUOTED_MAX_CHARS = 30

/** How many entities one memory contributes; past this the tail is noise, not signal. */
const MAX_ENTITIES = 40

/**
 * Extract the proper nouns and identifiers a memory is *about*.
 *
 * These are stored alongside the memory and weighted above body text at search time, which is what
 * makes "what did we pick for storage?" rank the memory naming `DuckDB` over one that merely
 * mentions storage. Recognised: CamelCase names, acronyms, `@mentions`, `#tags`, short quoted terms,
 * and dotted or hyphenated identifiers such as `array_cosine_similarity` or `tsconfig.base.json`.
 * @param text - the text to scan. Callers join a title and a body as separate SENTENCES (`title.
 *   body`): joined by a bare space, the body's first word reads as mid-sentence and earns the
 *   proper-noun boost that only a genuine mid-sentence capital should.
 * @returns the distinct entities, sorted, capped at {@link MAX_ENTITIES}.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>()
  const add = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed.length >= MIN_TOKEN_LENGTH) found.add(trimmed)
  }
  // Internally capitalised names: at least one lowercase letter and at least two capitals, which is
  // what separates `DuckDB`, `PostgreSQL`, and `FastMCP` from an ordinary sentence-initial word. A
  // pattern demanding `[A-Z][a-z]+` per segment misses every name ending in a capitalised run, which
  // is most of them.
  for (const match of text.matchAll(
    /\b(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z][A-Za-z0-9]*[A-Z])[A-Z][A-Za-z0-9]{2,}\b/g,
  )) add(match[0])
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)) {
    if (!NON_ACRONYMS.has(match[0])) add(match[0])
  }
  // A plainly capitalised word is a proper noun only when something else precedes it in the same
  // sentence; at a sentence start the capital says nothing. Following a lowercase word is the signal,
  // and it is what catches the single-word product names — `Docker`, `Redis` — that no casing rule
  // can distinguish on their own.
  for (const match of text.matchAll(/[a-z0-9,)]\s+([A-Z][a-z][A-Za-z0-9]+)\b/g)) add(match[1] ?? '')
  for (const match of text.matchAll(/@[\w-]+/g)) add(match[0])
  for (const match of text.matchAll(/#[\w-]+/g)) add(match[0])
  for (const match of text.matchAll(/"([^"\n]{2,30})"/g)) add(match[1] ?? '')
  for (const match of text.matchAll(/`([^`\n]{2,30})`/g)) add(match[1] ?? '')
  // Dotted or snake/kebab identifiers: at least one separator, and letters on both sides of it, so
  // `end.` and `3.14` are excluded while `node:sqlite` style names survive tokenization elsewhere.
  for (const match of text.matchAll(/\b[a-zA-Z][\w]*(?:[._-][a-zA-Z][\w]*)+\b/g)) {
    if (match[0].length <= QUOTED_MAX_CHARS) add(match[0])
  }
  return [...found].sort().slice(0, MAX_ENTITIES)
}

/**
 * Estimate how many model tokens a string costs.
 *
 * Four characters per token is the usual English approximation, and it is used here only to decide
 * how many search hits fit a caller's budget. The estimate is deliberately not a real tokenizer:
 * being approximately right costs nothing here, while shipping a tokenizer would tie the plugin to
 * one model family's vocabulary.
 * @param text - the text to measure.
 * @returns at least 1 for any non-empty input.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Derive a project slug from its directory path.
 *
 * The slug names the project in injected prompt text and in the UI header. It is derived rather than
 * stored so that moving or renaming a checkout does not leave the memory claiming the old name.
 * @param projectRoot - absolute path of the project directory.
 * @returns a lowercase `[a-z0-9-]` slug, or `project` when the path yields nothing usable.
 */
export function projectSlug(projectRoot: string): string {
  const base = projectRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length === 0 ? 'project' : slug
}

/**
 * The text a memory is embedded from.
 *
 * Title and content together, because a title alone is too short to place in vector space and
 * content alone loses the framing that makes two similar bodies distinguishable.
 * @param title - the memory's title.
 * @param content - the memory's full text.
 * @returns the combined text handed to the embedding provider.
 */
export function embeddingText(title: string, content: string): string {
  return `${title}\n${content}`
}
