/**
 * The Rules pane: what currently binds the model, in the two halves it binds by.
 *
 * The rule set arrives with the overview rather than through a read of its own, because it is the
 * same set the header's enforcement pill reports and two reads could disagree with each other on
 * screen. Below the two lists sits the block verbatim — the exact text injected into every request —
 * so "what is the model actually being told" is answerable without leaving the page.
 *
 * @module @achasoft/dsh-memory/client/RulesView
 */

import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryOverview, MemoryProvenanceView, MemoryView } from '../host/types.ts'
import { MemoryCard } from './MemoryCard.tsx'
import { cx, type ClassValue } from './cx.ts'
import css from './MemoryScreen.module.css'

/** Everything the rules pane needs. */
export interface RulesViewProps {
  readonly t: TranslateNS<'memory'>
  readonly overview: MemoryOverview
  /** The memory whose audit trail is expanded, if any. */
  readonly tracing: string | undefined
  /** Expand or collapse one memory's audit trail. */
  readonly onToggleTrace: (id: string) => void
  /** Open the editor on one rule. */
  readonly onEdit: (memory: MemoryView) => void
  /** Archive one rule, or restore it. */
  readonly onArchiveOrRestore: (memory: MemoryView) => void
  /** Remove one rule permanently. */
  readonly onDelete: (memory: MemoryView) => void
  /**
   * Read one rule's audit trail.
   * @param id - the rule to trace.
   * @param signal - cancellation for the read.
   * @returns the entries, newest first.
   */
  readonly readTrace: (id: string, signal: AbortSignal) => Promise<readonly MemoryProvenanceView[]>
}

/**
 * The rules pane.
 * @param props - the overview and the card verbs.
 * @returns the two rule lists and the injected-text preview.
 * @see {@link RulesViewProps}
 */
export function RulesView(props: RulesViewProps) {
  const { t, overview, tracing, onToggleTrace, onEdit, onArchiveOrRestore, onDelete, readTrace } = props
  const [showBlock, setShowBlock] = useState(false)
  const empty = overview.mandatory.length === 0 && overview.forbidden.length === 0

  if (empty) return <p className={css.state}>{t('rules.empty')}</p>

  const section = (heading: string, rules: readonly MemoryView[], tone: ClassValue) =>
    rules.length === 0
      ? null
      : (
          <section className={css.ruleSection}>
            <h3 className={cx(css.ruleHeading, tone)}>{heading}</h3>
            <div className={css.rows}>
              {rules.map(rule => (
                <MemoryCard
                  key={rule.id}
                  t={t}
                  memory={rule}
                  tracing={tracing === rule.id}
                  onToggleTrace={() => { onToggleTrace(rule.id) }}
                  onEdit={() => { onEdit(rule) }}
                  onArchiveOrRestore={() => { onArchiveOrRestore(rule) }}
                  onDelete={() => { onDelete(rule) }}
                  readTrace={signal => readTrace(rule.id, signal)}
                />
              ))}
            </div>
          </section>
        )

  return (
    <>
      {section(t('rules.mandatory'), overview.mandatory, css.ruleHeadingMandatory)}
      {section(t('rules.forbidden'), overview.forbidden, css.ruleHeadingForbidden)}

      <section className={css.ruleSection}>
        <Button
          variant="outline"
          size="sm"
          className={css.blockToggle}
          aria-expanded={showBlock}
          onClick={() => { setShowBlock(!showBlock) }}
        >
          {showBlock ? t('rules.hidePreview') : t('rules.showPreview')}
        </Button>
        {showBlock && (
          <>
            <h3 className={css.ruleHeading}>{t('rules.preview')}</h3>
            <pre className={css.block}>{overview.rulesBlock}</pre>
          </>
        )}
      </section>
    </>
  )
}
