/**
 * The create-and-edit form.
 *
 * One form for both, because a new memory and an edited one differ only in what the fields start
 * at — and two forms would drift on which fields exist. The category select is the only control
 * that changes shape between them: a rule cannot become an ordinary memory by accident, so editing
 * a rule offers only the two rule categories and editing a note offers only the rest.
 * @module @achasoft/dsh-memory/client/MemoryEditor
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryCategoryWire, MemoryView } from '../host/types.ts'
import { AUTHORABLE_CATEGORIES, RULE_CATEGORIES, categoryLabel, isRule, parseTags } from './format.ts'
import { cx } from './cx.ts'
import css from './MemoryManager.module.css'

/** What the editor is composing. */
export interface EditorDraft {
  readonly category: MemoryCategoryWire
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly priority: number
  readonly metadataJson: string
}

/** Everything the editor needs. */
export interface MemoryEditorProps {
  readonly t: TranslateNS<'memory'>
  /** The memory being edited, or undefined when composing a new one. */
  readonly memory: MemoryView | undefined
  /** The category a new memory starts on. */
  readonly initialCategory: MemoryCategoryWire
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
 * The form, as a card above the listing.
 * @param props - the memory being edited and the two verbs.
 * @returns the form.
 * @see {@link MemoryEditorProps}
 */
export function MemoryEditor(props: MemoryEditorProps) {
  const { t, memory, initialCategory, onSave, onCancel } = props
  const [category, setCategory] = useState<MemoryCategoryWire>(memory?.category ?? initialCategory)
  const [title, setTitle] = useState(memory?.title ?? '')
  const [content, setContent] = useState(memory?.content ?? '')
  const [tags, setTags] = useState((memory?.tags ?? []).join(', '))
  const [priority, setPriority] = useState(String(memory?.priority ?? 0))
  const [metadata, setMetadata] = useState(memory?.metadataJson ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  // A rule and a note are different kinds of thing, so the select never offers a move between them:
  // reclassifying a note as a rule changes what binds the model, which is a decision that deserves a
  // deliberate act rather than a stray click in a dropdown.
  const options = isRule(category) ? RULE_CATEGORIES : AUTHORABLE_CATEGORIES
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
      tags: parseTags(tags),
      priority: Number.parseInt(priority, 10) || 0,
      metadataJson: metadata.trim(),
    }).then((message) => {
      setSaving(false)
      if (message !== undefined) setFailed(message)
    })
  }

  return (
    <form className={css.editor} onSubmit={submit}>
      <h3 className={css.editorTitle}>{memory === undefined ? t('editor.new') : t('editor.edit')}</h3>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('editor.category')}</span>
        <select
          className={css.select}
          value={category}
          onChange={event => { setCategory(event.target.value as MemoryCategoryWire) }}
        >
          {options.map(option => (
            <option key={option} value={option}>{categoryLabel(t, option)}</option>
          ))}
        </select>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('editor.title')}</span>
        <input
          className={css.input}
          value={title}
          autoFocus
          onChange={event => { setTitle(event.target.value) }}
        />
        <span className={css.fieldHint}>{t('editor.titleHint')}</span>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('editor.content')}</span>
        <textarea
          className={cx(css.input, css.textarea)}
          value={content}
          rows={6}
          onChange={event => { setContent(event.target.value) }}
        />
        <span className={css.fieldHint}>{t('editor.contentHint')}</span>
      </label>

      <div className={css.fieldRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('editor.tags')}</span>
          <input className={css.input} value={tags} onChange={event => { setTags(event.target.value) }} />
          <span className={css.fieldHint}>{t('editor.tagsHint')}</span>
        </label>
        <label className={cx(css.field, css.fieldNarrow)}>
          <span className={css.fieldLabel}>{t('editor.priority')}</span>
          <select className={css.select} value={priority} onChange={event => { setPriority(event.target.value) }}>
            {['0', '1', '2', '3'].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <span className={css.fieldHint}>{t('editor.priorityHint')}</span>
        </label>
      </div>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('editor.metadata')}</span>
        <textarea
          className={cx(css.input, css.textarea, css.mono)}
          value={metadata}
          rows={2}
          spellCheck={false}
          onChange={event => { setMetadata(event.target.value) }}
        />
      </label>

      {failed !== undefined && <p className={css.editorError}>{failed}</p>}

      <div className={css.editorActions}>
        <button type="button" className={css.buttonGhost} onClick={onCancel} disabled={saving}>
          {t('editor.cancel')}
        </button>
        <button type="submit" className={css.buttonPrimary} disabled={!complete || saving}>
          {saving ? t('editor.saving') : t('editor.save')}
        </button>
      </div>
    </form>
  )
}
