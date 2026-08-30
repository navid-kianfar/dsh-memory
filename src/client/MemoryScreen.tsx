/**
 * The Memory view: one `conversation.view` entry holding the whole surface.
 *
 * It sits in the view ring beside Chat and any other tab a deployment composes, so it occupies the
 * whole centre column and the shipped tab strip switches to it with no navigation of our own. That
 * is also what makes it a view of THIS session's project: the tab is session-scoped, so the memory
 * on screen is the memory the conversation beside it is bound by, with no picker to keep in sync.
 *
 * @module @achasoft/dsh-memory/client/MemoryScreen
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryCategoryWire, MemoryStatusWire, MemoryView } from '../host/types.ts'
import type { MemoryPane } from './controller.ts'
import type { MemoryScreenProps } from './contract.ts'
import { CATEGORY_ORDER, categoryLabel, isRule } from './format.ts'
import { MemoryDialog, type EditorDraft } from './MemoryDialog.tsx'
import { MemoryList } from './MemoryList.tsx'
import { RulesView } from './RulesView.tsx'
import { SessionsView } from './SessionsView.tsx'
import { resolveProjectRoot } from './project.ts'
import { Alert, ConfirmDialog, fields, type ConfirmRequest } from './ui/index.ts'
import { cx } from './cx.ts'
import { useAsync } from './useAsync.ts'
import css from './MemoryScreen.module.css'

/** How long an informational notice stays before it withdraws itself. */
const NOTICE_MS = 6_000

/** The panes, in the order the view shows them. */
const PANES: readonly MemoryPane[] = ['memories', 'rules', 'sessions']

/**
 * The Memory view.
 * @param props - the standard kit plus this plugin's face.
 * @returns the screen.
 * @see {@link MemoryScreenProps}
 */
export function MemoryScreen(props: MemoryScreenProps) {
  const { t, sessionId, useManager, useSessions, useWorkspaces } = props
  const pane = useManager(state => state.pane)
  const editor = useManager(state => state.editor)
  const notice = useManager(state => state.notice)
  const revision = useManager(state => state.revision)
  const tracing = useManager(state => state.tracing)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)

  const { describe, create, update, discard, importInstructions, exportAll, reembed } = props
  const { refresh, setPane, compose, edit, closeEditor, toggleTrace, dismissNotice, notify } = props
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null)
  const [knownTags, setKnownTags] = useState<readonly string[]>([])

  // The project of the session this tab belongs to. The injected endpoints resolve the same thing
  // from the same snapshots at call time; this copy is the refetch key, so a session whose working
  // directory arrives late re-reads rather than showing another project's memory.
  const projectRoot = resolveProjectRoot(sessions, workspaces, sessionId)

  const overview = useAsync(
    async () => {
      const result = await describe()
      if (!result.ok) throw new Error(result.message)
      return result.overview
    },
    [projectRoot, revision],
  )

  useEffect(() => {
    // An error stays until it is dismissed: a failure that withdraws itself is a failure nobody read.
    if (notice === undefined || notice.tone === 'error') return
    const timer = setTimeout(() => { dismissNotice(notice.id) }, NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [notice, dismissNotice])

  /**
   * Fold tags the screen has just read into the set the dialog completes from.
   *
   * The Host has no tag catalogue endpoint, so the suggestions are what this session has actually
   * seen — the rules in the overview and every row the listing has loaded. It grows as you browse,
   * which is exactly when a completion becomes useful.
   */
  const noteTags = useCallback((memories: readonly MemoryView[]): void => {
    setKnownTags((current) => {
      const merged = new Set(current)
      const before = merged.size
      for (const memory of memories) for (const tag of memory.tags) merged.add(tag)
      return merged.size === before ? current : [...merged].sort((a, b) => a.localeCompare(b))
    })
  }, [])

  useEffect(() => {
    if (overview.kind !== 'loaded') return
    noteTags([...overview.value.mandatory, ...overview.value.forbidden])
  }, [overview, noteTags])

  const save = useCallback(async (draft: EditorDraft): Promise<string | undefined> => {
    const shared = {
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
  }, [create, update, editor, closeEditor, refresh, notify, t])

  const archiveOrRestore = useCallback(async (memory: MemoryView): Promise<void> => {
    const restoring = memory.status !== 'active'
    const result = restoring
      ? await update({ id: memory.id, status: 'active' })
      : await discard(memory.id, false)
    if ('error' in result) { notify('error', result.error); return }
    if ('ok' in result && !result.ok) { notify('error', result.message); return }
    refresh()
    notify('info', t(restoring ? 'notice.restored' : 'notice.archived', { title: memory.title }))
    if (result.rulesChanged) notify('info', t('notice.rulesChanged'))
  }, [refresh, notify, discard, t, update])

  const destroy = useCallback(async (memory: MemoryView): Promise<void> => {
    const result = await discard(memory.id, true)
    if ('error' in result) { notify('error', result.error); return }
    refresh()
    notify('info', t('notice.deleted', { title: memory.title }))
    if (result.rulesChanged) notify('info', t('notice.rulesChanged'))
  }, [refresh, notify, discard, t])

  // A permanent delete takes the audit trail with it, so it is the one action the view confirms.
  const askDestroy = useCallback((memory: MemoryView): void => {
    setConfirming({
      title: t('card.delete'),
      description: t('card.deleteConfirm', { title: memory.title }),
      confirmLabel: t('card.deleteConfirmAction'),
      onConfirm: () => { void destroy(memory) },
    })
  }, [destroy, t])

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
    () => CATEGORY_ORDER.map(category => ({
      category,
      label: categoryLabel(t, category),
      ...isRule(category) ? { tone: 'warn' as const } : {},
    })),
    [t],
  )

  const semantic = overview.kind === 'loaded' && overview.value.embedding.ready

  return (
    // `data-conversation-composer-overlay`: the shell's own opt-in for a view that owns the whole
    // column and its own scroller, with the input card floating above it. Without it the view grows
    // inside the transcript's scroller and this screen's toolbar would scroll away with its content.
    <div className={cx(fields.fields, css.screen)} data-conversation-composer-overlay="">
      <header className={css.toolbar}>
        <nav className={css.panes} role="tablist" aria-label={t('view.memory')}>
          {PANES.map(entry => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={pane === entry}
              className={cx(css.pane, pane === entry && css.paneActive)}
              onClick={() => { setPane(entry) }}
            >
              {t(`tab.${entry}` as Parameters<typeof t>[0])}
              {entry === 'rules' && overview.kind === 'loaded' && (
                <span className={css.paneCount}>
                  {overview.value.mandatory.length + overview.value.forbidden.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <span className={css.fill} />

        {overview.kind === 'loaded' && (
          <span className={cx(css.pill, overview.value.enforcing ? css.pillOk : css.pillMuted)}>
            {t(overview.value.enforcing ? 'manager.enforcing' : 'manager.notEnforcing')}
          </span>
        )}
        <Button
          variant="toolbar"
          size="sm"
          aria-label={t('manager.refresh')}
          title={t('manager.refresh')}
          icon={<IconRefreshOutline16 size={14} />}
          onClick={() => { refresh() }}
        />
        <Button variant="ghost" size="sm" disabled={busy} onClick={runImport}>
          {t('action.import')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          icon={<IconDownloadOutline16 size={14} />}
          onClick={runExport}
        >
          {t('action.export')}
        </Button>
        {overview.kind === 'loaded' && overview.value.embedding.available && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            icon={<IconSparkle16 size={14} />}
            onClick={runReembed}
          >
            {t('action.reembed')}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlusOutline16 size={14} />}
          onClick={() => { compose(pane === 'rules' ? 'mandatory_rules' : 'decision') }}
        >
          {t(pane === 'rules' ? 'action.newRule' : 'action.new')}
        </Button>
      </header>

      {overview.kind === 'loaded' && (
        <div className={css.statusbar}>
          <span className={css.statusPath}>
            {t('manager.database', { path: overview.value.databasePath })}
          </span>
          <span className={css.fill} />
          <span className={css.statusStat}>
            {t('settings.stats', {
              active: String(overview.value.stats.active),
              embedded: String(overview.value.stats.embedded),
            })}
          </span>
          <span className={cx(css.pill, semantic ? css.pillOk : css.pillMuted)}>
            <IconSearchOutline16 size={12} />
            {t(semantic ? 'search.semantic' : 'search.lexical')}
          </span>
        </div>
      )}

      {notice !== undefined && (
        <Alert
          tone={notice.tone}
          className={css.notice}
          dismissLabel={t('alert.dismiss')}
          onDismiss={() => { dismissNotice(notice.id) }}
        >
          {notice.text}
        </Alert>
      )}

      <div className={css.body}>
        {overview.kind === 'loading' && <p className={css.state}>{t('manager.loading')}</p>}
        {overview.kind === 'failed' && (
          <div className={css.state}>
            <Alert tone="error">{overview.message}</Alert>
            <Button variant="outline" size="sm" onClick={() => { refresh() }}>
              {t('manager.retry')}
            </Button>
          </div>
        )}
        {overview.kind === 'loaded' && (
          <>
            {pane === 'memories' && (
              <MemoryList
                {...props}
                projectRoot={projectRoot}
                categories={categories}
                semantic={semantic}
                onSeen={noteTags}
                onEdit={memory => { edit(memory) }}
                onArchiveOrRestore={memory => { void archiveOrRestore(memory) }}
                onDelete={askDestroy}
              />
            )}
            {pane === 'rules' && (
              <RulesView
                t={t}
                overview={overview.value}
                tracing={tracing}
                onToggleTrace={id => { toggleTrace(id) }}
                onEdit={memory => { edit(memory) }}
                onArchiveOrRestore={memory => { void archiveOrRestore(memory) }}
                onDelete={askDestroy}
                readTrace={id => readTrace(props, id)}
              />
            )}
            {pane === 'sessions' && (
              <SessionsView {...props} projectRoot={projectRoot} revision={revision} />
            )}
          </>
        )}
      </div>

      {editor.kind !== 'closed' && (
        <MemoryDialog
          // Keyed on what it opened for, so switching from one memory straight to another reseeds
          // the fields instead of leaving the first one's text in them.
          key={editor.kind === 'edit' ? editor.memory.id : `new:${editor.category}`}
          t={t}
          open
          memory={editor.kind === 'edit' ? editor.memory : undefined}
          initialCategory={editor.kind === 'create' ? editor.category : 'decision'}
          knownTags={knownTags}
          onSave={save}
          onCancel={() => { closeEditor() }}
        />
      )}

      <ConfirmDialog
        request={confirming}
        onClose={() => { setConfirming(null) }}
        cancelLabel={t('editor.cancel')}
        closeLabel={t('editor.cancel')}
      />
    </div>
  )
}

/**
 * Read one memory's audit trail, unwrapping the returned failure into a rejection.
 * @param props - the screen's props, carrying the endpoint.
 * @param id - the memory to trace.
 * @returns the entries, newest first.
 */
async function readTrace(
  props: MemoryScreenProps, id: string,
): Promise<readonly import('../host/types.ts').MemoryProvenanceView[]> {
  const result = await props.provenance(id)
  if (!result.ok) throw new Error(result.message)
  return result.entries
}

export type { MemoryCategoryWire, MemoryStatusWire }
