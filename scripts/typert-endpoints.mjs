/**
 * The Remote contract of `@achasoft/dsh-memory`, declared once.
 *
 * The harness's own Typert generator only runs inside a deepseek-harness checkout, and running it
 * stages sources into that tree, edits three of its tsconfigs, and reinstalls its lockfile. For a
 * package that lives outside that repository the cost is not the minutes — it is that regenerating
 * a contract requires mutating somebody else's working copy.
 *
 * So the contract is declared here instead, in the exact artifact vocabulary
 * `@deepseek-ai/dsh-typert-protocol` documents (`InvocationDescriptor`, `TypertCodec`,
 * `TypertContribution`), and `build-typert.mjs` emits both faces from it. Two gates keep it honest:
 * `check-typert.mjs` fails when `src/host/index.ts` declares an endpoint this table does not, and
 * `tests/typert.spec.ts` runs real payloads through every emitted schema.
 *
 * Each schema is emitted as SOURCE TEXT rather than built here, because the artifact must be a
 * standalone module the Web Client can load without importing this script.
 */

/** The package that owns these Remote methods. */
export const PACKAGE = '@achasoft/dsh-memory'

/** The Cordis service key, and the wire namespace the browser reaches it under. */
export const SERVICE = 'memory'

/** Where the declared `@Remote` methods live, for the source locations the artifact carries. */
export const SOURCE_FILE = 'src/host/index.ts'

/** The failure half every endpoint's result union carries. */
const FAILURE = `z.object({
  'ok': z.literal(false).readonly(),
  'code': z.union([z.literal("invalid"), z.literal("not-found"), z.literal("unavailable")]).readonly(),
  'message': z.string().readonly(),
})`

/** Every memory category, as the wire spells it. */
const CATEGORY = `z.union([z.literal("decision"), z.literal("architecture"), z.literal("devops"), z.literal("feedback"), z.literal("reference"), z.literal("sprint"), z.literal("project_plan"), z.literal("developer_docs"), z.literal("session"), z.literal("mandatory_rules"), z.literal("forbidden_rules")])`

/** Every lifecycle status, as the wire spells it. */
const STATUS = `z.union([z.literal("active"), z.literal("archived"), z.literal("expired")])`

/** One stored memory. */
const MEMORY = `z.object({
  'id': z.string().readonly(),
  'category': ${CATEGORY}.readonly(),
  'title': z.string().readonly(),
  'content': z.string().readonly(),
  'summary': z.string().readonly(),
  'tags': z.array(z.string()).readonly(),
  'entities': z.array(z.string()).readonly(),
  'relatedIds': z.array(z.string()).readonly(),
  'metadataJson': z.string().readonly().optional(),
  'status': ${STATUS}.readonly(),
  'priority': z.number().readonly(),
  'source': z.string().readonly(),
  'accessCount': z.number().readonly(),
  'expiresAt': z.number().readonly().optional(),
  'createdAt': z.number().readonly(),
  'updatedAt': z.number().readonly(),
  'embedded': z.boolean().readonly(),
})`

/** Per-category active counts. */
const CATEGORY_COUNT = `z.object({
  'category': ${CATEGORY}.readonly(),
  'count': z.number().readonly(),
})`

/** What the project holds. */
const STATS = `z.object({
  'total': z.number().readonly(),
  'active': z.number().readonly(),
  'archived': z.number().readonly(),
  'expired': z.number().readonly(),
  'embedded': z.number().readonly(),
  'byCategory': z.array(${CATEGORY_COUNT}).readonly(),
})`

/** Whether semantic ranking is available. */
const EMBEDDING = `z.object({
  'available': z.boolean().readonly(),
  'provider': z.string().readonly().optional(),
  'model': z.string().readonly().optional(),
  'ready': z.boolean().readonly(),
  'detail': z.string().readonly().optional(),
})`

/** The manager's header data. */
const OVERVIEW = `z.object({
  'project': z.string().readonly(),
  'projectRoot': z.string().readonly(),
  'databasePath': z.string().readonly(),
  'stats': ${STATS}.readonly(),
  'embedding': ${EMBEDDING}.readonly(),
  'mandatory': z.array(${MEMORY}).readonly(),
  'forbidden': z.array(${MEMORY}).readonly(),
  'rulesBlock': z.string().readonly(),
  'enforcing': z.boolean().readonly(),
  'toolset': z.union([z.literal("core"), z.literal("full")]).readonly().optional(),
})`

/** One ranked hit. */
const HIT = `z.object({
  'memory': ${MEMORY}.readonly(),
  'similarity': z.number().readonly(),
  'relevance': z.number().readonly(),
  'matched': z.array(z.string()).readonly(),
})`

/** One session record. */
const SESSION = `z.object({
  'id': z.string().readonly(),
  'startedAt': z.number().readonly(),
  'endedAt': z.number().readonly().optional(),
  'summary': z.string().readonly().optional(),
  'memoriesCreated': z.number().readonly(),
  'memoriesAccessed': z.number().readonly(),
})`

/** One audit entry. */
const PROVENANCE = `z.object({
  'seq': z.number().readonly(),
  'memoryId': z.string().readonly(),
  'operation': z.string().readonly(),
  'actor': z.string().readonly(),
  'at': z.number().readonly(),
  'detailsJson': z.string().readonly().optional(),
})`

/** Naming only a project. */
const PROJECT_REQUEST = `z.object({
  'project': z.string().readonly().optional(),
})`

/**
 * Build a result union: the success half plus the shared failure half.
 * @param success - source text of the success object's own fields, without the `ok` discriminant.
 * @returns the union's source text.
 */
function result(success) {
  return `z.union([z.object({
  'ok': z.literal(true).readonly(),
${success}
}), ${FAILURE}])`
}

/**
 * Every Remote endpoint, in the order `src/host/index.ts` declares them.
 *
 * `typeSymbol` names the TypeScript type the codec was written from. It reaches diagnostics only,
 * but keeping it accurate is what makes a mismatch between this table and `src/host/types.ts`
 * findable when one is eventually reported.
 */
export const ENDPOINTS = [
  {
    method: 'describe',
    line: 425,
    parameters: [{ name: 'request', typeSymbol: 'MemoryProjectRequest', schema: PROJECT_REQUEST }],
    result: { typeSymbol: 'MemoryOverviewResult', schema: result(`  'overview': ${OVERVIEW}.readonly(),`) },
  },
  {
    method: 'list',
    line: 476,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryListRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'status': z.union([${STATUS}, z.literal("all")]).readonly().optional(),
  'category': ${CATEGORY}.readonly().optional(),
  'tags': z.array(z.string()).readonly().optional(),
  'text': z.string().readonly().optional(),
  'limit': z.number().readonly().optional(),
  'offset': z.number().readonly().optional(),
  'sortBy': z.union([z.literal("updatedAt"), z.literal("createdAt"), z.literal("title"), z.literal("priority"), z.literal("accessCount"), z.literal("category")]).readonly().optional(),
  'sortOrder': z.union([z.literal("asc"), z.literal("desc")]).readonly().optional(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryListResult',
      schema: result(`  'memories': z.array(${MEMORY}).readonly(),
  'total': z.number().readonly(),
  'limit': z.number().readonly(),
  'offset': z.number().readonly(),`),
    },
  },
  {
    method: 'search',
    line: 505,
    cancellation: true,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemorySearchRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'query': z.string().readonly(),
  'category': ${CATEGORY}.readonly().optional(),
  'tags': z.array(z.string()).readonly().optional(),
  'limit': z.number().readonly().optional(),
  'minSimilarity': z.number().readonly().optional(),
})`,
    }],
    result: {
      typeSymbol: 'MemorySearchResult',
      schema: result(`  'query': z.string().readonly(),
  'hits': z.array(${HIT}).readonly(),
  'total': z.number().readonly(),
  'semantic': z.boolean().readonly(),`),
    },
  },
  {
    method: 'create',
    line: 536,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryCreateRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'category': ${CATEGORY}.readonly(),
  'title': z.string().readonly(),
  'content': z.string().readonly(),
  'tags': z.array(z.string()).readonly().optional(),
  'priority': z.number().readonly().optional(),
  'metadataJson': z.string().readonly().optional(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryWriteResult',
      schema: result(`  'memory': ${MEMORY}.readonly(),
  'rulesChanged': z.boolean().readonly(),`),
    },
  },
  {
    method: 'update',
    line: 560,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryUpdateRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'id': z.string().readonly(),
  'category': ${CATEGORY}.readonly().optional(),
  'title': z.string().readonly().optional(),
  'content': z.string().readonly().optional(),
  'tags': z.array(z.string()).readonly().optional(),
  'priority': z.number().readonly().optional(),
  'status': ${STATUS}.readonly().optional(),
  'metadataJson': z.string().readonly().optional(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryWriteResult',
      schema: result(`  'memory': ${MEMORY}.readonly(),
  'rulesChanged': z.boolean().readonly(),`),
    },
  },
  {
    method: 'discard',
    line: 585,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryRemoveRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'id': z.string().readonly(),
  'hard': z.boolean().readonly(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryRemoveResult',
      schema: result(`  'removed': z.boolean().readonly(),
  'rulesChanged': z.boolean().readonly(),`),
    },
  },
  {
    method: 'sessions',
    line: 604,
    parameters: [{ name: 'request', typeSymbol: 'MemoryProjectRequest', schema: PROJECT_REQUEST }],
    result: {
      typeSymbol: 'MemorySessionsResult',
      schema: result(`  'sessions': z.array(${SESSION}).readonly(),`),
    },
  },
  {
    method: 'provenance',
    line: 618,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryProvenanceRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'id': z.string().readonly(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryProvenanceResult',
      schema: result(`  'entries': z.array(${PROVENANCE}).readonly(),`),
    },
  },
  {
    method: 'importInstructions',
    line: 633,
    parameters: [{
      name: 'request',
      typeSymbol: 'MemoryImportRequest',
      schema: `z.object({
  'project': z.string().readonly().optional(),
  'text': z.string().readonly(),
  'source': z.string().readonly(),
})`,
    }],
    result: {
      typeSymbol: 'MemoryImportResult',
      schema: result(`  'imported': z.number().readonly(),
  'rules': z.number().readonly(),
  'memories': z.array(${MEMORY}).readonly(),`),
    },
  },
  {
    method: 'exportAll',
    line: 660,
    parameters: [{ name: 'request', typeSymbol: 'MemoryProjectRequest', schema: PROJECT_REQUEST }],
    result: {
      typeSymbol: 'MemoryExportResult',
      schema: result(`  'json': z.string().readonly(),
  'count': z.number().readonly(),`),
    },
  },
  {
    method: 'reembed',
    line: 682,
    parameters: [{ name: 'request', typeSymbol: 'MemoryProjectRequest', schema: PROJECT_REQUEST }],
    result: {
      typeSymbol: 'MemoryEmbedResult',
      schema: result(`  'embedded': z.number().readonly(),
  'remaining': z.number().readonly(),`),
    },
  },
]
