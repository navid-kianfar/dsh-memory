/**
 * A value picker: a field-shaped trigger over the design system's own dropdown.
 *
 * Replaces the native `<select>` this plugin used to carry everywhere. A native select cannot be
 * styled past its border — the list is drawn by the platform, in the platform's colours, at the
 * platform's size — so on a dark screen it opened as a bright rectangle belonging to no theme.
 * Everything here is the same surface, the same hairline and the same check mark the shell's own
 * menus use.
 *
 * @module @achasoft/dsh-memory/client/ui/Select
 */

import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import fields from './fields.module.css'
import css from './Select.module.css'

/**
 * The colour vocabulary an option may carry, matching what the screen already says elsewhere: a
 * rule is warn, an archived thing is muted, a live thing is success.
 */
export type SelectTone = 'success' | 'warn' | 'error' | 'muted'

/** One choice in a select. */
export interface SelectOption<V extends string = string> {
  /** The value written when this row is chosen. */
  readonly value: V
  /** What the row and the trigger read as. */
  readonly label: string
  /** Colours the row's leading dot; an option with no tone has no dot. */
  readonly tone?: SelectTone
}

/**
 * The leading dot, in whichever tone the option carries.
 * @param tone - the option's tone, or nothing for an option with no colour of its own.
 * @returns the dot, or `null`.
 */
function Dot({ tone }: { tone: SelectTone | undefined }): ReactNode {
  if (tone === undefined) return null
  return <span className={css.dot} data-tone={tone} aria-hidden="true" />
}

/** Render a select. */
export function Select<V extends string>({ value, options, onChange, label, disabled = false, align = 'start', className }: {
  /** The chosen value. */
  readonly value: V
  /** Every choice, in the order they are offered. */
  readonly options: readonly SelectOption<V>[]
  /** Called with the new value; never called with the value already chosen. */
  readonly onChange: (value: V) => void
  /** Accessible name for the trigger, since the visible label is a separate element. */
  readonly label: string
  /** Whether the field refuses changes. */
  readonly disabled?: boolean
  /** Which edge of the trigger the list lines up with. */
  readonly align?: 'start' | 'end'
  /** Extra class for the anchor, for the widths a toolbar needs. */
  readonly className?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)

  // Escape belongs to the list while the list is open, and to nothing else. `Menu` closes itself
  // from a bubble-phase listener on `document`, and so does `Modal` — two listeners on the same node,
  // so one Escape inside a select in a dialog would close the list AND throw away the form. Claiming
  // the key in the capture phase stops it before either of them sees it, which is why this closes the
  // list itself rather than leaving that to Menu.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open])

  const items: MenuEntry[] = options.map(option => ({
    id: option.value,
    label: (
      <span className={css.row}>
        <Dot tone={option.tone} />
        {option.label}
      </span>
    ),
  }))

  return (
    <Menu
      open={open}
      portal
      className={cx(css.anchor, className)}
      items={items}
      selectedId={value}
      onSelect={(next) => {
        setOpen(false)
        if (next !== value) onChange(next as V)
      }}
      onClose={() => { setOpen(false) }}
      align={align}
      anchor={
        <button
          type="button"
          className={cx(fields.trigger, css.trigger)}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
        >
          <Dot tone={selected?.tone} />
          <span className={fields.triggerText}>{selected?.label ?? value}</span>
          <IconChevronDownOutline14 size={14} className={fields.triggerIcon} />
        </button>
      }
    />
  )
}
