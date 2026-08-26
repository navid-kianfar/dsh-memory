# @achasoft/dsh-memory

**Persistent, searchable, per-project memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

An agent forgets everything between sessions. You re-explain the same decisions, the same conventions get missed, and the context you built up disappears the moment the window fills. This plugin gives each project its own memory — decisions, rules, architecture notes, and sprint goals — stored in a DuckDB file inside the project, retrieved by keyword and by meaning, and **injected into every model request** so a rule cannot be compacted away.

It is the [Claude Memory MCP](https://github.com/navid-kianfar/claude-memory-mcp) idea rebuilt as a first-class harness plugin: no daemon, no separate server, no second process owning your data.

---

## What you get

- **Per-project memory.** One DuckDB file at `<project>/.dsh/memory.db`. Two workspaces open in one client never share a rule set, and nothing follows you to another checkout.
- **Rules that actually bind.** Mandatory and forbidden rules are a system-prompt section, re-read at *every* prompt assembly — so they survive context compaction, and an edit in the UI binds the very next request without restarting anything.
- **Hybrid search.** BM25F over title, entities, tags, summary, and body, blended with recency and how often a memory has proved useful. Add an embeddings endpoint and vector similarity joins the ranking; without one everything still works, keyword-only.
- **A management UI.** A full-height panel in the Web Client — browse, search, add, edit, archive, and delete memories and rules, read each one's audit trail, and see the exact text the model is being given.
- **Model-facing tools.** `memory_search`, `memory_store`, `memory_recall`, `memory_rules`, `memory_add_rule`, `memory_session_end` by default; listing, editing, archiving, and provenance when you opt into the full set.
- **Session continuity.** Each session opens with the last session's summary, the current sprint goals, and recent decisions, and is reminded to file a summary before it ends.
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

## Configuration

Every field is a validated setting, changeable from your profile's `cordis.patch.yml` or from **Settings → Plugins → Memory** in the Web Client.

| Setting | Default | What it does |
| --- | --- | --- |
| `databasePath` | `.dsh/memory.db` | Relative to each project's directory. |
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
| `retentionDays` | per category | Days per category; `0` means never. Rules never expire regardless. |

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

Memories are embedded in the background and vectors are stored as DuckDB `FLOAT[]`. Changing model strands the old vectors — they are excluded from comparison rather than compared — and **Rebuild vectors** in the UI re-embeds everything.

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

`toolset: full` adds `memory_list`, `memory_update`, `memory_archive`, and `memory_provenance` for deployments where the agent, rather than a person, curates the memory.

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

Category decides retention and whether an entry is enforced. Rules are enforced verbatim and completely — never ranked, never truncated.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test          # checks the RPC artifact, then runs the suite
pnpm run build     # emits generated/, then tsc → tsdown (node + browser halves)
```

`generated/` is the Typert RPC contract, emitted by `scripts/build-typert.mjs` from the endpoint table in `scripts/typert-endpoints.mjs`. `pnpm test` fails if it drifts from `src/host/`, and `tests/typert.spec.ts` runs the emitted manifest through the harness's own validator.

## License

MIT
