/**
 * Embedding provider for any endpoint speaking OpenAI's `/v1/embeddings` request and response. One
 * request shape reaches hosted APIs, self-hosted inference servers, and local runtimes alike, so
 * "use a cloud model" and "run a model on this machine" are the same provider with a different
 * `baseUrl`.
 *
 * The API key is addressed by reference, never stored: `apiKeyEnv` names an environment variable and
 * the value is resolved from `ctx.credentials` at the start of every call, so a rotated key reaches
 * the next request with no restart. Omitting `apiKeyEnv` targets a local server that wants no
 * authorization at all.
 *
 * @module @achasoft/dsh-memory/providers/openai-embeddings
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import { EmbeddingEngine, EmbeddingError, type EmbeddingProviderInfo } from '../embedding/index.ts'

/** Provider identity reported by `describe()`; equal to this package's plugin name. */
const PROVIDER_NAME = 'memory-embeddings-openai'

/** Deployment configuration for one OpenAI-compatible embeddings endpoint. */
export interface Config {
  /**
   * Origin and path prefix of the endpoint, without the `/embeddings` suffix — for example
   * `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1`. A trailing slash is normalized away.
   */
  baseUrl: string
  /** Embedding model the endpoint should use, such as `text-embedding-3-small`. */
  model: string
  /**
   * Environment-variable name holding the bearer token. Omit it for a local server that requires no
   * authorization; a named-but-empty variable reads as unconfigured rather than as an empty key.
   */
  apiKeyEnv?: string
  /** Deadline for one request, measured from dispatch through the response body. */
  timeoutMs: number
  /**
   * Vector length to request, for endpoints that support shortening (OpenAI's `dimensions`).
   *
   * Shorter vectors cost less to store and compare at some loss of fidelity. Omit it to accept the
   * model's native length. Changing it strands every vector already stored at the old length —
   * they are excluded from comparison, and re-embedding is what restores them.
   */
  dimensions?: number
  /** Texts sent in one request. Endpoints differ in what they accept, so this is a deployment choice. */
  batchSize: number
}

/**
 * Strip one trailing slash so `${baseUrl}/embeddings` never doubles it.
 * @param baseUrl - the configured endpoint prefix.
 * @returns the prefix without a trailing slash.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

/**
 * Read the endpoint's error body without letting a second failure mask the first.
 * @param response - the non-OK response.
 * @returns a bounded diagnostic string, empty when the body cannot be read.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512)
  } catch {
    // A body that cannot be read adds nothing to the status the caller already has, and letting this
    // throw would replace a classified provider-rejected failure with a stream error.
    return ''
  }
}

/**
 * Classify an HTTP failure by status.
 * @param status - the response status.
 * @param body - the bounded error body, included in the diagnostic.
 * @returns the classified failure to throw.
 */
function classifyHttpFailure(status: number, body: string): EmbeddingError {
  const detail = body.length === 0 ? '' : `: ${body}`
  if (status === 401 || status === 403) {
    return new EmbeddingError('not-configured', `embeddings endpoint rejected the credential (${status})${detail}`)
  }
  if (status === 408 || status === 504) {
    return new EmbeddingError('provider-timeout', `embeddings endpoint timed out (${status})${detail}`)
  }
  if (status >= 500) {
    return new EmbeddingError('provider-unavailable', `embeddings endpoint failed (${status})${detail}`)
  }
  return new EmbeddingError('provider-rejected', `embeddings endpoint rejected the request (${status})${detail}`)
}

/**
 * Classify a transport-level failure. A caller-initiated abort is rethrown unchanged so cancellation
 * never reads as an outage; the deadline is reported separately from an unreachable endpoint.
 * @param error - the rejection fetch produced.
 * @param signal - the caller's cancellation signal.
 * @param timedOut - whether this provider's own deadline fired.
 * @returns never; always throws.
 */
function throwTransportFailure(error: unknown, signal: AbortSignal, timedOut: boolean): never {
  if (signal.aborted) throw signal.reason
  if (timedOut) throw new EmbeddingError('provider-timeout', 'embeddings endpoint did not answer in time', { cause: error })
  throw new EmbeddingError('provider-unavailable', 'embeddings endpoint is unreachable', { cause: error })
}

/**
 * Read the vectors out of an OpenAI-shaped embeddings response.
 *
 * The `index` field is honoured rather than assumed: the specification permits a server to return
 * data out of order, and a silently transposed batch would attach every memory's vector to the wrong
 * memory — a corruption no later check could detect.
 * @param payload - the parsed response body.
 * @param expected - how many inputs were sent.
 * @returns the vectors in input order.
 * @throws EmbeddingError when the body is not the documented shape or is missing an input's vector.
 */
export function parseEmbeddingsBody(payload: unknown, expected: number): number[][] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new EmbeddingError('malformed-response', 'embeddings response has no `data` array')
  }
  const data = (payload as { data: unknown }).data
  if (!Array.isArray(data)) {
    throw new EmbeddingError('malformed-response', 'embeddings response `data` is not an array')
  }
  const vectors = new Array<number[] | undefined>(expected)
  data.forEach((entry: unknown, position: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new EmbeddingError('malformed-response', 'embeddings response contains a non-object entry')
    }
    const record = entry as { embedding?: unknown, index?: unknown }
    if (!Array.isArray(record.embedding) || record.embedding.some(value => typeof value !== 'number')) {
      throw new EmbeddingError('malformed-response', 'embeddings response entry has no numeric `embedding`')
    }
    const index = typeof record.index === 'number' ? record.index : position
    if (index < 0 || index >= expected) {
      throw new EmbeddingError('malformed-response', `embeddings response indexed input ${index}, which was not sent`)
    }
    vectors[index] = record.embedding as number[]
  })
  const missing = vectors.findIndex(vector => vector === undefined)
  if (missing >= 0) {
    throw new EmbeddingError('malformed-response', `embeddings response omitted input ${missing}`)
  }
  return vectors as number[][]
}

/** Embeddings over an OpenAI-compatible HTTP endpoint. */
export class OpenAiCompatibleEmbeddings extends EmbeddingEngine {
  static inject = ['credentials']

  /** Loader validation for the endpoint, model, credential reference, deadline, and batching. */
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
    model: z.string().required(),
    apiKeyEnv: z.string(),
    timeoutMs: z.number().step(1).min(1).required(),
    dimensions: z.number().step(1).min(1),
    batchSize: z.number().step(1).min(1).required(),
  })

  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly batchSize: number
  private readonly dimensions?: number
  private readonly apiKeyRef?: CredentialRef

  /**
   * @param ctx - registrant context carrying the credential seam.
   * @param config - the validated endpoint, model, credential reference, deadline, and batching.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.baseUrl = normalizeBaseUrl(config.baseUrl)
    this.model = config.model
    this.timeoutMs = config.timeoutMs
    this.batchSize = config.batchSize
    if (config.dimensions !== undefined) this.dimensions = config.dimensions
    if (config.apiKeyEnv !== undefined) this.apiKeyRef = credentialRef(config.apiKeyEnv)
  }

  /**
   * Report identity and whether the configured credential currently resolves.
   * @returns the provider's identity, model, requested dimensions, and readiness.
   */
  async describe(): Promise<EmbeddingProviderInfo> {
    const base = {
      provider: PROVIDER_NAME,
      model: this.model,
      ...this.dimensions === undefined ? {} : { dimensions: this.dimensions },
    }
    if (this.apiKeyRef === undefined) return { ...base, ready: true }
    const info = await this.ctx.credentials.describe(this.apiKeyRef)
    return info.configured
      ? { ...base, ready: true }
      : { ...base, ready: false, detail: `no value for ${this.apiKeyRef}` }
  }

  /**
   * Embed a batch, splitting it across as many requests as the configured batch size requires.
   * @param texts - the texts to embed, in order.
   * @param signal - caller-owned cancellation.
   * @returns one vector per input, in the same order.
   */
  async embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) throw new EmbeddingError('empty-input', 'no texts to embed')
    const authorization = await this.authorization()
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const chunk = texts.slice(start, start + this.batchSize)
      vectors.push(...await this.request(chunk, authorization, signal))
    }
    return vectors
  }

  /**
   * Resolve the bearer header for this call, if the deployment configured one.
   * @returns the header value, or undefined when the endpoint takes no authorization.
   * @throws EmbeddingError when a credential is named but has no value.
   */
  private async authorization(): Promise<string | undefined> {
    if (this.apiKeyRef === undefined) return undefined
    const hit = await this.ctx.credentials.resolve(this.apiKeyRef)
    if (hit === undefined) throw new EmbeddingError('not-configured', `no value for ${this.apiKeyRef}`)
    return `Bearer ${hit.value}`
  }

  /**
   * Post one chunk and read its vectors.
   * @param texts - the chunk, already within the batch size.
   * @param authorization - the resolved bearer header, or undefined.
   * @param signal - caller-owned cancellation.
   * @returns the chunk's vectors in input order.
   */
  private async request(
    texts: readonly string[], authorization: string | undefined, signal: AbortSignal,
  ): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (authorization !== undefined) headers['authorization'] = authorization

    const timeout = AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          input: texts,
          ...this.dimensions === undefined ? {} : { dimensions: this.dimensions },
        }),
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      throwTransportFailure(error, signal, timeout.aborted)
    }

    if (!response.ok) throw classifyHttpFailure(response.status, await readErrorBody(response))

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new EmbeddingError('malformed-response', 'endpoint returned a non-JSON body', { cause: error })
    }
    return parseEmbeddingsBody(payload, texts.length)
  }
}

export default OpenAiCompatibleEmbeddings
