/**
 * The model-facing side of memory: the tools an agent uses to remember, recall, and be bound.
 *
 * The set is deliberately small by default. Every registered tool spends prompt tokens on every
 * request, and an agent that can search, store, and state a rule can do everything memory is for —
 * so listing, editing, archiving, and auditing are the `full` toolset a deployment opts into, and
 * the manager UI covers them for a person regardless.
 *
 * Nothing here re-implements behaviour. Each tool validates its arguments, calls the same
 * {@link ProjectMemory} the RPC endpoints call, and renders the result; a rule stated through
 * `memory_add_rule` binds exactly as one added through the manager does.
 *
 * @module @achasoft/dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProjectMemory } from '../host/memory.ts'
import { isSubagentSession } from '../host/lineage.ts'
import type { Memory, MemoryCategory, MemoryStatus } from '../domain/types.ts'
import { MEMORY_CATEGORIES, MEMORY_STATUSES, MEMORY_SORT_KEYS } from '../domain/types.ts'
import { AGENT_SOURCE, isAgentAuthored, type WriteOrigin } from '../domain/authorship.ts'
import { AGENT_LABEL, singleLine } from '../domain/rules.ts'
import {
  parseCreate, parseListQuery, parseSearchQuery, parseUpdate, requireRuleCategory, requireText,
  TITLE_MAX_CHARS,
} from '../domain/validate.ts'
// Type-only: the `memory` service this consumer reads projects from.
import type {} from '../host/index.ts'

export const name = 'tool-memory'
export const inject = ['tools', 'memory']

/** Model-facing memory tool configuration. */
export interface Config {
  /**
   * Which tools to register.
   *
   * `core` registers search, store, recall, rules, add-rule, and end-session: enough for an agent to
   * remember and be bound. `full` adds listing, editing, archiving, and the audit trail, for
   * deployments where the agent rather than a person curates the memory.
   *
   * This is the default. A `toolset` saved in the `memory` settings section — the settings card's
   * choice — overrides it live, without reloading this row.
   */
  toolset: 'core' | 'full'
}

/**
 * The agent a tool call runs in, as the tool registry hands it over.
 *
 * Derived from the `agents` service rather than imported by name, so it is the type the running
 * harness declares even when a linked development checkout disagrees with the installed release.
 */
type Agent = ReturnType<Context['agents']['list']>[number]

/** How many hits a search returns when the model does not say. */
const SEARCH_DEFAULT_LIMIT = 8

/** How many audit entries `memory_provenance` returns. */
const PROVENANCE_LIMIT = 25

/** The categories a model may choose from, as one line of the tool description. */
const CATEGORY_LIST = MEMORY_CATEGORIES.join(', ')

/** The canonical shape one memory takes in every tool's output. */
const MEMORY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    category: { type: 'string', required: true, enum: [...MEMORY_CATEGORIES] },
    title: { type: 'string', required: true },
    content: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    status: { type: 'string', required: true, enum: [...MEMORY_STATUSES] },
    priority: { type: 'integer', required: true },
    source: { type: 'string', required: true },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
  },
} as const

/** The canonical value one memory takes in every tool's output. */
interface MemoryOut {
  id: string
  category: MemoryCategory
  title: string
  content: string
  summary: string
  tags: string[]
  status: MemoryStatus
  priority: number
  /** `assistant` when an agent wrote it; anything else was written by a person. */
  source: string
  createdAt: number
  updatedAt: number
}

/**
 * Project a memory onto the tool output.
 * @param memory - the stored memory.
 * @returns the canonical value the model and Code Mode both receive.
 */
function out(memory: Memory): MemoryOut {
  return {
    id: memory.id,
    category: memory.category,
    title: memory.title,
    content: memory.content,
    summary: memory.summary,
    tags: [...memory.tags],
    status: memory.status,
    priority: memory.priority,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }
}

/**
 * Resolve the project memory an executing tool call belongs to.
 *
 * A tool call always runs inside an agent, and that agent's session names the directory it is
 * working in — so the memory a call reaches is the memory of the project the model is looking at,
 * never a Host-wide default that would answer with another project's rules.
 * @param ctx - the registrant context carrying the memory service.
 * @param agent - the calling agent, when there is one.
 * @returns the project's memory.
 * @throws Error when the call has no agent, or its session names no directory.
 */
async function projectFor(ctx: Context, agent: Agent | undefined): Promise<ProjectMemory> {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined) {
    throw new Error('memory tools need a session working directory; this call has none')
  }
  return ctx.memory.project(cwd)
}

/**
 * Describe the calling agent to the memory it writes to.
 *
 * Every tool call is an agent's, so every call carries an `agent` origin: that is what subjects it to
 * the authorship rules — no rewriting the user's rules, no rules at all from a subagent — and what
 * attributes its reads and writes to its own memory session rather than another agent's.
 * @param agent - the calling agent, when there is one.
 * @returns the origin to pass to the memory.
 */
function originOf(agent: Agent | undefined): WriteOrigin {
  if (agent === undefined) return { agent: { subagent: false } }
  return { session: agent.id, agent: { subagent: isSubagentSession(agent.session.header) } }
}

/**
 * Render a rule as one line of tool output, marking the ones an agent added.
 *
 * One line whatever the stored text holds, as in the injected block: a rule body carrying its own
 * line breaks would otherwise list, under the `FORBIDDEN:` heading or as a bare `- ` entry, a rule
 * nobody recorded — and without the label its real author earned.
 * @param rule - the rule as the tool returns it.
 * @param rule.title - its title.
 * @param rule.content - its body.
 * @param rule.source - who wrote it.
 * @returns the line.
 */
function ruleLine(rule: { title: string, content: string, source: string }): string {
  const label = isAgentAuthored(rule) ? `${AGENT_LABEL} ` : ''
  return `- ${label}${singleLine(rule.title)}: ${singleLine(rule.content)}`
}

/**
 * Register the memory tools.
 * @param ctx - registrant context carrying the tool registry and the memory service.
 * @param config - which toolset the deployment registers.
 */
export function apply(ctx: Context, config: Config): void {
  const project = (agent: Agent | undefined): Promise<ProjectMemory> => projectFor(ctx, agent)
  registerCoreTools(ctx, project)

  // The curation tools follow the toolset chosen in settings while the plugin runs, rather than the
  // value this row was loaded with: the settings card edits the `memory` section, and a choice made
  // there that waited for a reload of this row would look, to the person making it, like no choice.
  let curation: readonly (() => void)[] | undefined
  const sync = (): void => {
    const toolset = ctx.memory.toolsetFor(config.toolset)
    ctx.memory.noteRegisteredToolset(toolset)
    if (toolset === 'full' && curation === undefined) curation = registerCurationTools(ctx, project)
    if (toolset === 'core' && curation !== undefined) {
      for (const unregister of curation) unregister()
      curation = undefined
    }
  }
  sync()
  ctx.effect(() => {
    const unwatch = ctx.memory.watchToolset(sync)
    return () => {
      unwatch()
      ctx.memory.noteRegisteredToolset(undefined)
    }
  }, 'dsh-memory: follow the toolset setting')
}

/** Resolves the project memory a tool call belongs to. */
type ProjectResolver = (agent: Agent | undefined) => Promise<ProjectMemory>

/**
 * Register the tools every deployment gets: search, store, recall, rules, add-rule, end-session.
 * @param ctx - registrant context carrying the tool registry.
 * @param project - resolves the calling agent's project memory.
 */
function registerCoreTools(ctx: Context, project: ProjectResolver): void {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search this project\'s stored memory — decisions, architecture notes, conventions, sprint '
      + 'goals, and past session summaries — by meaning and by keyword. Use it BEFORE answering a '
      + 'question about why something is the way it is, before proposing a change to an area you '
      + 'have not touched this session, and whenever the user refers to something decided earlier. '
      + 'Returns ranked results with the full text of each.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What you are looking for, in natural language. Full questions work better than keywords.',
      },
      category: {
        type: 'string',
        enum: [...MEMORY_CATEGORIES],
        description: `Restrict to one category: ${CATEGORY_LIST}.`,
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Restrict to memories carrying any of these tags.' },
      limit: { type: 'integer', description: `Most results to return (default ${SEARCH_DEFAULT_LIMIT}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          semantic: { type: 'boolean', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                memory: { ...MEMORY_OUTPUT, required: true },
                similarity: { type: 'number', required: true },
                relevance: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? `No stored memory matches "${value.query}".`
          : `${value.hits.length} memor${value.hits.length === 1 ? 'y' : 'ies'} for "${value.query}":\n\n`
            + value.hits.map(hit =>
              `## ${singleLine(hit.memory.title)}\n`
              + `[${hit.memory.category}] id ${hit.memory.id} · relevance ${hit.relevance}\n\n`
              + hit.memory.content).join('\n\n---\n\n'),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'search',
      title: `Search memory: ${String(args['query'] ?? '')}`,
    }),
    async execute(args, exec) {
      const memory = await project(exec.agent)
      const query = parseSearchQuery({ ...args, limit: args.limit ?? SEARCH_DEFAULT_LIMIT })
      const result = await memory.search(query, Date.now(), exec.signal, originOf(exec.agent))
      return {
        query: result.query,
        semantic: result.semantic,
        hits: result.hits.map(hit => ({
          memory: out(hit.memory), similarity: hit.similarity, relevance: hit.relevance,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_store',
    description:
      'Store something this project should remember after this session ends: a decision and its '
      + 'reasoning, an architecture note, a devops fact, a sprint goal, or feedback the user gave. '
      + 'Store the REASON, not just the outcome — "chose DuckDB because the store is queried by hand" '
      + 'is useful next month; "using DuckDB" is not. For a standing instruction the agent must '
      + 'always or never follow, use memory_add_rule instead.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        enum: [...MEMORY_CATEGORIES.filter(category => !category.endsWith('_rules'))],
        description:
          'decision (a choice and why) | architecture (how the system is built) | devops (build, '
          + 'deploy, infra) | sprint (current goals) | project_plan | developer_docs | feedback '
          + '(what the user asked for or objected to) | reference (external links and resources) | '
          + 'session (a session summary).',
      },
      title: { type: 'string', required: true, description: 'A short, specific name. This is how the memory is found again.' },
      content: { type: 'string', required: true, description: 'The full text, including the reasoning.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Labels for filtering later.' },
      priority: { type: 'integer', description: '0 (default) to 3. Higher survives longer and sorts first.' },
    },
    output: { schema: MEMORY_OUTPUT, render: (_args, value) => [{ type: 'text', text: `Stored "${value.title}" as ${value.category} (id ${value.id}).` }] },
    presentCall: args => ({ card: 'generic', title: `Remember: ${String(args['title'] ?? '')}` }),
    async execute(args, exec) {
      const memory = await project(exec.agent)
      const written = await memory.create(
        parseCreate({ ...args, source: AGENT_SOURCE }), 'agent', Date.now(), originOf(exec.agent),
      )
      return out(written.memory)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Read one stored memory in full, by its id or by its exact title. Use it to follow up on a '
      + 'search result, or when the user names a memory directly.',
    parameters: {
      id: { type: 'string', description: 'The memory id, as returned by memory_search or memory_store.' },
      title: { type: 'string', description: 'The exact title, when you do not have the id.' },
    },
    output: { schema: MEMORY_OUTPUT, render: (_args, value) => [{ type: 'text', text: `## ${singleLine(value.title)}\n[${value.category}] id ${value.id}\n\n${value.content}` }] },
    async execute(args, exec) {
      if (args.id === undefined && args.title === undefined) {
        throw new Error('supply either `id` or `title`')
      }
      const memory = await project(exec.agent)
      return out(await memory.recall({
        ...args.id === undefined ? {} : { id: args.id },
        ...args.title === undefined ? {} : { title: args.title },
      }, Date.now(), originOf(exec.agent)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_rules',
    description:
      'Read this project\'s complete set of binding rules — everything the agent must always do and '
      + 'must never do. These are already in your system prompt; call this only to confirm the '
      + 'current set after adding or changing a rule, or when the user asks what the rules are.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mandatory: { type: 'array', required: true, items: MEMORY_OUTPUT },
          forbidden: { type: 'array', required: true, items: MEMORY_OUTPUT },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mandatory.length + value.forbidden.length === 0
          ? 'This project has no binding rules.'
          : `MANDATORY:\n${value.mandatory.map(ruleLine).join('\n') || '(none)'}\n\n`
            + `FORBIDDEN:\n${value.forbidden.map(ruleLine).join('\n') || '(none)'}`,
      }],
    },
    async execute(_args, exec) {
      const memory = await project(exec.agent)
      const rules = await memory.rules(Date.now())
      return { mandatory: rules.mandatory.map(out), forbidden: rules.forbidden.map(out) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_add_rule',
    description:
      'Record a standing instruction for this project — something the agent must ALWAYS do, or must '
      + 'NEVER do. Rules are injected into every request from now on, including in future sessions, '
      + 'and survive context compaction. Add one whenever the user says "always", "never", "make '
      + 'sure you", or corrects the same mistake twice. Keep each rule to one obligation so it can '
      + 'be changed or withdrawn on its own. Rules you add are labelled as added by an agent, and a '
      + 'subagent cannot add them.',
    parameters: {
      rule_type: {
        type: 'string',
        required: true,
        enum: ['mandatory', 'forbidden'],
        description: 'mandatory (must always do) | forbidden (must never do).',
      },
      title: { type: 'string', required: true, description: 'The rule in one imperative line, e.g. "Run doc-sync before pushing".' },
      content: { type: 'string', required: true, description: 'The full rule, including any scope or exception it carries.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Labels for filtering later.' },
    },
    output: { schema: MEMORY_OUTPUT, render: (_args, value) => [{ type: 'text', text: `Added ${value.category === 'mandatory_rules' ? 'a MANDATORY' : 'a FORBIDDEN'} rule: "${value.title}" (id ${value.id}). It now binds every request.` }] },
    presentCall: args => ({ card: 'generic', title: `Add ${String(args['rule_type'] ?? '')} rule: ${String(args['title'] ?? '')}` }),
    async execute(args, exec) {
      const memory = await project(exec.agent)
      const written = await memory.create(parseCreate({
        ...args, category: requireRuleCategory(args.rule_type), source: AGENT_SOURCE,
      }), 'agent', Date.now(), originOf(exec.agent))
      return out(written.memory)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_session_end',
    description:
      'File a summary of this session so the next one starts knowing what happened. Write what was '
      + 'decided, what was left unfinished, and what the next session needs to know — not a list of '
      + 'what you did. Call it once, when the work is done.',
    parameters: {
      summary: { type: 'string', required: true, description: 'What was decided, what is unfinished, and what comes next.' },
      session_id: { type: 'string', description: 'The session to close; defaults to the one this agent opened. Only that session can be closed: any other id — another agent\'s, another process\'s, or one that already ended — is refused.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.closed
          ? 'Session summary filed. The next session will open with it.'
          : 'No open memory session to close — the summary was not filed.',
      }],
    },
    async execute(args, exec) {
      const memory = await project(exec.agent)
      const summary = requireText(args.summary, 'summary', 20_000)
      // The caller's OWN session: a subagent shares its parent's project, and "the project's session"
      // would file one agent's summary over another's work.
      const owner = originOf(exec.agent).session
      const sessionId = args.session_id ?? (owner === undefined ? undefined : memory.sessionIdFor(owner))
      const closed = owner === undefined ? false : await memory.endSession(sessionId, summary, Date.now(), owner)
      return { closed, ...sessionId === undefined ? {} : { sessionId } }
    },
  }))
}

/**
 * Register the curation tools the `full` toolset adds: list, update, archive, provenance.
 * @param ctx - registrant context carrying the tool registry.
 * @param project - resolves the calling agent's project memory.
 * @returns one disposer per tool, so a switch back to `core` can withdraw exactly these.
 */
function registerCurationTools(ctx: Context, project: ProjectResolver): readonly (() => void)[] {
  return [
    ctx.tools.register(defineTool({
      name: 'memory_list',
      description:
        'Browse this project\'s stored memory without searching: filter by category, tag, status, or '
        + 'a substring, and page through the result. Use memory_search when you know what you are '
        + 'looking for; use this to see what is there.',
      parameters: {
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: `One of: ${CATEGORY_LIST}.` },
        status: { type: 'string', enum: [...MEMORY_STATUSES, 'all'], description: 'Defaults to active. `all` includes archived and expired.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Memories carrying any of these tags.' },
        text: { type: 'string', description: 'Case-insensitive substring of the title, summary, or content.' },
        limit: { type: 'integer', description: 'Page size (default 50).' },
        offset: { type: 'integer', description: 'Rows to skip.' },
        sort_by: { type: 'string', enum: [...MEMORY_SORT_KEYS], description: 'Defaults to updatedAt.' },
        sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Defaults to desc.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memories: { type: 'array', required: true, items: MEMORY_OUTPUT },
            total: { type: 'integer', required: true },
            offset: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.memories.length === 0
            ? 'No memories match those filters.'
            : `${value.memories.length} of ${value.total}:\n`
              + value.memories.map(memory =>
                `- [${memory.category}] ${singleLine(memory.title)} — ${singleLine(memory.summary)} (id ${memory.id})`).join('\n'),
        }],
      },
      async execute(args, exec) {
        const memory = await project(exec.agent)
        const page = await memory.list(parseListQuery(args), Date.now())
        return { memories: page.memories.map(out), total: page.total, offset: page.offset }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_update',
      description:
        'Change a stored memory in place — correct it, add what was learned since, or reclassify it. '
        + 'Only the fields you supply change. Editing a rule changes what binds every later request. '
        + 'A rule the user wrote can only be changed by the user, in the Memory tab.',
      parameters: {
        memory_id: { type: 'string', required: true, description: 'The memory to change.' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        priority: { type: 'integer', description: '0 to 3.' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: `One of: ${CATEGORY_LIST}.` },
      },
      output: { schema: MEMORY_OUTPUT, render: (_args, value) => [{ type: 'text', text: `Updated "${value.title}" (id ${value.id}).` }] },
      async execute(args, exec) {
        const memory = await project(exec.agent)
        // Only the fields this tool declares: lifecycle and sidecar changes are the user's, from the
        // manager, whatever else a generated argument object happens to carry.
        const patch = parseUpdate({
          memory_id: args.memory_id,
          ...args.title === undefined ? {} : { title: args.title },
          ...args.content === undefined ? {} : { content: args.content },
          ...args.tags === undefined ? {} : { tags: args.tags },
          ...args.priority === undefined ? {} : { priority: args.priority },
          ...args.category === undefined ? {} : { category: args.category },
        })
        const written = await memory.update(patch, 'agent', Date.now(), originOf(exec.agent))
        return out(written.memory)
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_archive',
      description:
        'Retire a memory that is no longer true. It stops being recalled and, if it was a rule, stops '
        + 'binding — but it stays restorable and auditable. Prefer this to deleting: a superseded '
        + 'decision is part of how the project got here. A rule the user wrote can only be retired by the '
        + 'user, in the Memory tab.',
      parameters: {
        memory_id: { type: 'string', required: true, description: 'The memory to retire.' },
        reason: { type: 'string', description: 'Why it is no longer true; recorded on the audit trail.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            rulesChanged: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Archived "${value.title}".${value.rulesChanged ? ' The binding rule set changed.' : ''}`,
        }],
      },
      async execute(args, exec) {
        const memory = await project(exec.agent)
        const id = requireText(args.memory_id, 'memory_id', TITLE_MAX_CHARS)
        const reason = args.reason === undefined ? undefined : requireText(args.reason, 'reason', 2000)
        const written = await memory.archive(id, 'agent', Date.now(), reason, originOf(exec.agent))
        return { id: written.memory.id, title: written.memory.title, rulesChanged: written.rulesChanged }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_provenance',
      description:
        'Read one memory\'s history: when it was written, every edit, and every time it was recalled. '
        + 'Use it when the user asks who changed something, or when a memory contradicts what you '
        + 'expected and you need to see how it got that way.',
      parameters: {
        memory_id: { type: 'string', required: true, description: 'The memory to trace.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  seq: { type: 'integer', required: true },
                  operation: { type: 'string', required: true },
                  actor: { type: 'string', required: true },
                  at: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.entries.length === 0
            ? 'No history for that memory.'
            : value.entries.map(entry =>
                `${new Date(entry.at).toISOString()} — ${entry.operation} by ${entry.actor}`).join('\n'),
        }],
      },
      async execute(args, exec) {
        const memory = await project(exec.agent)
        const id = requireText(args.memory_id, 'memory_id', TITLE_MAX_CHARS)
        const entries = await memory.provenance(id, PROVENANCE_LIMIT)
        return {
          entries: entries.map(entry => ({
            seq: entry.seq, operation: entry.operation, actor: entry.actor, at: entry.at,
          })),
        }
      },
    })),
  ]
}
