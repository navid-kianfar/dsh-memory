/**
 * The create-and-edit form, as a dialog.
 *
 * One form for both, because a new memory and an edited one differ only in what the fields start
 * at — and two forms would drift on which fields exist. The category select is the only control that
 * changes shape between them: a rule cannot become an ordinary memory by accident, so editing a rule
 * offers only the two rule categories and editing a note offers only the rest.
 *
 * A dialog rather than a card above the listing. Writing a memory is a modal act — the listing
 * behind it cannot be usefully acted on mid-edit — and an inline form pushed the rows it was meant
 * to sit beside off the screen, so the thing being edited scrolled out of view as the form grew.
 *
 * @module @achasoft/dsh-memory/client/MemoryDialog
 */

import { useId, useState, type FormEvent } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PRIORITY_MAX, PRIORITY_MIN } from '../domain/types.ts'
import type { MemoryCategoryWire, MemoryView } from '../host/types.ts'
import { AUTHORABLE_CATEGORIES, RULE_CATEGORIES, categoryLabel, isRule } from './format.ts'
import { Alert, Field, Select, TagInput, TextArea, TextInput, fields, type SelectOption } from './ui/index.ts'
import { cx } from './cx.ts'
import css from './MemoryDialog.module.css'

/** What the dialog is composing. */
export interface EditorDraft {
  readonly category: MemoryCategoryWire
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly priority: number
  readonly metadataJson: string
}

/** The priorities the form offers, as the select's own string domain. */
const PRIORITIES: readonly string[] =
  Array.from({ length: PRIORITY_MAX - PRIORITY_MIN + 1 }, (_, step) => String(PRIORITY_MIN + step))

/** Everything the dialog needs. */
export interface MemoryDialogProps {
  readonly t: TranslateNS<'memory'>
  /** Whether the dialog is showing; it holds no state of its own while closed. */
  readonly open: boolean
  /** The memory being edited, or undefined when composing a new one. */
  readonly memory: MemoryView | undefined
  /** The category a new memory starts on. */
  readonly initialCategory: MemoryCategoryWire
  /** Every tag the screen has seen, offered as completions in the tags field. */
  readonly knownTags: readonly string[]
  /**
   * Save the draft.
   * @param draft - what the form holds.
   * @returns the failure message, or undefined when the save succeeded.
   */
  readonly onSave: (draft: EditorDraft) => Promise<string | undefined>
  /** Close without saving. */
  readonly onCancel: () => void
}

/**
 * The memory dialog.
 *
 * Keyed by the memory it opens on at the call site, so the fields start at that memory's values:
 * this component seeds its state once and then owns it, which is what lets a draft survive a
 * background refresh of the listing underneath.
 * @param props - the memory being edited and the two verbs.
 * @returns the dialog, or nothing while it is closed.
 * @see {@link MemoryDialogProps}
 */
export function MemoryDialog(props: MemoryDialogProps) {
  const { t, open, memory, initialCategory, knownTags, onSave, onCancel } = props
  const [category, setCategory] = useState<MemoryCategoryWire>(memory?.category ?? initialCategory)
  const [title, setTitle] = useState(memory?.title ?? '')
  const [content, setContent] = useState(memory?.content ?? '')
  const [tags, setTags] = useState<readonly string[]>(memory?.tags ?? [])
  const [priority, setPriority] = useState(String(memory?.priority ?? PRIORITY_MIN))
  const [metadata, setMetadata] = useState(memory?.metadataJson ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const formId = useId()

  // A rule and a note are different kinds of thing, so the select never offers a move between them:
  // reclassifying a note as a rule changes what binds the model, which is a decision that deserves a
  // deliberate act rather than a stray click in a dropdown.
  const offered = isRule(category) ? RULE_CATEGORIES : AUTHORABLE_CATEGORIES
  const categories: readonly SelectOption<MemoryCategoryWire>[] = offered.map(option => ({
    value: option,
    label: categoryLabel(t, option),
    ...isRule(option) ? { tone: 'warn' as const } : {},
  }))
  const priorities: readonly SelectOption<string>[] = PRIORITIES.map(value => ({ value, label: value }))
  const complete = title.trim().length > 0 && content.trim().length > 0

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!complete || saving) return
    setSaving(true)
    setFailed(undefined)
    void onSave({
      category,
      title: title.trim(),
      content: content.trim(),
      tags,
      priority: Number.parseInt(priority, 10) || 0,
      metadataJson: metadata.trim(),
    }).then((message) => {
      setSaving(false)
      if (message !== undefined) setFailed(message)
    })
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={memory === undefined ? t('editor.new') : t('editor.edit')}
      closeLabel={t('editor.cancel')}
      className={cx(fields.fields, css.dialog)}
      footer={
        <>
          <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
            {t('editor.cancel')}
          </Button>
          {/* `form` rather than a click handler: the submit button lives in the Modal's footer,
              outside the form element, and the attribute is what still makes Enter in a field and a
              press here the same act. */}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="sm"
            disabled={!complete || saving}
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={css.form} onSubmit={submit}>
        <div className={css.row}>
          <Field label={t('editor.category')} className={css.grow}>
            <Select
              value={category}
              options={categories}
              onChange={setCategory}
              label={t('editor.category')}
            />
          </Field>
          <Field label={t('editor.priority')} hint={t('editor.priorityHint')} className={css.narrow}>
            <Select
              value={priority}
              options={priorities}
              onChange={setPriority}
              label={t('editor.priority')}
              align="end"
            />
          </Field>
        </div>

        <Field label={t('editor.title')} hint={t('editor.titleHint')}>
          <TextInput
            value={title}
            autoFocus
            onChange={(event) => { setTitle(event.target.value) }}
          />
        </Field>

        <Field label={t('editor.content')} hint={t('editor.contentHint')}>
          <TextArea
            value={content}
            rows={7}
            onChange={(event) => { setContent(event.target.value) }}
          />
        </Field>

        <Field label={t('editor.tags')} hint={t('editor.tagsHint')}>
          <TagInput
            value={tags}
            suggestions={knownTags}
            onChange={setTags}
            label={t('editor.tags')}
            placeholder={t('editor.tagsPlaceholder')}
            removeLabel={tag => t('editor.tagRemove', { tag })}
            fullLabel={t('editor.tagsFull', { count: String(tags.length) })}
            suggestionsLabel={t('editor.tagsSuggestions')}
          />
        </Field>

        <Field label={t('editor.metadata')} hint={t('editor.metadataHint')}>
          <TextArea
            value={metadata}
            rows={2}
            mono
            spellCheck={false}
            onChange={(event) => { setMetadata(event.target.value) }}
          />
        </Field>

        {failed !== undefined && (
          <Alert tone="error" onDismiss={() => { setFailed(undefined) }} dismissLabel={t('alert.dismiss')}>
            {failed}
          </Alert>
        )}
      </form>
    </Modal>
  )
}
