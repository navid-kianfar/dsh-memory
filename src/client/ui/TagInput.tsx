/**
 * The tags field: chips you can remove, and a box that suggests the tags already in the project.
 *
 * It was a comma-separated text box, which asked the reader to parse the field's own syntax and hid
 * the one thing the store actually enforces — tags are trimmed, de-duplicated and capped. A chip
 * commits when it is typed and disappears when its cross is clicked, so what is on screen is exactly
 * what will be stored.
 *
 * Suggestions come from the tags already in use, which is what keeps `api` from quietly becoming
 * `api`, `API` and `apis`.
 *
 * @module @achasoft/dsh-memory/client/ui/TagInput
 */

import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_TAGS, TAG_MAX_CHARS } from '../../domain/validate.ts'
import { cx } from '../cx.ts'
import { Popover } from './Popover.tsx'
import fields from './fields.module.css'
import css from './TagInput.module.css'

/** How many completions the suggestion list offers at once. */
const SUGGESTION_LIMIT = 8

/**
 * Canonicalise one typed tag the way the store will.
 *
 * Applied here as well as on the Host so the chip that appears is the chip that is stored: a field
 * that accepts `  API ` and shows it back, then reloads as `API`, looks like it lost the edit.
 * @param raw - what was typed.
 * @returns the canonical tag, or the empty string when there is nothing to add.
 */
export function canonicalTag(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').slice(0, TAG_MAX_CHARS)
}

/** Everything the tags field needs. */
export interface TagInputProps {
  /** The tags on the memory. */
  readonly value: readonly string[]
  /** Every tag in use across the project, offered as completions. */
  readonly suggestions: readonly string[]
  /** Called with the new tag set whenever a chip is added or removed. */
  readonly onChange: (tags: string[]) => void
  /** Accessible name for the entry box, since the visible label is a separate element. */
  readonly label: string
  /** What the entry box reads as while the memory carries no tags. */
  readonly placeholder: string
  /** Accessible name for one chip's remove button, given the tag. */
  readonly removeLabel: (tag: string) => string
  /** What the entry box reads as once the memory carries the most tags allowed. */
  readonly fullLabel: string
  /** Accessible name for the suggestion list. */
  readonly suggestionsLabel: string
}

/**
 * The tags field.
 * @param props - the tags, the completions, and the writer.
 * @returns the chip seat and its suggestion list.
 * @see {@link TagInputProps}
 */
export function TagInput(props: TagInputProps) {
  const { value, suggestions, onChange, label, placeholder } = props
  const { removeLabel, fullLabel, suggestionsLabel } = props
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const seat = useRef<HTMLDivElement | null>(null)
  const box = useRef<HTMLInputElement | null>(null)

  const full = value.length >= MAX_TAGS

  const matches = useMemo(() => {
    const needle = canonicalTag(draft).toLowerCase()
    return suggestions
      .filter(entry => !value.includes(entry))
      .filter(entry => needle === '' || entry.toLowerCase().includes(needle))
      .slice(0, SUGGESTION_LIMIT)
  }, [suggestions, value, draft])

  /**
   * Add one tag, unless the memory already carries it or is already full.
   * @param raw - the tag as typed or chosen.
   */
  function add(raw: string): void {
    const next = canonicalTag(raw)
    setDraft('')
    setOpen(false)
    if (next === '' || value.includes(next) || full) return
    onChange([...value, next])
  }

  /**
   * Remove one tag.
   * @param entry - the tag to drop.
   */
  function remove(entry: string): void {
    onChange(value.filter(current => current !== entry))
  }

  /**
   * Commit, complete, or backspace out of the entry box.
   * @param event - the keydown.
   */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // A comma is how this field used to separate tags, so pasting an old list still works — each
    // separator simply commits the chip in front of it.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      // Enter inside a form would otherwise submit it, saving the memory on the keystroke that was
      // meant to finish a tag.
      event.stopPropagation()
      add(draft)
      return
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault()
      remove(value[value.length - 1] as string)
      return
    }
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <>
      {/* The whole seat is the field: clicking anywhere in it lands in the entry box, which is what
          a row of chips has to do to still feel like one control. */}
      <div
        ref={seat}
        className={cx(css.seat, open && css.seatOpen)}
        onClick={(event) => { if (event.target === event.currentTarget) box.current?.focus() }}
      >
        {value.map(entry => (
          <span key={entry} className={css.chip}>
            <span className={css.chipText}>{entry}</span>
            <button
              type="button"
              className={css.chipRemove}
              aria-label={removeLabel(entry)}
              onClick={() => { remove(entry) }}
            >
              <IconCloseFill14 size={10} />
            </button>
          </span>
        ))}
        <input
          ref={box}
          className={css.entry}
          value={draft}
          disabled={full}
          placeholder={full ? fullLabel : value.length === 0 ? placeholder : ''}
          aria-label={label}
          aria-expanded={open}
          onChange={(event) => { setDraft(event.currentTarget.value); setOpen(true) }}
          onFocus={() => { setOpen(true) }}
          onKeyDown={onKeyDown}
          // Committing on blur as well: leaving the field with a half-typed tag and finding it gone
          // is the one thing a chip field must not do.
          onBlur={() => { add(draft) }}
        />
      </div>

      <Popover
        open={open && matches.length > 0}
        anchorRef={seat}
        onClose={() => { setOpen(false) }}
        label={suggestionsLabel}
      >
        <div className={fields.popoverScroll}>
          {matches.map(entry => (
            <button
              key={entry}
              type="button"
              className={fields.option}
              // Pointer-down, not click: the entry box's blur would otherwise close the popover
              // before the click landed.
              onPointerDown={(event) => { event.preventDefault(); add(entry) }}
            >
              <span className={fields.optionLabel}>{entry}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}
