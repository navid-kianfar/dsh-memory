/**
 * The emitted RPC contract, checked against the two things that can invalidate it: the harness's own
 * manifest validation, and the payloads the Host actually sends.
 *
 * The artifact is emitted by this repository's own `scripts/build-typert.mjs` rather than by the
 * harness generator, so nothing outside this file proves it is a manifest the harness would accept.
 * `validateTypertManifest` is the same function the loader runs at mount time; running it here means
 * a malformed artifact fails in a test rather than at a user's first request.
 */
import { describe, expect, it } from 'vitest'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import type { InvocationDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { ZodType } from 'zod'
import { TYPERT } from '../generated/typert.host.js'
import { TYPERT_REMOTE } from '../generated/typert.remote-client.js'
import type {
  MemoryListResult, MemoryOverviewResult, MemorySearchRequest, MemorySearchResult, MemoryView,
  MemoryWriteResult,
} from '../src/host/types.ts'

/** The descriptor set the browser mounts, typed as the protocol declares it. */
const descriptors = (TYPERT_REMOTE as { descriptors: readonly InvocationDescriptor[] }).descriptors

/**
 * Narrow a codec to its strict half and hand back the schema.
 *
 * `TypertCodec` is a union: a strict codec carries a zod schema, and a `src-json` codec carries
 * none. Every codec this package emits is strict — the loader requires it — so a codec without a
 * schema here is a defect in the emitter rather than a case to handle.
 * @param codec - the descriptor's parameter or result codec.
 * @returns the codec's schema.
 */
function schemaOf(codec: TypertCodec): ZodType {
  if (!('schema' in codec)) throw new Error('expected a strict codec carrying a schema')
  return codec.schema as ZodType
}

/**
 * Find one endpoint's descriptor.
 * @param method - the endpoint's method name.
 * @returns the descriptor.
 */
function descriptor(method: string): InvocationDescriptor {
  const found = descriptors.find(entry => entry.method === method)
  if (found === undefined) throw new Error(`no descriptor for "${method}"`)
  return found
}

/** A memory as the Host projects it, for round-tripping result schemas. */
const MEMORY: MemoryView = {
  id: '3f1c6f6e-2b1a-4a5d-9b0e-0f1a2b3c4d5e',
  category: 'decision',
  title: 'Storage engine',
  content: 'We chose DuckDB because the memory is queried by hand.',
  summary: 'We chose DuckDB because the memory is queried by hand.',
  tags: ['storage'],
  entities: ['DuckDB'],
  relatedIds: [],
  status: 'active',
  priority: 0,
  source: 'assistant',
  accessCount: 3,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
  embedded: true,
}

describe('the host manifest', () => {
  it('is a manifest the harness loader accepts', () => {
    expect(() => validateTypertManifest('@achasoft/dsh-memory', TYPERT)).not.toThrow()
  })

  it('rejects a manifest claiming another package, which is what the loader guards', () => {
    expect(() => validateTypertManifest('@achasoft/dsh-other', TYPERT)).toThrow(/must be owned by/)
  })

  it('documents every endpoint it declares', () => {
    const model = (TYPERT as { model: { services: readonly { members: readonly { name: string, summary?: string }[] }[] } }).model
    const members = model.services.flatMap(service => service.members)
    expect(members.map(member => member.name).sort())
      .toEqual(descriptors.map(entry => entry.method).sort())
    for (const member of members) {
      expect(member.summary, `${member.name} has no summary`).toBeTruthy()
    }
  })
})

describe('the descriptor set', () => {
  it('mounts every endpoint under one namespace and one service', () => {
    for (const entry of descriptors) {
      expect(entry.service).toBe('memory')
      expect(entry.namespace).toBe('memory')
      expect(entry.invocation).toEqual({ kind: 'direct' })
      expect(entry.id).toBe(`@achasoft/dsh-memory#memory/${entry.method}`)
    }
  })

  it('gives every endpoint exactly one JSON request parameter', () => {
    for (const entry of descriptors) {
      expect(entry.parameters).toHaveLength(1)
      expect(entry.parameters[0]?.wire).toBe('request')
      expect(entry.parameters[0]?.source).toBe('json')
    }
  })

  it('names no endpoint after a member of the browser\'s namespace service', () => {
    // The Web Client exposes each namespace as a Cordis service object and installs every endpoint
    // as a property on it, so an endpoint sharing a name with one of that service's own members is
    // refused at mount time — which takes the WHOLE plugin down, not just that call. The list is
    // `REMOTE_NAMESPACE_FIELDS` plus the namespace service's own methods (dsh-api-gateway).
    const reserved = new Set([
      'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
      'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
      'constructor', 'toString', 'valueOf',
    ])
    for (const entry of descriptors) {
      expect(reserved.has(entry.method), `"${entry.method}" is a reserved namespace member`).toBe(false)
    }
  })

  it('reserves transport cancellation for the one endpoint that can outlive its caller', () => {
    expect(descriptor('search').cancellation).toEqual({ parameter: 'signal' })
    for (const entry of descriptors.filter(candidate => candidate.method !== 'search')) {
      expect(entry.cancellation, `${entry.method} declares cancellation`).toBeUndefined()
    }
  })
})

describe('request schemas', () => {
  it('accepts a search naming only its query', () => {
    const request: MemorySearchRequest = { query: 'why duckdb' }
    expect(schemaOf(descriptor('search').parameters[0]!.codec).parse(request)).toEqual(request)
  })

  it('accepts a search naming every option', () => {
    const request: MemorySearchRequest = {
      project: '/tmp/app', query: 'why duckdb', category: 'decision',
      tags: ['storage'], limit: 5, minSimilarity: 0.2,
    }
    expect(schemaOf(descriptor('search').parameters[0]!.codec).parse(request)).toEqual(request)
  })

  it('rejects a category the Host does not have', () => {
    expect(() => schemaOf(descriptor('search').parameters[0]!.codec).parse({ query: 'x', category: 'notes' }))
      .toThrow()
  })

  it('rejects a create missing its content', () => {
    expect(() => schemaOf(descriptor('create').parameters[0]!.codec).parse({ category: 'decision', title: 'A' }))
      .toThrow()
  })

  it('requires the removal to say whether it is permanent', () => {
    expect(() => schemaOf(descriptor('discard').parameters[0]!.codec).parse({ id: 'a' })).toThrow()
    expect(schemaOf(descriptor('discard').parameters[0]!.codec).parse({ id: 'a', hard: false }))
      .toEqual({ id: 'a', hard: false })
  })

  it('accepts `all` as a listing status alongside the real ones', () => {
    const schema = schemaOf(descriptor('list').parameters[0]!.codec)
    expect(schema.parse({ status: 'all' })).toEqual({ status: 'all' })
    expect(schema.parse({ status: 'archived' })).toEqual({ status: 'archived' })
    expect(() => schema.parse({ status: 'deleted' })).toThrow()
  })
})

describe('result schemas', () => {
  it('round-trips a successful overview', () => {
    const value: MemoryOverviewResult = {
      ok: true,
      overview: {
        project: 'app',
        projectRoot: '/tmp/app',
        databasePath: '/tmp/app/.dsh/memory.db',
        stats: {
          total: 4, active: 3, archived: 1, expired: 0, embedded: 2,
          byCategory: [{ category: 'decision', count: 2 }, { category: 'mandatory_rules', count: 1 }],
        },
        embedding: { available: true, provider: 'memory-embeddings-openai', model: 'text-embedding-3-small', ready: true },
        mandatory: [MEMORY],
        forbidden: [],
        rulesBlock: 'Binding rules for project "app".',
        enforcing: true,
      },
    }
    expect(schemaOf(descriptor('describe').result).parse(value)).toEqual(value)
  })

  it('carries the toolset in force when a tools row reports one', () => {
    const value: MemoryOverviewResult = {
      ok: true,
      overview: {
        project: 'app',
        projectRoot: '/tmp/app',
        databasePath: '/tmp/app/.dsh/memory.db',
        stats: { total: 0, active: 0, archived: 0, expired: 0, embedded: 0, byCategory: [] },
        embedding: { available: false, provider: 'none', ready: false },
        mandatory: [],
        forbidden: [],
        rulesBlock: '',
        enforcing: true,
        toolset: 'full',
      },
    }
    const schema = schemaOf(descriptor('describe').result)
    expect(schema.parse(value)).toEqual(value)
    expect(() => schema.parse({ ...value, overview: { ...value.overview, toolset: 'everything' } })).toThrow()
  })

  it('round-trips a failure, which every endpoint may answer with', () => {
    const value = { ok: false, code: 'not-found', message: 'no memory with id "x"' }
    for (const entry of descriptors) {
      expect(schemaOf(entry.result).parse(value), `${entry.method} rejects a failure`).toEqual(value)
    }
  })

  it('rejects a failure carrying a class the browser cannot branch on', () => {
    expect(() => schemaOf(descriptor('describe').result).parse({ ok: false, code: 'oops', message: 'x' }))
      .toThrow()
  })

  it('round-trips a memory carrying its optional fields, and one carrying none', () => {
    const bare: MemoryWriteResult = { ok: true, memory: MEMORY, rulesChanged: false }
    expect(schemaOf(descriptor('create').result).parse(bare)).toEqual(bare)

    const full: MemoryWriteResult = {
      ok: true,
      memory: { ...MEMORY, metadataJson: '{"ticket":"DSH-1"}', expiresAt: 1_900_000_000_000 },
      rulesChanged: true,
    }
    expect(schemaOf(descriptor('update').result).parse(full)).toEqual(full)
  })

  it('round-trips an empty page and a full one', () => {
    const empty: MemoryListResult = { ok: true, memories: [], total: 0, limit: 50, offset: 0 }
    expect(schemaOf(descriptor('list').result).parse(empty)).toEqual(empty)

    const page: MemoryListResult = { ok: true, memories: [MEMORY], total: 1, limit: 50, offset: 0 }
    expect(schemaOf(descriptor('list').result).parse(page)).toEqual(page)
  })

  it('round-trips ranked hits with their matched signals', () => {
    const value: MemorySearchResult = {
      ok: true,
      query: 'why duckdb',
      total: 1,
      semantic: true,
      hits: [{ memory: MEMORY, similarity: 0.82, relevance: 0.71, matched: ['lexical', 'vector'] }],
    }
    expect(schemaOf(descriptor('search').result).parse(value)).toEqual(value)
  })

  it('rejects a hit missing the score the manager renders', () => {
    expect(() => schemaOf(descriptor('search').result).parse({
      ok: true, query: 'x', total: 1, semantic: false,
      hits: [{ memory: MEMORY, similarity: 0.5, matched: [] }],
    })).toThrow()
  })

  it('round-trips sessions, provenance, import, export, and reembed', () => {
    expect(schemaOf(descriptor('sessions').result).parse({
      ok: true,
      sessions: [{ id: 's1', startedAt: 1, endedAt: 2, summary: 'done', memoriesCreated: 1, memoriesAccessed: 2 }],
    })).toBeTruthy()
    expect(schemaOf(descriptor('provenance').result).parse({
      ok: true,
      entries: [{ seq: 1, memoryId: 'm', operation: 'create', actor: 'agent', at: 1, detailsJson: '{}' }],
    })).toBeTruthy()
    expect(schemaOf(descriptor('importInstructions').result).parse({
      ok: true, imported: 2, rules: 1, memories: [MEMORY],
    })).toBeTruthy()
    expect(schemaOf(descriptor('exportAll').result).parse({ ok: true, json: '{}', count: 0 })).toBeTruthy()
    expect(schemaOf(descriptor('reembed').result).parse({ ok: true, embedded: 3, remaining: 0 })).toBeTruthy()
  })
})
