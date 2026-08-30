/**
 * The Sessions pane: what the project remembers about how it has been worked on.
 *
 * A session row is the summary the next session opens with, so this is where a person checks whether
 * that hand-off actually happened — an open row with no summary means an agent stopped without
 * filing one, which is worth seeing rather than discovering next session.
 *
 * @module @achasoft/dsh-memory/client/SessionsView
 */

import { useCallback } from 'react'
import type { MemorySessionView } from '../host/types.ts'
import type { MemoryScreenProps } from './contract.ts'
import { formatWhen } from './format.ts'
import { Alert } from './ui/index.ts'
import { cx } from './cx.ts'
import { useAsync } from './useAsync.ts'
import css from './MemoryScreen.module.css'

/** Everything the sessions pane needs beyond the screen's own props. */
export interface SessionsViewProps extends MemoryScreenProps {
  /** The project directory being read; the refetch key, not a request argument. */
  readonly projectRoot: string | undefined
  /** Bumped by the screen to refetch without changing a filter. */
  readonly revision: number
}

/**
 * The sessions pane.
 * @param props - the screen's props plus the project and refresh revision.
 * @returns the session rows.
 * @see {@link SessionsViewProps}
 */
export function SessionsView(props: SessionsViewProps) {
  const { t, projectRoot, revision } = props
  const read = useCallback(async (): Promise<readonly MemorySessionView[]> => {
    const result = await props.sessions()
    if (!result.ok) throw new Error(result.message)
    return result.sessions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessions, projectRoot])
  const state = useAsync(read, [projectRoot, revision])

  if (state.kind === 'loading') return <p className={css.state}>{t('manager.loading')}</p>
  if (state.kind === 'failed') return <Alert tone="error">{state.message}</Alert>
  if (state.value.length === 0) return <p className={css.state}>{t('sessions.empty')}</p>

  return (
    <div className={css.rows}>
      {state.value.map(session => (
        <article key={session.id} className={css.card}>
          <header className={css.cardHead}>
            <span className={cx(css.badge, session.endedAt === undefined && css.badgeRule)}>
              {session.endedAt === undefined ? t('sessions.open') : formatWhen(session.endedAt)}
            </span>
            <h3 className={css.cardTitle}>{formatWhen(session.startedAt)}</h3>
          </header>
          {session.summary !== undefined && <p className={css.cardBody}>{session.summary}</p>}
          <footer className={css.cardFoot}>
            <span className={css.meta}>{t('sessions.created', { count: String(session.memoriesCreated) })}</span>
            <span className={css.metaDot}>·</span>
            <span className={css.meta}>{t('sessions.accessed', { count: String(session.memoriesAccessed) })}</span>
          </footer>
        </article>
      ))}
    </div>
  )
}
