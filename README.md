# @achasoft/dsh-memory

Persistent, per-project memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Each project gets a DuckDB file at `<project>/.dsh/memory.db` holding decisions, architecture notes, sprint goals, session summaries, and binding rules. Mandatory and forbidden rules are a system-prompt section, re-read on every model request, so they survive context compaction. Memories are ranked by keyword (BM25F) and, when an embeddings endpoint is configured, by vector similarity. The Web Client gets a **Memory** tab to browse and edit all of it.

![The Memory tab beside Chat, showing a project's memories filtered by category, with the database path and active and embedded counts in the header](https://raw.githubusercontent.com/navid-kianfar/dsh-memory/main/docs/screenshots/memory-tab.png)

## Features

### The Memory tab

A **Memory** tab sits beside Chat in every session. It always shows the memory of that session's project. The header shows the database path, how many memories are active and how many have a vector, and whether rules are currently injected. The tab has three panes:

- **Memories**: search box (labelled *Semantic + keyword* or *Keyword only*), category and status filters (Active, Archived, Expired, All), and actions: **New**, **New rule**, **Import instructions file**, **Export JSON**, **Rebuild vectors**.
- **Rules**: the live mandatory and forbidden rules, and a **Show the injected text** toggle that displays the rule block exactly as the model receives it.
- **Sessions**: the last 50 memory sessions, with summaries and how many memories each wrote and read.

Each memory card offers Edit, Archive or Restore, **Delete permanently** (removes the row and its audit trail, after confirmation), and **History**: the audit trail of creates, edits, reads, archives, restores, imports, and expiries.

![A memory card with its History expanded, listing when it was created, edited, and read](https://raw.githubusercontent.com/navid-kianfar/dsh-memory/main/docs/screenshots/memory-card-history.png)

### Rules that bind every request

Rules are injected through the system prompt, not a message, so every request carries the current rule set and an edit in the tab applies from the next request. Rule text reaches the model verbatim: a literal `{{`, as in `${{ secrets.GITHUB_TOKEN }}`, is escaped so the harness prompt renderer does not treat it as a template variable.

Rules an agent recorded carry an **Added by an agent** badge in the tab and an `[added by an agent]` label in the prompt. When an agent-added rule is present, the block also tells the model that the user's own rules win on conflict.

![The Rules pane with one rule marked "Added by an agent" and the injected rule block expanded below](https://raw.githubusercontent.com/navid-kianfar/dsh-memory/main/docs/screenshots/memory-rules.png)

The injected text is bounded, because it is paid for on every request:

| Limit | Value | When it is reached |
| --- | --- | --- |
| One rule in the block | 2,000 characters | The rule is cut, with a marker pointing at `memory_rules`. |
| The whole rule block | 24,000 characters | Agent-added rules are left out before user rules; a line says how many were left out. |
| One sprint goal or decision in session context | 1,000 characters | Cut with a marker. |
| The whole session context | 12,000 characters | Later entries are left out; a line says how many. |

### Session continuity

Each top-level agent gets its own memory session. When it starts, the model receives one message with the last real session summary (up to 1,500 characters), up to 10 sprint goals, and up to 20 decisions from the last 7 days. Sessions left open by a crash or a disposed agent are closed with an `[auto-closed: …]` summary, which is skipped when picking the last summary. At the end of a turn the model is reminded to call `memory_session_end` (see `remind`).

A subagent (a session whose header has `origin: 'subagent'` or `delegationDepth > 0`) is bound by the same rules, but gets no memory session, no session context, and no reminder. A user's fork of a session is not a subagent.

### Retention

Each non-rule memory gets an expiry date when it is written. Once that date passes, the memory drops out of search, session context, recall by title, and the Active list, and it is listed and reported as `expired`. Its stored status changes to `expired` at the next top-level session start in that project.

| Category | Default days |
| --- | --- |
| `session` | 30 |
| `sprint`, `feedback` | 90 |
| `devops`, `developer_docs` | 180 |
| `decision`, `project_plan`, `architecture`, `reference` | 365 |
| `mandatory_rules`, `forbidden_rules` | never |

Priority 1 multiplies the lifetime by 1.5. Priority 2 and 3 never expire. Rules are always raised to at least priority 2. Restoring an archived or expired memory starts a new retention window.

### Import and export

**Import instructions file** accepts `.md`, `.markdown`, or `.txt` (for example `CLAUDE.md` or `AGENTS.md`). Headings decide the category; list items under rule-like headings ("Never", "Always", "Rules", "Conventions", …) become one rule each. An import creates at most 1,000 entries and is validated in full before anything is written. Imported entries count as user-written.

**Export JSON** downloads every memory in the project, in all statuses, as `<project>-memory.json`. There is no JSON import.

### Settings card

**Settings → Plugins → Memory** shows whether semantic recall is ready and lets you change the fields marked in [Configuration](#configuration).

![The Memory settings card expanded, showing the semantic recall status, the injection switches, the reminder and toolset selectors, the ranking fields, and the database path](https://raw.githubusercontent.com/navid-kianfar/dsh-memory/main/docs/screenshots/memory-settings-card.png)

## Requirements

- **Harness:** tested with `@deepseek-ai/dsh` 0.1.5-rc.2.
- **Node.js:** `^22.19 || >=24` (`engines` in `package.json`).
- **pnpm** on `PATH`: `dsh plugin` forwards to it.
- **DuckDB:** `@duckdb/node-api` 1.5.5-r.4 is a regular dependency. Its bindings ship as prebuilt optional packages for macOS (arm64, x64), Linux (arm64, x64, glibc and musl), and Windows (arm64, x64); nothing is compiled at install time. Other platforms are not supported.
- **Harness services:** peer dependencies are `@deepseek-ai/cordis`, `dsh-agent`, `dsh-credentials`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-typert-protocol`, and `schemastery`, all provided by a standard `dsh-base` profile. The host half requires the `agents` service; `settings` (for the Settings card and live edits) and `memoryEmbedding` are optional. The browser half needs a Web Client profile (`dsh-api-remotes`, `dsh-client-locale`, `dsh-client-ui-conversation`, `dsh-client-ui-settings`, `dsh-client-ui-settings-plugins`).
- **Embeddings (optional):** any endpoint that implements OpenAI's `POST /v1/embeddings`, such as a hosted API, a local inference server, or Ollama. Without one, ranking is keyword-only and every other feature works.

## Install

```bash
dsh plugin --profile web add @achasoft/dsh-memory
dsh web
```

`dsh plugin --profile <name> <args>` runs `pnpm <args>` in `$DSH_HOME/profiles/<name>` (`$DSH_HOME` defaults to `~/.dsh`) and creates the profile on first use. After a successful `add`, any dependency whose `package.json` declares `dsh.bundle` is appended to the profile's `dsh.profile.bundles`. No manual edit is needed.

At boot the harness composes the profile from patch layers, in this order: each bundle's `cordis.patch.yml` (in `bundles` order), the profile's own `cordis.patch.yml`, `$DSH_HOME/cordis.patch.yml`, then any `--patch <file>` overlays. This package's patch inserts four rows:

| Row `id` | Loads | Default |
| --- | --- | --- |
| `memory` | `@achasoft/dsh-memory/host`: store, prompt hooks, RPC, settings | on |
| `memory-tools` | `@achasoft/dsh-memory/tools`: model-facing tools | on |
| `memory-ui` | `@achasoft/dsh-memory`: the browser half | on |
| `memory-embeddings-openai` | `@achasoft/dsh-memory/embeddings-openai` | `disabled: true` |

To uninstall:

```bash
dsh plugin --profile web remove @achasoft/dsh-memory
```

This removes the dependency and its bundle entry. Remove any rows in your own patch files that target the ids above. `.dsh/memory.db` files in your projects are left in place.

## Configuration

Override a row from your profile's `cordis.patch.yml` by `id`. A patch replaces the row's whole `config`, so restate every key the row needs:

```yaml
- id: memory
  config:
    databasePath: .dsh/memory.db
    injectRules: true
    injectSessionContext: true
    autoSession: true
    remind: once
    vectorWeight: 0.6
    minSimilarity: 0.3
    searchLimit: 10
    candidateLimit: 1000
    embedBatch: 64
    retentionDays:
      sprint: 30
      decision: 0
    relevanceWeights:
      similarity: 0.7
      recency: 0.15
      access: 0.15
```

The patch row is the base layer. Values saved from the Settings card go to the harness settings layer (the `memory:` section of `$DSH_HOME/settings.yaml`) and take precedence over it. Committed changes apply from the next request or call, without a restart.

### `memory` row

| Key | Default | In Settings card | What it does |
| --- | --- | --- | --- |
| `databasePath` | `.dsh/memory.db` | yes | Relative paths resolve against each project directory. An absolute path makes every project share one file. Changing it moves open projects and running agents to the new file. |
| `injectRules` | `true` | yes | Inject the rule block into every request. Off keeps rules stored but not enforced. |
| `injectSessionContext` | `true` | yes | Send the last summary, sprint goals, and recent decisions when a top-level session starts. |
| `autoSession` | `true` | yes | Open a memory session per top-level agent. Off also disables the reminder. |
| `remind` | `once` | yes | `never`, `once` (first stop boundary with an open session), or `every-turn`. |
| `toolset` | `core` | yes | `core` or `full` tools. Only a value saved in the settings layer (the card, or `settings.yaml`) counts, and it overrides the `memory-tools` row live. Set on this row in a patch file, it has no effect. |
| `vectorWeight` | `0.6` | yes | Share of the vector score in a blended similarity, `0`–`1`. |
| `minSimilarity` | `0.05` | yes | Similarity floor for searches that do not set one, `0`–`1`. |
| `searchLimit` | `10` | yes | Results for a Memory-tab search that sets no limit, `1`–`100`. |
| `candidateLimit` | `1000` | no | Rows each search probe (keyword and vector) considers. |
| `embedBatch` | `64` | no | Memories embedded per background pass. |
| `retentionDays` | `{}` | no | Days per category. An absent category uses the default table above; `0` means never expire. Rules never expire. |
| `relevanceWeights` | `{ similarity: 0.7, recency: 0.15, access: 0.15 }` | no | How match, recency, and read count combine into the final ordering. |

The shipped `cordis.patch.yml` restates `retentionDays` and `relevanceWeights` with these defaults. An older override that leaves them out still loads; the schema supplies the same defaults.

### `memory-tools` row

| Key | Default | What it does |
| --- | --- | --- |
| `toolset` | `core` | `core` registers six tools; `full` adds four more. This is the default: a toolset saved from the Settings card overrides it without a restart, and the card shows the toolset in force. |

### `memory-embeddings-openai` row

Enable the row and restate its config:

```yaml
- id: memory-embeddings-openai
  disabled: false
  config:
    baseUrl: http://127.0.0.1:11434/v1
    model: nomic-embed-text
    timeoutMs: 30000
    batchSize: 64
```

| Key | Default in patch | Required | What it does |
| --- | --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | yes | Endpoint prefix; `/embeddings` is appended. |
| `model` | `text-embedding-3-small` | yes | Sent as `model`, and stamped on every stored vector. |
| `apiKeyEnv` | `OPENAI_API_KEY` | no | Name of the credential to send as a bearer token, resolved through the harness credential service on every call. Omit it for an endpoint that needs no key. |
| `timeoutMs` | `30000` | yes | Per-request deadline. |
| `batchSize` | `64` | yes | Texts per HTTP request. |
| `dimensions` | unset | no | Sent as `dimensions`, for endpoints that support shortened vectors. |

Vectors are stored with the model name and the vector length. When the model or length changes, old vectors are excluded from comparison and re-embedded in the background. If the provider cannot describe itself, the plugin does not attach it and ranks by keyword. If an embed call fails, that search falls back to keyword ranking. **Rebuild vectors** runs a backfill immediately and reports how many memories still lack a current vector.

## Model-facing tools

Every tool resolves the project from the calling agent's session working directory. Writes are stamped `source: assistant`.

| Tool | Toolset | What it does |
| --- | --- | --- |
| `memory_search` | core | Ranked search by keyword and, with embeddings, by meaning. Default 8 results. |
| `memory_store` | core | Store a non-rule memory (`decision`, `architecture`, `devops`, `sprint`, `project_plan`, `developer_docs`, `feedback`, `reference`, `session`), priority 0–3. |
| `memory_recall` | core | Read one memory by id or exact title, and count the read. |
| `memory_rules` | core | Return the complete live rule set, agent-added rules labelled. |
| `memory_add_rule` | core | Add a `mandatory` or `forbidden` rule. |
| `memory_session_end` | core | File the summary against the caller's own open session. Any other `session_id` is refused. |
| `memory_list` | full | Filter and page memories by category, status, tags, or substring. |
| `memory_update` | full | Change title, content, tags, priority, or category. |
| `memory_archive` | full | Archive a memory, with an optional reason recorded in history. |
| `memory_provenance` | full | Read the last 25 history entries of one memory. |

No tool hard-deletes a memory or restores an archived one; those actions are only available in the Memory tab.

## RPC

The browser half calls a Typert remote namespace named `memory`. The contract is generated into `generated/` and ships in the bundle. Every endpoint takes an optional `project` (an absolute directory; when omitted, the host process's working directory is used) and returns either `{ ok: true, … }` or `{ ok: false, code: 'invalid' | 'not-found' | 'unavailable', message }`.

| Endpoint | Purpose |
| --- | --- |
| `describe` | Counts, embedding status, live rules, the rendered rule block, and the toolset in force. |
| `list` | Filtered, sorted, paged listing. |
| `search` | Ranked search. |
| `create`, `update` | Write as the user. |
| `discard` | Archive (`hard: false`) or permanently delete (`hard: true`). |
| `sessions` | The last 50 sessions. |
| `provenance` | The last 100 history entries of one memory. |
| `importInstructions` | Parse and import a Markdown instructions file. |
| `exportAll` | All memories as JSON text. |
| `reembed` | Run an embedding backfill now. |

## Data and storage

- **Location:** `<project>/.dsh/memory.db`, where `<project>` is the session's working directory. The `.dsh` directory is created with mode `0700`.
- **Commit or ignore it:** it is an ordinary file. Commit it to share rules with a team, or add it to `.gitignore`.
- **Layout:** version 1, stored in a `meta` table. A file with any other version is refused with a message; there are no migrations.
- **Tables and views:** `memories`, `sessions`, `provenance`, `meta`, plus two views for reading by hand:

```bash
duckdb .dsh/memory.db "select kind, title, content from rules"
duckdb .dsh/memory.db "select category, title, source, updated, expires from memory"
```

- **Locking:** DuckDB takes an exclusive lock on the file. While `dsh` holds a project open, another process (a second `dsh`, or the `duckdb` shell) cannot open it and gets a "locked by another process" error. Stop `dsh` before querying by hand.
- **One open per file, per process:** a process opens each database file once, whatever path spelling or plugin reload reaches it. An earlier bug that opened the same file twice in one process and corrupted it is fixed. Do not run two `dsh` servers against the same `$DSH_HOME`.
- **Transactions:** each write, its authorship check, and its audit entry run in one transaction, so an edit is always applied to the row as it currently is.
- **Backups:** stop `dsh` and copy `.dsh/memory.db`, or use **Export JSON** for a readable copy you cannot re-import.

## Security and trust model

A rule is repeated to the model on every request, so the plugin limits who can change the rule set:

- **User rules are the user's.** A rule written in the Memory tab or imported from a file can only be edited, archived, or deleted from the Memory tab. A tool call that tries is refused with a message saying so. An agent also cannot turn a user-written memory into a rule.
- **Agents can add rules and manage their own.** With `toolset: full`, an agent can edit or archive rules that an agent added. It can also edit or archive any non-rule memory, including ones you wrote.
- **Agent rule caps:** a rule an agent writes is at most 4,000 characters, and a project holds at most 100 live agent-added rules. The user's rules count toward neither limit.
- **Subagents cannot change rules at all.** They can search, store non-rule memories, and read rules.
- **Sessions are per agent.** `memory_session_end` closes only the calling agent's own open session. A `session_id` naming another agent's session, a session opened by another process or an earlier run, or one that already ended is refused. Such an open session is closed as an orphan at the next session start.
- **Authorship is the `source` column.** Only the exact value `assistant` counts as agent-written. Anyone who can write the DuckDB file can change it.
- **Credentials** for embeddings are referenced by name (`apiKeyEnv`) and never stored in the database or shown in the UI.

## Known limitations

- **The RPC accepts any project path.** Any authenticated Web Client caller can name any absolute directory as `project`. The plugin then creates `.dsh/memory.db` there and reads or writes it.
- **`memory_rules` output is not capped.** Unlike the injected block, it returns every rule in full.
- **Changing retention does not recompute existing expiry dates.** New values apply when a memory is created, or when its category or priority changes, or when it is restored.
- **Single writer per file.** See [Locking](#data-and-storage).

## Development

The `devDependencies` link a `deepseek-harness` checkout at `../../deepseek-harness`, relative to this repository, for types and tests. `pnpm install` expects it there.

```bash
pnpm install
pnpm run typecheck
pnpm test             # checks generated/ against src/host, then runs vitest
pnpm run build        # writes generated/, then tsc, then tsdown
```

`generated/` holds the Typert RPC contract, rendered from `scripts/typert-endpoints.mjs`. `pnpm test` (`scripts/check-typert.mjs`) fails when `src/host/index.ts`, `src/host/types.ts`, the endpoint table, or the renderer changed since the contract was last recorded, or when a file under `generated/` differs from what the table renders. After updating the table to match `src/host/`, run:

```bash
pnpm run regen:typert
```

`build` writes `generated/` but does not record the fingerprint; only `regen:typert` does.

To run a checkout in a local profile, add it by path and restart the web server:

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-memory
dsh web
```

A linked package resolves its imports from its own directory, so the harness packages it imports must resolve there to the same copies the running harness uses. The maintainers' workspace does this with `publish-plugins.sh` and `.dsh-compat/install-plugins.sh` in the parent `dsh-plugins` directory, not in this repository. After a rebuild, restart `dsh web`.

## License

MIT
