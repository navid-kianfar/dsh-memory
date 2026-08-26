/**
 * The sidebar-foot entry that opens the memory manager.
 *
 * It sits beside Settings in both sidebar widths, so it borrows that row's geometry rather than
 * inventing its own — a foot seat with different proportions reads as a control from a different
 * application. The count beside the label is the project's rule count, because "how many rules bind
 * me right now" is the one fact worth carrying into a collapsed column.
 * @module @achasoft/dsh-memory/client/MemoryTrigger
 */

import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryTriggerProps } from './contract.ts'
import { cx } from './cx.ts'
import css from './MemoryTrigger.module.css'

/**
 * The trigger, in the two boxes its seat needs.
 * @param props - the standard kit plus this plugin's face.
 * @returns the button.
 * @see {@link MemoryTriggerProps}
 */
export function MemoryTrigger(props: MemoryTriggerProps) {
  const { wide, t, toggle, useManager } = props
  const open = useManager(state => state.open)
  const label = t('trigger.label')

  const button = (
    <button
      type="button"
      className={cx(css.trigger, wide ? css.triggerWide : css.triggerRail, open && css.triggerOpen)}
      aria-label={t('trigger.aria')}
      aria-expanded={open}
      onClick={toggle}
    >
      <IconDataOutline16 size={wide ? 14 : 18} />
      {wide && <span className={css.triggerLabel}>{label}</span>}
    </button>
  )
  return wide ? button : <Tooltip label={label} side="right">{button}</Tooltip>
}
