/**
 * The Memories tab: the search box, the filters, and the rows they produce.
 *
 * One panel serves two readings of the same data. An empty search box lists the project's memories
 * filtered and sorted; typing switches to a ranked search over the same set. That is deliberate —
 * they answer different questions ("what is in here" and "what do we know about X") and splitting
 * them into two surfaces would make the second one somewhere you have to go rather than something
 * you start typing.
 *
 * @module @achasoft/dsh-memory/client/MemoryList
 */

import { useCallback, useState } from 'react'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'
import type { MemoryManagerProps } from './contract.ts'
import { MemoryCard } from './MemoryCard.tsx'
import { cx } from './cx.ts'
import { useAsync, useDebounced } from './useAsync.ts'
import css from './MemoryManager.module.css'

/** How long the search box must hold still before it spends a request. */
const SEARCH_DEBOUNCE_MS = 250

/** Rows one page of the listing carries. */
const PAGE_SIZE = 30

/** The lifecycle filters, in the order the panel offers them. */
const STATUSES: readonly (MemoryStatusWire | 'all')[] = ['active', 'archived', 'expired', 'all']

/** Everything the memories tab needs beyond the manager's own props. */
export interface MemoryListProps extends MemoryManagerProps {
  /** The project directory being managed; absent uses the Host's default. */
  readonly projectRoot: string | undefined
  /** Every category with its translated name, for the filter. */
  readonly categories: readonly { readonly category: MemoryCategoryWire, readonly label: string }[]
  /** Whether stored vectors participate, for the search box's mode badge. */
  readonly semantic: boolean
  /** Open the editor on one memory. */
  readonly onEdit: (memory: MemoryView) => void
  /** Archive one memory, or restore it when it is already archived. */
  readonly onArchiveOrRestore: (memory: MemoryView) => void
  /** Remove one memory permanently. */
  readonly onDelete: (memory: MemoryView) => void
}

/** One rendered row: the memory, and its match score when it came from a search. */
interface Row {
  readonly memory: MemoryView
  readonly score?: number
}

/**
 * The memories tab.
 * @param props - the manager's props plus this panel's own.
 * @returns the search box, the filters, and the rows.
 * @see {@link MemoryListProps}
 */
export function MemoryList(props: MemoryListProps) {
  const { t, useManager, projectRoot, categories, semantic, onEdit, onArchiveOrRestore, onDelete } = props
  const { setQuery, setCategory, setStatus, toggleTrace } = props
  const query = useManager(state => state.query)
  const category = useManager(state => state.category)
  const status = useManager(state => state.status)
  const tracing = useManager(state => state.tracing)
  const revision = useManager(state => state.revision)
  const [limit, setLimit] = useState(PAGE_SIZE)

  const settled = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS)
  const searching = settled.length > 0
  const project = projectRoot === undefined ? {} : { project: projectRoot }

  const read = useCallback(async (signal: AbortSignal): Promise<{ rows: Row[], total: number }> => {
    if (searching) {
      const result = await props.search({
        ...project, query: settled, limit,
        ...category === undefined ? {} : { category },
      }, signal)
      if (!result.ok) throw new Error(result.message)
      return {
        rows: result.hits.map(hit => ({ memory: hit.memory, score: hit.similarity })),
        total: result.total,
      }
    }
    const result = await props.list({
      ...project, status, limit, offset: 0,
      ...category === undefined ? {} : { category },
    })
    if (!result.ok) throw new Error(result.message)
    return { rows: result.memories.map(memory => ({ memory })), total: result.total }
    // `project` is derived from projectRoot each render; listing it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.search, props.list, projectRoot, settled, searching, category, status, limit])

  const state = useAsync(read, [projectRoot, settled, searching, category, status, limit, revision])

  const readTrace = useCallback(async (id: string) => {
    const result = await props.provenance(id)
    if (!result.ok) throw new Error(result.message)
    return result.entries
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provenance, projectRoot])

  const filtered = category !== undefined || (!searching && status !== 'active')

  return (
    <>
      <div className={css.controls}>
        <div className={css.searchBox}>
          <IconSearchOutline16 size={14} />
          <input
            className={css.searchInput}
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(PAGE_SIZE)
            }}
          />
          {query.length > 0 && (
            <button
              type="button"
              className={css.searchClear}
              aria-label={t('search.clear')}
              onClick={() => { setQuery('') }}
            >
              <IconCloseOutline16 size={12} />
            </button>
          )}
          <span className={cx(css.pill, semantic ? css.pillOk : css.pillMuted)}>
            {t(semantic ? 'search.semantic' : 'search.lexical')}
          </span>
        </div>

        <select
          className={css.select}
          value={category ?? ''}
          onChange={(event) => {
            setCategory(event.target.value === '' ? undefined : event.target.value as MemoryCategoryWire)
            setLimit(PAGE_SIZE)
          }}
        >
          <option value="">{t('filter.allCategories')}</option>
          {categories.map(entry => (
            <option key={entry.category} value={entry.category}>{entry.label}</option>
          ))}
        </select>

        {!searching && (
          <select
            className={css.select}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as MemoryStatusWire | 'all')
              setLimit(PAGE_SIZE)
            }}
          >
            {STATUSES.map(entry => (
              <option key={entry} value={entry}>
                {t(`filter.status.${entry}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
        )}
      </div>

      {state.kind === 'loading' && <p className={css.state}>{t('manager.loading')}</p>}
      {state.kind === 'failed' && <p className={cx(css.state, css.stateError)}>{state.message}</p>}
      {state.kind === 'loaded' && state.value.rows.length === 0 && (
        <p className={css.state}>
          {searching
            ? t('search.empty', { query: settled })
            : t(filtered ? 'list.emptyFiltered' : 'list.empty')}
        </p>
      )}
      {state.kind === 'loaded' && state.value.rows.length > 0 && (
        <>
          <p className={css.count}>
            {searching
              ? t('search.count', { count: String(state.value.total) })
              : t('list.count', { shown: String(state.value.rows.length), total: String(state.value.total) })}
          </p>
          <div className={css.rows}>
            {state.value.rows.map(row => (
              <MemoryCard
                key={row.memory.id}
                t={t}
                memory={row.memory}
                {...row.score === undefined ? {} : { score: row.score }}
                tracing={tracing === row.memory.id}
                onToggleTrace={() => { toggleTrace(row.memory.id) }}
                onEdit={() => { onEdit(row.memory) }}
                onArchiveOrRestore={() => { onArchiveOrRestore(row.memory) }}
                onDelete={() => { onDelete(row.memory) }}
                readTrace={() => readTrace(row.memory.id)}
              />
            ))}
          </div>
          {!searching && state.value.rows.length < state.value.total && (
            <button
              type="button"
              className={css.buttonGhost}
              onClick={() => { setLimit(limit + PAGE_SIZE) }}
            >
              {t('list.more')}
            </button>
          )}
        </>
      )}
    </>
  )
}
