/**
 * The labelled field, and the two text controls that sit in one.
 *
 * A field is a label, a control, and at most one line under it — a hint while the value is fine, the
 * failure while it is not. Keeping that arrangement in one component is what stops a form growing
 * three slightly different spacings between a label and its box.
 *
 * @module @achasoft/dsh-memory/client/ui/Field
 */

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import fields from './fields.module.css'

/** Everything a labelled field needs. */
export interface FieldProps {
  /** The field's visible name. */
  readonly label: string
  /** The supporting line under the control, shown while there is no failure. */
  readonly hint?: string
  /** The failure under the control; replaces the hint while it is present. */
  readonly error?: string
  /** Extra class for the field box, for the widths a form row needs. */
  readonly className?: string | undefined
  /** The control itself. */
  readonly children: ReactNode
}

/**
 * One labelled field.
 *
 * A `<label>` rather than a `<div>`: every control below is a real form element, so wrapping puts
 * the name on it without an id both sides have to agree on.
 * @param props - the name, the supporting copy, and the control.
 * @returns the field.
 * @see {@link FieldProps}
 */
export function Field(props: FieldProps) {
  const { label, hint, error, className, children } = props
  return (
    <label className={cx(fields.field, className)}>
      <span className={fields.label}>{label}</span>
      {children}
      {error !== undefined && <span className={fields.error}>{error}</span>}
      {error === undefined && hint !== undefined && <span className={fields.hint}>{hint}</span>}
    </label>
  )
}

/**
 * A single-line text box in the shared field shape.
 * @param props - native input attributes; `invalid` marks it as refused.
 * @returns the input.
 */
export function TextInput({ invalid = false, className, ...rest }: {
  /** Whether the value is refused, drawn as an error border and announced as `aria-invalid`. */
  invalid?: boolean
  className?: string | undefined
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input className={cx(fields.input, className)} aria-invalid={invalid} {...rest} />
}

/**
 * A multi-line text box in the shared field shape.
 * @param props - native textarea attributes; `mono` switches to the code face.
 * @returns the textarea.
 */
export function TextArea({ mono = false, className, ...rest }: {
  /** Whether the content is code — JSON metadata is, prose is not. */
  mono?: boolean
  className?: string | undefined
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return (
    <textarea
      className={cx(fields.input, fields.textarea, mono && fields.mono, className)}
      {...rest}
    />
  )
}
