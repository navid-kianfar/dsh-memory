/**
 * One memory, as a row in the Memory view.
 *
 * The card carries what a person needs to decide whether this memory is still true — its category,
 * its age, when it expires, how often it has been useful — and the verbs that act on that decision.
 * Its audit trail expands in place rather than in a dialog, because "how did this get here" is a
 * question about the row you are already looking at.
 *
 * The verbs live in one overflow menu rather than a row of four icons. Three of them are rare and
 * one is destructive, and a delete sitting permanently one pixel from an edit is a delete waiting to
 * be misclicked; the history toggle stays outside the menu because it acts on this card in place.
 *
 * @module @achasoft/dsh-memory/client/MemoryCard
 */

import { useState } from 'react'
import {
  IconArchiveOutline20, IconChevronDownOutline14, IconEditOutline16, IconEllipsisOutline16,
  IconRefreshOutline14, IconTrashOutline16, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryProvenanceView, MemoryView } from '../host/types.ts'
import { categoryLabel, formatDate, formatWhen, isAgentAuthored, isRule } from './format.ts'
import { cx } from './cx.ts'
import { useAsync } from './useAsync.ts'
import css from './MemoryScreen.module.css'

/** Past this many characters the body is clamped and offers to unfold. */
const CLAMP_CHARS = 320

/** Everything one card needs. */
export interface MemoryCardProps {
  readonly t: TranslateNS<'memory'>
  readonly memory: MemoryView
  /** The blended match score, when this card is a search result rather than a listing row. */
  readonly score?: number
  /** Whether this card's audit trail is expanded. */
  readonly tracing: boolean
  /** Expand or collapse this card's audit trail. */
  readonly onToggleTrace: () => void
  /** Open the dialog on this memory. */
  readonly onEdit: () => void
  /** Archive it, or restore it when it is already archived. */
  readonly onArchiveOrRestore: () => void
  /** Remove it and its audit trail permanently. */
  readonly onDelete: () => void
  /**
   * Read this memory's audit trail; called only while the trail is expanded.
   * @param signal - cancellation for the read.
   * @returns the entries, newest first.
   */
  readonly readTrace: (signal: AbortSignal) => Promise<readonly MemoryProvenanceView[]>
}

/**
 * One memory row, with its verbs and its expandable history.
 * @param props - the memory and the four verbs.
 * @returns the card.
 * @see {@link MemoryCardProps}
 */
export function MemoryCard(props: MemoryCardProps) {
  const { t, memory, score, tracing, onToggleTrace, onEdit, onArchiveOrRestore, onDelete, readTrace } = props
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const trace = useAsync(readTrace, [memory.id], tracing)
  const archived = memory.status !== 'active'
  const long = memory.content.length > CLAMP_CHARS

  const items: readonly MenuEntry[] = [
    { id: 'edit', label: t('card.edit'), icon: <IconEditOutline16 size={14} /> },
    archived
      ? { id: 'restore', label: t('card.restore'), icon: <IconRefreshOutline14 size={14} /> }
      : { id: 'archive', label: t('card.archive'), icon: <IconArchiveOutline20 size={14} /> },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('card.delete'), icon: <IconTrashOutline16 size={14} />, danger: true },
  ]

  /**
   * Route a menu selection to its verb.
   * @param id - the selected row's id.
   */
  function select(id: string): void {
    setMenuOpen(false)
    if (id === 'edit') onEdit()
    else if (id === 'archive' || id === 'restore') onArchiveOrRestore()
    else if (id === 'delete') onDelete()
  }

  return (
    <article className={cx(css.card, archived && css.cardArchived, isRule(memory.category) && css.cardRule)}>
      <header className={css.cardHead}>
        <span className={cx(css.badge, isRule(memory.category) && css.badgeRule)}>
          {categoryLabel(t, memory.category)}
        </span>
        {/* A rule an agent recorded binds like the user's own, so the user has to be able to tell
            them apart at a glance — the same distinction the injected block makes for the model. */}
        {isRule(memory.category) && isAgentAuthored(memory) && (
          <span className={cx(css.badge, css.badgeAgent)} title={t('card.agentAuthoredHint')}>
            {t('card.agentAuthored')}
          </span>
        )}
        <h3 className={css.cardTitle}>{memory.title}</h3>
        {score !== undefined && (
          <span className={css.score}>{t('card.match', { score: score.toFixed(2) })}</span>
        )}
        <Menu
          open={menuOpen}
          portal
          align="end"
          items={items}
          onSelect={select}
          onClose={() => { setMenuOpen(false) }}
          anchor={
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('card.menu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconEllipsisOutline16 size={14} />
            </button>
          }
        />
      </header>

      <p className={cx(css.cardBody, long && !expanded && css.cardBodyClamped)}>{memory.content}</p>
      {long && (
        <button type="button" className={css.linkButton} onClick={() => { setExpanded(!expanded) }}>
          {expanded ? t('rules.hidePreview') : t('rules.showPreview')}
        </button>
      )}

      {memory.tags.length > 0 && (
        <ul className={css.tags}>
          {memory.tags.map(tag => <li key={tag} className={css.tag}>{tag}</li>)}
        </ul>
      )}

      <footer className={css.cardFoot}>
        <span className={css.meta}>{formatWhen(memory.updatedAt)}</span>
        <span className={css.metaDot}>·</span>
        <span className={css.meta}>
          {memory.expiresAt === undefined ? t('card.never') : t('card.expires', { date: formatDate(memory.expiresAt) })}
        </span>
        {memory.accessCount > 0 && (
          <>
            <span className={css.metaDot}>·</span>
            <span className={css.meta}>{t('card.reads', { count: String(memory.accessCount) })}</span>
          </>
        )}
        <span className={css.metaDot}>·</span>
        <span className={cx(css.meta, memory.embedded ? css.metaOk : undefined)}>
          {memory.embedded ? t('card.embedded') : t('card.notEmbedded')}
        </span>

        <span className={css.cardActions}>
          <button
            type="button"
            className={cx(css.iconButton, tracing && css.iconButtonOn)}
            title={t('card.trace')}
            aria-label={t('card.trace')}
            aria-expanded={tracing}
            onClick={onToggleTrace}
          >
            <IconChevronDownOutline14 />
          </button>
        </span>
      </footer>

      {tracing && (
        <div className={css.trace}>
          {trace.kind === 'loading' && <p className={css.traceEmpty}>{t('manager.loading')}</p>}
          {trace.kind === 'failed' && <p className={css.traceEmpty}>{trace.message}</p>}
          {trace.kind === 'loaded' && trace.value.length === 0 && (
            <p className={css.traceEmpty}>{t('trace.empty')}</p>
          )}
          {trace.kind === 'loaded' && trace.value.length > 0 && (
            <ul className={css.traceList}>
              {trace.value.map(entry => (
                <li key={entry.seq} className={css.traceRow}>
                  <span className={css.traceWhen}>{formatWhen(entry.at)}</span>
                  <span className={css.traceWhat}>{traceLabel(t, entry.operation)}</span>
                  <span className={css.traceWho}>{entry.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * The translated name of an audit operation.
 *
 * An operation the dictionary does not know renders verbatim rather than as a missing-key marker:
 * the audit trail is a record, and showing the raw word is more honest than hiding the entry.
 * @param t - the namespace-bound translate.
 * @param operation - the recorded operation.
 * @returns the display label.
 */
function traceLabel(t: TranslateNS<'memory'>, operation: string): string {
  const known = ['create', 'update', 'access', 'archive', 'restore', 'delete', 'import', 'expire']
  return known.includes(operation) ? t(`trace.${operation}` as Parameters<typeof t>[0]) : operation
}
