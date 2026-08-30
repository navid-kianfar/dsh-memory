/**
 * The Memories pane: the search box, the filters, and the rows they produce.
 *
 * One panel serves two readings of the same data. An empty search box lists the project's memories
 * filtered and sorted; typing switches to a ranked search over the same set. That is deliberate —
 * they answer different questions ("what is in here" and "what do we know about X") and splitting
 * them into two surfaces would make the second one somewhere you have to go rather than something
 * you start typing.
 *
 * @module @achasoft/dsh-memory/client/MemoryList
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'
import type { MemoryScreenProps } from './contract.ts'
import { MemoryCard } from './MemoryCard.tsx'
import { Alert, Select, type SelectOption, type SelectTone } from './ui/index.ts'
import { cx } from './cx.ts'
import { useAsync, useDebounced } from './useAsync.ts'
import css from './MemoryScreen.module.css'

/** How long the search box must hold still before it spends a request. */
const SEARCH_DEBOUNCE_MS = 250

/** Rows one page of the listing carries. */
const PAGE_SIZE = 30

/** The lifecycle filters, in the order the panel offers them, with the tone each reads in. */
const STATUSES: readonly { readonly value: MemoryStatusWire | 'all', readonly tone?: SelectTone }[] = [
  { value: 'active', tone: 'success' },
  { value: 'archived', tone: 'muted' },
  { value: 'expired', tone: 'error' },
  { value: 'all' },
]

/** The category filter's own value domain: every category, plus the unrestricted row. */
const ALL_CATEGORIES = ''

/** Everything the memories pane needs beyond the screen's own props. */
export interface MemoryListProps extends MemoryScreenProps {
  /** The project directory being read; the refetch key, not a request argument. */
  readonly projectRoot: string | undefined
  /** Every category with its translated name and tone, for the filter. */
  readonly categories: readonly {
    readonly category: MemoryCategoryWire
    readonly label: string
    readonly tone?: SelectTone
  }[]
  /** Whether stored vectors participate, for the search box's mode badge. */
  readonly semantic: boolean
  /** Report the memories now on screen, so the dialog can complete from the tags they carry. */
  readonly onSeen: (memories: readonly MemoryView[]) => void
  /** Open the dialog on one memory. */
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
 * The memories pane.
 * @param props - the screen's props plus this panel's own.
 * @returns the search box, the filters, and the rows.
 * @see {@link MemoryListProps}
 */
export function MemoryList(props: MemoryListProps) {
  const { t, useManager, projectRoot, categories, semantic, onSeen } = props
  const { onEdit, onArchiveOrRestore, onDelete } = props
  const { setQuery, setCategory, setStatus, toggleTrace } = props
  const query = useManager(state => state.query)
  const category = useManager(state => state.category)
  const status = useManager(state => state.status)
  const tracing = useManager(state => state.tracing)
  const revision = useManager(state => state.revision)
  const [limit, setLimit] = useState(PAGE_SIZE)

  const settled = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS)
  const searching = settled.length > 0

  const read = useCallback(async (signal: AbortSignal): Promise<{ rows: Row[], total: number }> => {
    if (searching) {
      const result = await props.search({
        query: settled, limit,
        ...category === undefined ? {} : { category },
      }, signal)
      if (!result.ok) throw new Error(result.message)
      return {
        rows: result.hits.map(hit => ({ memory: hit.memory, score: hit.similarity })),
        total: result.total,
      }
    }
    const result = await props.list({
      status, limit, offset: 0,
      ...category === undefined ? {} : { category },
    })
    if (!result.ok) throw new Error(result.message)
    return { rows: result.memories.map(memory => ({ memory })), total: result.total }
    // `projectRoot` is not an argument — the injected endpoints bind it — but it IS an input: a
    // session that resolves its project late must re-read rather than keep another one's rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.search, props.list, projectRoot, settled, searching, category, status, limit])

  const state = useAsync(read, [projectRoot, settled, searching, category, status, limit, revision])

  useEffect(() => {
    if (state.kind !== 'loaded') return
    onSeen(state.value.rows.map(row => row.memory))
  }, [state, onSeen])

  const readTrace = useCallback(async (id: string) => {
    const result = await props.provenance(id)
    if (!result.ok) throw new Error(result.message)
    return result.entries
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.provenance, projectRoot])

  const filtered = category !== undefined || (!searching && status !== 'active')

  const categoryOptions: readonly SelectOption<string>[] = [
    { value: ALL_CATEGORIES, label: t('filter.allCategories') },
    ...categories.map(entry => ({
      value: entry.category as string,
      label: entry.label,
      ...entry.tone === undefined ? {} : { tone: entry.tone },
    })),
  ]
  const statusOptions: readonly SelectOption<MemoryStatusWire | 'all'>[] = STATUSES.map(entry => ({
    value: entry.value,
    label: t(`filter.status.${entry.value}` as Parameters<typeof t>[0]),
    ...entry.tone === undefined ? {} : { tone: entry.tone },
  }))

  return (
    <>
      <div className={css.controls}>
        <div className={css.search}>
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

        <Select
          className={css.filter}
          value={category ?? ALL_CATEGORIES}
          options={categoryOptions}
          label={t('filter.allCategories')}
          onChange={(next) => {
            setCategory(next === ALL_CATEGORIES ? undefined : next as MemoryCategoryWire)
            setLimit(PAGE_SIZE)
          }}
        />

        {/* A ranked search reads every lifecycle at once, so the filter would be a control that
            silently does nothing; it comes back the moment the search box is empty again. */}
        {!searching && (
          <Select
            className={css.filter}
            value={status}
            options={statusOptions}
            label={t('filter.status.all')}
            align="end"
            onChange={(next) => {
              setStatus(next)
              setLimit(PAGE_SIZE)
            }}
          />
        )}
      </div>

      {state.kind === 'loading' && <p className={css.state}>{t('manager.loading')}</p>}
      {state.kind === 'failed' && <Alert tone="error">{state.message}</Alert>}
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
            <Button variant="outline" size="sm" onClick={() => { setLimit(limit + PAGE_SIZE) }}>
              {t('list.more')}
            </Button>
          )}
        </>
      )}
    </>
  )
}
