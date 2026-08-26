/**
 * `@achasoft/dsh-memory` root entry — two roles in one module, because the client module system
 * requires them together.
 *
 * **As a plugin**, this is the memory manager's node half. The apply is empty: the browser half
 * ships via `exports["./client"]` and is discovered through the package's `dsh.client` declaration.
 * That discovery resolves `<loader row name>/package.json`, so the row naming this plugin must be
 * the BARE package name — a subpath row (`.../host`) resolves nothing and the browser half is
 * silently never served.
 *
 * **As a library**, it re-exports the embedding capability's Service Definition and the memory
 * vocabulary, so a third-party provider can implement `ctx.memoryEmbedding` against these types
 * without depending on the Host endpoint or the browser surface.
 *
 * @module @achasoft/dsh-memory
 */

export * from './embedding/index.ts'
export type * from './domain/types.ts'
export {
  DEFAULT_RELEVANCE_WEIGHTS, FIELD_WEIGHTS, LEXICAL_FIELDS, blendSimilarity, relevance, scoreLexical,
} from './domain/score.ts'
export { DEFAULT_RETENTION_DAYS, expiresAt } from './domain/retention.ts'
export { renderRules, renderSessionContext, renderSessionEndReminder } from './domain/rules.ts'
export {
  MemoryInputError, MemoryNotFoundError, parseCreate, parseListQuery, parseSearchQuery, parseUpdate,
} from './domain/validate.ts'
export {
  embeddingText, estimateTokens, extractEntities, projectSlug, queryTerms, summarize, tokenize,
} from './domain/text.ts'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
