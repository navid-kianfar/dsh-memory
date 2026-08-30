/**
 * The screen's "are you sure": a dialog, not `window.confirm`.
 *
 * `confirm()` blocks the page, is drawn by the browser in the browser's colours, and cannot mark the
 * destructive answer as destructive. Deleting a memory takes its whole audit trail with it, which is
 * exactly the action that deserves better than a system alert.
 *
 * Follows the shell's own `RiskConfirmation` layout (warning row, outline Cancel, primary Confirm)
 * without its acknowledgement checkbox: this wants a deliberate second click, not a checkbox. Mask,
 * Escape, and the portal are the design system's `Modal`.
 *
 * @module @achasoft/dsh-memory/client/ui/ConfirmDialog
 */

import { Button, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import fields from './fields.module.css'
import css from './ConfirmDialog.module.css'

/** What one pending confirmation is about. */
export interface ConfirmRequest {
  /** The dialog's heading. */
  readonly title: string
  /** The sentence explaining what happens, and what cannot be undone. */
  readonly description: string
  /** The confirming button's label, phrased as the action it performs. */
  readonly confirmLabel: string
  /** What to do when it is pressed. */
  readonly onConfirm: () => void
}

/** Render the confirmation dialog. */
export function ConfirmDialog({ request, onClose, cancelLabel, closeLabel }: {
  /** The pending confirmation, or `null` when nothing is being asked. */
  readonly request: ConfirmRequest | null
  /** Dismiss without acting — Escape, the mask, or Cancel. */
  readonly onClose: () => void
  /** The dismissing button's label. */
  readonly cancelLabel: string
  /** Accessible label for the header's close control. */
  readonly closeLabel: string
}) {
  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      title={request?.title ?? ''}
      closeLabel={closeLabel}
      className={cx(fields.fields, css.dialog)}
      footer={
        <>
          {/* Focus lands on Cancel, never on Confirm: a dialog that appears under a finger already
              pressing Enter must not delete anything. */}
          <Button variant="outline" size="sm" autoFocus onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { request?.onConfirm(); onClose() }}
          >
            {request?.confirmLabel ?? ''}
          </Button>
        </>
      }
    >
      <div className={css.warning}>
        <IconWarningOutline16 size={18} className={css.warningIcon} />
        <p className={css.body}>{request?.description ?? ''}</p>
      </div>
    </Modal>
  )
}
