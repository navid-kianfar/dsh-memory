/**
 * The plugin's own control kit: the field vocabulary every surface here is built from.
 *
 * The harness ships atoms (`Button`, `Input`, `Modal`, `Menu`) but not the composed controls a form
 * needs — a select, a chip field, a confirmation, a banner. Those are built once here, over those
 * atoms and the same design tokens, so the dialog, the toolbar, the filters and the settings card
 * are demonstrably the same controls rather than four hand-rolled approximations.
 *
 * @module @achasoft/dsh-memory/client/ui
 */

export { Alert } from './Alert.tsx'
export type { AlertProps, AlertTone } from './Alert.tsx'
export { ConfirmDialog } from './ConfirmDialog.tsx'
export type { ConfirmRequest } from './ConfirmDialog.tsx'
export { Field, TextArea, TextInput } from './Field.tsx'
export type { FieldProps } from './Field.tsx'
export { Popover, placeSurface } from './Popover.tsx'
export type { Placement } from './Popover.tsx'
export { Select } from './Select.tsx'
export type { SelectOption, SelectTone } from './Select.tsx'
export { TagInput, canonicalTag } from './TagInput.tsx'
export type { TagInputProps } from './TagInput.tsx'
// The vocabulary's root class. A surface that renders these controls applies it once, at its own
// root, so every field inside resolves the `--dsh-memory-field-*` tokens they are drawn from.
export { default as fields } from './fields.module.css'
