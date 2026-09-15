# @achasoft/dsh-memory

**Persistent, searchable, per-project memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

An agent forgets everything between sessions. You re-explain the same decisions, the same conventions get missed, and the context you built up disappears the moment the window fills. This plugin gives each project its own memory — decisions, rules, architecture notes, and sprint goals — stored in a DuckDB file inside the project, retrieved by keyword and by meaning, and **injected into every model request** so a rule cannot be compacted away.

It is the [Claude Memory MCP](https://github.com/navid-kianfar/claude-memory-mcp) idea rebuilt as a first-class harness plugin: no daemon, no separate server, no second process owning your data.

---

## What you get

- **Per-project memory.** One DuckDB file at `<project>/.dsh/memory.db`. Two workspaces open in one client never share a rule set, and nothing follows you to another checkout.
- **Rules that actually bind.** Mandatory and forbidden rules are a system-prompt section, re-read at *every* prompt assembly — so they survive context compaction, and an edit in the UI binds the very next request without restarting anything. Rule text reaches the model exactly as written, `${{ secrets.GITHUB_TOKEN }}` included.
- **Rules you can tell apart.** An agent can record rules too, and those are marked *added by an agent* — in the prompt and in the Memory tab. An agent cannot change or retire a rule you wrote, and a subagent cannot add rules at all.
- **Hybrid search.** BM25F over title, entities, tags, summary, and body, blended with recency and how often a memory has proved useful. Add an embeddings endpoint and vector similarity joins the ranking; without one everything still works, keyword-only.
- **A management UI.** A **Memory** tab beside Chat in every project session — browse, search, add, edit, archive, and delete memories and rules, read each one's audit trail, and see the exact text the model is being given. The tab is a view of the session's own project, so it is always the memory the conversation beside it is bound by.
- **Model-facing tools.** `memory_search`, `memory_store`, `memory_recall`, `memory_rules`, `memory_add_rule`, `memory_session_end` by default; listing, editing, archiving, and provenance when you opt into the full set.
- **Session continuity.** Each session opens with the last session's summary, the current sprint goals, and recent decisions, and is reminded to file a summary before it ends. Every agent keeps its own memory session, so a subagent starting in the same project never closes its parent's.
- **Retention.** A sprint note is not a decision. Each category carries a lifetime, priority extends it, and rules never expire.
- **Queryable by hand.** `duckdb .dsh/memory.db "select * from rules"` is a supported way to use this, not a debugging trick.
- **Import and export.** Turn an existing `CLAUDE.md` or `AGENTS.md` into structured rules, or export everything as JSON to commit and share.

## Install

```bash
dsh plugin --profile <name> add @achasoft/dsh-memory
```

Then add it to your profile's `dsh.profile.bundles`. The plugin composes itself: the capability, the tools, and the browser surface all mount from its own `cordis.patch.yml`.

## How it works

```
your project/
  .dsh/memory.db            ← DuckDB: memories, rules, sessions, provenance

agent session starts  ──►  open the project's memory
                           register a rules section in THAT agent's scope
                           inject the last summary, sprint goals, decisions

every model request   ──►  the section re-reads the rule block  ← survives compaction

the agent works       ──►  memory_search / memory_store / memory_add_rule

session ends          ──►  memory_session_end files the summary
```

Rules go through the **system prompt**, not a per-turn message: the prompt is reassembled before every request, so the rules are always present and always current. Session context — history rather than obligation — is injected once at session start instead, so you do not pay for it on every turn.

A **subagent** works in its parent's directory, so it sees the same project. It is bound by the same rules, but it does not open a memory session of its own, is not sent the project history again (its brief comes from its parent), is not reminded to file a summary, and cannot add or change rules. Reloading the plugin re-binds agents that are already running.

### What the model is given, and how much

The rule block and the session context are repeated or injected into the model's context, so both are bounded:

| Limit | Value | When it is reached |
| --- | --- | --- |
| One rule in the block | 2,000 characters | The rest is cut, with a marker pointing at `memory_rules`. |
| The whole rule block | 24,000 characters | Rules an agent added are left out before any you wrote, with a line saying how many and that `memory_rules` has them all. |
| One carried sprint goal or decision | 1,000 characters | Cut with a marker. |
| The whole session context | 12,000 characters | The lowest-priority, oldest entries are left out, with a line saying how many. |
| A rule an agent records | 4,000 characters, 100 live agent rules per project | The tool refuses and says why. Your own rules are not held to either. |

## Configuration

Every field is a validated setting, changeable from your profile's `cordis.patch.yml` or from **Settings → Plugins → Memory** in the Web Client.

| Setting | Default | What it does |
| --- | --- | --- |
| `databasePath` | `.dsh/memory.db` | Relative to each project's directory. Changing it moves tools and running agents to the new file together, and releases the old one. |
| `injectRules` | `true` | Put the rule block in every model request. Off keeps rules stored but unenforced. |
| `injectSessionContext` | `true` | Seed a starting session with the last summary, sprint goals, and recent decisions. |
| `autoSession` | `true` | Open and close a memory session alongside each agent session. |
| `remind` | `once` | When to remind the model to file a summary: `never`, `once`, `every-turn`. |
| `vectorWeight` | `0.6` | The semantic signal's share of a blended ranking. Ignored without embeddings. |
| `minSimilarity` | `0.05` | Similarity floor for a search that does not name one. |
| `searchLimit` | `10` | Hits returned when the caller does not say. |
| `candidateLimit` | `1000` | Rows either search probe considers. |
| `embedBatch` | `64` | Memories embedded per background pass. |
| `toolset` | `core` | `core` or `full` — see below. |
| `retentionDays` | per category | Days per category; `0` means never. Rules never expire regardless. Restoring an expired or archived memory starts a fresh retention window. |

Every setting takes effect on the next request or call — including ranking knobs on projects that are already open — with no restart.

### Semantic recall (optional)

Enable the embeddings row and point it at any endpoint speaking OpenAI's `/v1/embeddings` — a hosted API, a local inference server, or Ollama:

```yaml
- id: memory-embeddings-openai
  disabled: false
  config:
    baseUrl: https://api.openai.com/v1
    model: text-embedding-3-small
    apiKeyEnv: OPENAI_API_KEY
    timeoutMs: 30000
    batchSize: 64
```

The key is addressed by reference, never stored: `apiKeyEnv` names an environment variable resolved through the harness credential seam at the start of every call.

Memories are embedded in the background and vectors are stored as DuckDB `FLOAT[]`, stamped with the provider's model name and the vector's dimension. The provider describes itself before anything is embedded, so a restart re-embeds nothing. Changing model — or `dimensions` under the same model — makes the old vectors stale: they are excluded from comparison and re-embedded in the background. A provider enabled, disabled, or reconfigured while projects are open is attached or detached on the spot. **Rebuild vectors** in the UI runs that backfill now and reports how many memories still lack a current vector.

## Tools

`toolset: core` registers six:

| Tool | For |
| --- | --- |
| `memory_search` | Find what the project already knows, by meaning and by keyword. |
| `memory_store` | Record a decision, architecture note, devops fact, sprint goal, or feedback. |
| `memory_recall` | Read one memory in full, by id or exact title. |
| `memory_rules` | Read the complete binding rule set. |
| `memory_add_rule` | State something the agent must always or must never do. |
| `memory_session_end` | File the summary the next session opens with. |

`toolset: full` adds `memory_list`, `memory_update`, `memory_archive`, and `memory_provenance` for deployments where the agent, rather than a person, curates the memory. Even then, an agent can only edit or retire rules an agent added: a rule you wrote is refused with a message saying you can change it in the Memory tab.

`memory_session_end` files the summary against the calling agent's own memory session, and refuses to close another agent's.

## The database

Two views exist for reading the file by hand:

```bash
duckdb .dsh/memory.db "select kind, title, content from rules"
duckdb .dsh/memory.db "select category, title, updated, expires from memory"
```

DuckDB allows a single writer, so the running harness owns the file; close it before opening the database read-write elsewhere.

`.dsh/memory.db` is a normal file — commit it to share a team's rules, or add it to `.gitignore` to keep memory local.

## Categories

`decision` · `architecture` · `devops` · `sprint` · `project_plan` · `developer_docs` · `feedback` · `reference` · `session` · `mandatory_rules` · `forbidden_rules`

Category decides retention and whether an entry is enforced. Rules are enforced as written and never ranked; only the size limits above can leave one out of the prompt, and the prompt then says so.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test          # checks the RPC artifact, then runs the suite
pnpm run build     # emits generated/, then tsc → tsdown (node + browser halves)
```

`generated/` is the Typert RPC contract, rendered by `scripts/typert-emit.mjs` from the endpoint table in `scripts/typert-endpoints.mjs`. `pnpm test` fails when `src/host/index.ts`, `src/host/types.ts`, the table, or the renderer changed since the contract was last regenerated, or when a file under `generated/` is not what the table renders to. After updating the table, run `pnpm run regen:typert` — the everyday build writes `generated/` but deliberately does not re-record the fingerprint, so it cannot hide drift. `tests/typert.spec.ts` runs the emitted manifest through the harness's own validator.

## License

MIT
