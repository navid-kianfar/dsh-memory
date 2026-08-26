/**
 * The memory manager: one `shell.overlay` entry holding the whole surface.
 *
 * `shell.overlay` is a click-through layer, so this entry renders nothing at all while the manager
 * is closed and opts into pointer events only on the panel itself. The panel is a full-height sheet
 * over the centre and right columns rather than a modal over everything — the sidebar stays usable
 * beside it, so switching workspace with the manager open is one click rather than close-switch-open.
 *
 * @module @achasoft/dsh-memory/client/MemoryManager
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconCloseOutline16, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline16,
  IconSearchOutline16, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'
import type { MemoryManagerProps } from './contract.ts'
import { CATEGORY_ORDER, categoryLabel } from './format.ts'
import { MemoryEditor, type EditorDraft } from './MemoryEditor.tsx'
import { MemoryList } from './MemoryList.tsx'
import { RulesView } from './RulesView.tsx'
import { SessionsView } from './SessionsView.tsx'
import { resolveProjectRoot } from './project.ts'
import { cx } from './cx.ts'
import { useAsync } from './useAsync.ts'
import css from './MemoryManager.module.css'

/** How long a notice stays before it withdraws itself. */
const NOTICE_MS = 6_000

/** The tabs, in the order the manager shows them. */
const TABS = ['memories', 'rules', 'sessions'] as const

/**
 * The manager overlay.
 * @param props - the standard kit plus this plugin's face.
 * @returns the panel, or null while the manager is closed.
 * @see {@link MemoryManagerProps}
 */
export function MemoryManager(props: MemoryManagerProps) {
  const { t, useManager, useSessions, useWorkspaces } = props
  const open = useManager(state => state.open)
  const tab = useManager(state => state.tab)
  const editor = useManager(state => state.editor)
  const notice = useManager(state => state.notice)
  const revision = useManager(state => state.revision)
  const pinned = useManager(state => state.projectRoot)
  const tracing = useManager(state => state.tracing)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)

  const { describe, create, update, discard, importInstructions, exportAll, reembed } = props
  const { close, refresh, setTab, compose, edit, closeEditor, toggleTrace, dismissNotice, notify } = props
  const [busy, setBusy] = useState(false)

  // The manager pins the project it was opened on: switching session while it is open would
  // otherwise swap the memory out from under an edit in progress.
  const projectRoot = pinned ?? resolveProjectRoot(sessions, workspaces)

  const overview = useAsync(
    async () => {
      const result = await describe()
      if (!result.ok) throw new Error(result.message)
      return result.overview
    },
    [projectRoot, revision],
    open,
  )

  // Escape closes the manager, but only from the panel itself: a global listener would steal the key
  // from the composer while the manager sits open beside it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && editor.kind === 'closed') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, editor.kind, close])

  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => { dismissNotice(notice.id) }, NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [notice, dismissNotice])

  const save = useCallback(async (draft: EditorDraft): Promise<string | undefined> => {
    const shared = {
      ...projectRoot === undefined ? {} : { project: projectRoot },
      category: draft.category,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      priority: draft.priority,
      metadataJson: draft.metadataJson,
    }
    const result = editor.kind === 'edit'
      ? await update({ ...shared, id: editor.memory.id })
      : await create(shared)
    if (!result.ok) return result.message
    closeEditor()
    refresh()
    notify('info', t(editor.kind === 'edit' ? 'notice.updated' : 'notice.created', { title: draft.title }))
    if (result.rulesChanged) notify('info', t('notice.rulesChanged'))
    return undefined
  }, [create, update, editor, closeEditor, refresh, notify, projectRoot, t])

  const archiveOrRestore = useCallback(async (memory: MemoryView): Promise<void> => {
    const restoring = memory.status !== 'active'
    const result = restoring
      ? await update({
        ...projectRoot === undefined ? {} : { project: projectRoot },
        id: memory.id,
        status: 'active',
      })
      : await discard(memory.id, false)
    if ('error' in result) { notify('error', result.error); return }
    if ('ok' in result && !result.ok) { notify('error', result.message); return }
    refresh()
    notify('info', t(restoring ? 'notice.restored' : 'notice.archived', { title: memory.title }))
    if (result.rulesChanged) notify('info', t('notice.rulesChanged'))
  }, [refresh, notify, projectRoot, discard, t, update])

  const destroy = useCallback(async (memory: MemoryView): Promise<void> => {
    // A permanent delete takes the audit trail with it, so it is the one action the manager confirms.
    if (!globalThis.confirm(t('card.deleteConfirm', { title: memory.title }))) return
    const result = await discard(memory.id, true)
    if ('error' in result) { notify('error', result.error); return }
    refresh()
    notify('info', t('notice.deleted', { title: memory.title }))
    if (result.rulesChanged) notify('info', t('notice.rulesChanged'))
  }, [refresh, notify, discard, t])

  const runImport = useCallback((): void => {
    const picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = '.md,.markdown,.txt'
    picker.addEventListener('change', () => {
      const file = picker.files?.[0]
      if (file === undefined) return
      setBusy(true)
      void file.text()
        .then(text => importInstructions(text, file.name))
        .then((result) => {
          if (!result.ok) { notify('error', result.message); return }
          refresh()
          notify('info', t('notice.imported', {
            count: String(result.imported), rules: String(result.rules),
          }))
        })
        .finally(() => { setBusy(false) })
    })
    picker.click()
  }, [importInstructions, refresh, notify, t])

  const runExport = useCallback((): void => {
    setBusy(true)
    void exportAll().then((result) => {
      setBusy(false)
      if (!result.ok) { notify('error', result.message); return }
      // A download is the one way the export leaves the browser; the panel has no filesystem of its
      // own, and putting a JSON document into the clipboard silently is worse than a named file.
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${overview.kind === 'loaded' ? overview.value.project : 'memory'}-memory.json`
      link.click()
      URL.revokeObjectURL(url)
      notify('info', t('notice.exported', { count: String(result.count) }))
    })
  }, [exportAll, notify, overview, t])

  const runReembed = useCallback((): void => {
    setBusy(true)
    void reembed().then((result) => {
      setBusy(false)
      if (!result.ok) { notify('error', result.message); return }
      refresh()
      notify('info', t('notice.embedded', {
        count: String(result.embedded), remaining: String(result.remaining),
      }))
    })
  }, [reembed, refresh, notify, t])

  const categories = useMemo(
    () => CATEGORY_ORDER.map(category => ({ category, label: categoryLabel(t, category) })),
    [t],
  )

  if (!open) return null

  const semantic = overview.kind === 'loaded' && overview.value.embedding.ready

  return (
    <div className={css.sheet} role="dialog" aria-label={t('manager.title')} data-memory-manager>
      <header className={css.header}>
        <div className={css.headerMain}>
          <h2 className={css.heading}>{t('manager.title')}</h2>
          {overview.kind === 'loaded' && (
            <>
              <span className={css.project}>{overview.value.project}</span>
              <span className={cx(css.pill, overview.value.enforcing ? css.pillOk : css.pillMuted)}>
                {t(overview.value.enforcing ? 'manager.enforcing' : 'manager.notEnforcing')}
              </span>
            </>
          )}
        </div>
        <div className={css.headerActions}>
          <button
            type="button"
            className={css.iconButton}
            title={t('manager.refresh')}
            aria-label={t('manager.refresh')}
            onClick={() => { refresh() }}
          >
            <IconRefreshOutline16 />
          </button>
          <button
            type="button"
            className={css.iconButton}
            title={t('manager.close')}
            aria-label={t('manager.close')}
            onClick={() => { close() }}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      </header>

      <nav className={css.tabs} role="tablist">
        {TABS.map(entry => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            className={cx(css.tab, tab === entry && css.tabActive)}
            onClick={() => { setTab(entry) }}
          >
            {t(`tab.${entry}` as Parameters<typeof t>[0])}
            {entry === 'rules' && overview.kind === 'loaded' && (
              <span className={css.tabCount}>
                {overview.value.mandatory.length + overview.value.forbidden.length}
              </span>
            )}
          </button>
        ))}
        <span className={css.tabsFill} />
        <button
          type="button"
          className={css.buttonGhost}
          disabled={busy}
          onClick={runImport}
        >
          {t('action.import')}
        </button>
        <button type="button" className={css.buttonGhost} disabled={busy} onClick={runExport}>
          <IconDownloadOutline16 />
          {t('action.export')}
        </button>
        {overview.kind === 'loaded' && overview.value.embedding.available && (
          <button type="button" className={css.buttonGhost} disabled={busy} onClick={runReembed}>
            <IconSparkle16 />
            {t('action.reembed')}
          </button>
        )}
        <button
          type="button"
          className={css.buttonPrimary}
          onClick={() => { compose(tab === 'rules' ? 'mandatory_rules' : 'decision') }}
        >
          <IconPlusOutline16 />
          {t(tab === 'rules' ? 'action.newRule' : 'action.new')}
        </button>
      </nav>

      {notice !== undefined && (
        <p className={cx(css.notice, notice.tone === 'error' && css.noticeError)}>{notice.text}</p>
      )}

      <div className={css.body}>
        {overview.kind === 'loading' && <p className={css.state}>{t('manager.loading')}</p>}
        {overview.kind === 'failed' && (
          <div className={css.state}>
            <p className={css.stateError}>{overview.message}</p>
            <button type="button" className={css.buttonGhost} onClick={() => { refresh() }}>
              {t('manager.retry')}
            </button>
          </div>
        )}
        {overview.kind === 'loaded' && (
          <>
            {editor.kind !== 'closed' && (
              <MemoryEditor
                t={t}
                memory={editor.kind === 'edit' ? editor.memory : undefined}
                initialCategory={editor.kind === 'create' ? editor.category : 'decision'}
                onSave={save}
                onCancel={() => { closeEditor() }}
              />
            )}
            {tab === 'memories' && (
              <MemoryList
                {...props}
                projectRoot={projectRoot}
                categories={categories}
                semantic={semantic}
                onEdit={memory => { edit(memory) }}
                onArchiveOrRestore={memory => { void archiveOrRestore(memory) }}
                onDelete={memory => { void destroy(memory) }}
              />
            )}
            {tab === 'rules' && (
              <RulesView
                t={t}
                overview={overview.value}
                tracing={tracing}
                onToggleTrace={id => { toggleTrace(id) }}
                onEdit={memory => { edit(memory) }}
                onArchiveOrRestore={memory => { void archiveOrRestore(memory) }}
                onDelete={memory => { void destroy(memory) }}
                readTrace={id => readTrace(props, id)}
              />
            )}
            {tab === 'sessions' && <SessionsView {...props} projectRoot={projectRoot} revision={revision} />}
          </>
        )}
      </div>

      {overview.kind === 'loaded' && (
        <footer className={css.footer}>
          <span className={css.footerPath}>{t('manager.database', { path: overview.value.databasePath })}</span>
          <span className={css.footerFill} />
          <span className={css.footerStat}>
            {t('settings.stats', {
              active: String(overview.value.stats.active),
              embedded: String(overview.value.stats.embedded),
            })}
          </span>
          <span className={cx(css.pill, semantic ? css.pillOk : css.pillMuted)}>
            <IconSearchOutline16 size={12} />
            {t(semantic ? 'search.semantic' : 'search.lexical')}
          </span>
        </footer>
      )}
    </div>
  )
}

/**
 * Read one memory's audit trail, unwrapping the returned failure into a rejection.
 * @param props - the manager's props, carrying the endpoint.
 * @param id - the memory to trace.
 * @returns the entries, newest first.
 */
async function readTrace(
  props: MemoryManagerProps, id: string,
): Promise<readonly import('../host/types.ts').MemoryProvenanceView[]> {
  const result = await props.provenance(id)
  if (!result.ok) throw new Error(result.message)
  return result.entries
}

export type { MemoryCategoryWire, MemoryStatusWire }
