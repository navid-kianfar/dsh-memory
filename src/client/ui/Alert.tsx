/**
 * The alert: one banner shape for everything the screen has to say back.
 *
 * Three tones, and the difference between them is what the reader is supposed to do. `info` reports
 * a completed action and withdraws itself. `error` reports one that failed and stays until it is
 * dismissed — a failure that disappears on its own is a failure nobody read. `warn` reports a
 * standing condition (rules are not being injected) that no dismissal would fix, so it carries no
 * close control.
 *
 * @module @achasoft/dsh-memory/client/ui/Alert
 */

import type { ReactNode } from 'react'
import {
  IconCheckOutline16, IconCloseOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import css from './Alert.module.css'

/** What an alert is about, and therefore how it is drawn. */
export type AlertTone = 'info' | 'warn' | 'error'

/** The leading icon each tone carries. */
const ICONS: Readonly<Record<AlertTone, () => ReactNode>> = {
  info: () => <IconCheckOutline16 size={16} />,
  warn: () => <IconWarningOutline16 size={16} />,
  error: () => <IconWarningOutline16 size={16} />,
}

/** Everything one alert needs. */
export interface AlertProps {
  /** What kind of thing is being reported. */
  readonly tone: AlertTone
  /** The message, already phrased for the reader. */
  readonly children: ReactNode
  /** Dismiss it; a banner with no dismisser cannot be closed by hand. */
  readonly onDismiss?: (() => void) | undefined
  /** Accessible name for the dismiss control. */
  readonly dismissLabel?: string
  /** Extra class, for the margins a surface needs around it. */
  readonly className?: string | undefined
}

/**
 * One alert banner.
 *
 * `role="alert"` only for the tones a person must not miss: an assertive live region for every
 * routine confirmation would interrupt a screen reader on every save.
 * @param props - the tone, the message, and the optional dismisser.
 * @returns the banner.
 * @see {@link AlertProps}
 */
export function Alert(props: AlertProps) {
  const { tone, children, onDismiss, dismissLabel, className } = props
  return (
    <div
      className={cx(css.alert, css[tone], className)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={css.icon} aria-hidden="true">{ICONS[tone]()}</span>
      <span className={css.text}>{children}</span>
      {onDismiss !== undefined && (
        <button
          type="button"
          className={css.dismiss}
          aria-label={dismissLabel ?? ''}
          onClick={onDismiss}
        >
          <IconCloseOutline16 size={12} />
        </button>
      )}
    </div>
  )
}
