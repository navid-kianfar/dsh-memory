/**
 * Text-embedding Service Definition. `ctx.memoryEmbedding` defines WHAT embedding does — turn text
 * into a vector that can be compared with other vectors — without saying HOW; a provider plugin
 * supplies the mechanism.
 *
 * The capability is optional by design. With no provider mounted the plugin ranks memories
 * lexically and every feature still works, so semantic recall is an upgrade a deployment opts into
 * rather than a credential it must supply before the plugin does anything at all.
 *
 * @module @achasoft/dsh-memory/embedding
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryEmbedding: EmbeddingEngine
  }
}

/**
 * Stable failure classes every provider maps its own vocabulary onto. Consumers switch on `code`
 * rather than parsing messages, so a provider swap cannot change how a caller reacts.
 *
 * `not-configured` is the class a UI must distinguish: the deployment mounted a provider that still
 * lacks a credential, endpoint, or model, so the fix is configuration rather than a retry.
 */
export type EmbeddingErrorCode =
  | 'empty-input'
  | 'not-configured'
  | 'provider-unavailable'
  | 'provider-rejected'
  | 'provider-timeout'
  | 'malformed-response'

/** One classified embedding failure. */
export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError'

  /**
   * @param code - stable failure class the caller switches on.
   * @param message - provider diagnostic retained as the Error message.
   * @param options - standard Error options, carrying the provider cause when one exists.
   */
  constructor(readonly code: EmbeddingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Narrow an unknown rejection to this capability's classified failure.
 * @param value - the caught value.
 * @returns whether the value is an {@link EmbeddingError}.
 */
export function isEmbeddingError(value: unknown): value is EmbeddingError {
  return value instanceof EmbeddingError
}

/** What a provider is and whether it can run right now. */
export interface EmbeddingProviderInfo {
  /** Plugin-level identity, such as `memory-embeddings-openai`. */
  readonly provider: string
  /** The embedding model in use, when the provider names one. */
  readonly model?: string
  /** Whether a call would be attempted; false means configuration is missing. */
  readonly ready: boolean
  /** Why it is not ready, in words a person can act on. Never contains a secret. */
  readonly detail?: string
  /**
   * Vector length this provider emits, when it is known without a call.
   *
   * Stored vectors of a different length are excluded from comparison rather than compared, so a
   * surface that knows the dimension can tell the user how many memories a model change stranded.
   */
  readonly dimensions?: number
}

/**
 * The embedding capability's Service Definition.
 *
 * A provider extends this class and registers itself as `ctx.memoryEmbedding`. Exactly one provider
 * is mounted at a time — the Cordis service key is the arbiter, so a composition that mounts two
 * fails loudly at load rather than silently preferring one.
 */
export abstract class EmbeddingEngine extends Service {
  /**
   * Bind the provider to the capability's service key.
   * @param ctx - registrant context the provider was applied to.
   */
  constructor(ctx: Context) {
    super(ctx, 'memoryEmbedding')
  }

  /**
   * Embed one batch of texts.
   *
   * Batched rather than single because every remote endpoint charges per request and a backfill
   * embeds hundreds of memories. Implementations reject with {@link EmbeddingError}; every other
   * rejection is a defect.
   * @param texts - the texts to embed, in order; an empty batch is a caller error.
   * @param signal - caller-owned cancellation; implementations abandon in-flight work when it fires.
   * @returns one vector per input, in the same order and all of the same length.
   */
  abstract embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>

  /**
   * Report what this provider is and whether it can run right now.
   *
   * Configuration surfaces call this to tell "no provider mounted" apart from "mounted but missing a
   * key", without spending a request. It reports readiness, never a secret.
   * @returns the provider's identity and current readiness.
   */
  abstract describe(): Promise<EmbeddingProviderInfo>
}
