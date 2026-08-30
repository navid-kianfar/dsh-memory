/**
 * The memory card on the plugin settings tab.
 *
 * The plugin settings tab forbids importing the section's own card components across the plugin
 * boundary, so this reproduces that card's visual language from the same design tokens — a card that
 * looked different would read as a different KIND of thing, not a different plugin.
 *
 * Edits are staged rather than written per keystroke. A settings write is fenced on a revision, so
 * every keystroke committing on its own would race the fence and snap back; the footer's Save is
 * what commits, and Discard is what makes an abandoned edit visibly abandoned.
 *
 * @module @achasoft/dsh-memory/client/SettingsCard
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemorySettings } from '../host/types.ts'
import type { MemorySettingsCardProps } from './contract.ts'
import { Alert, Select, TextInput, fields, type SelectOption } from './ui/index.ts'
import { cx } from './cx.ts'
import { useAsync } from './useAsync.ts'
import css from './SettingsCard.module.css'

/** The reminder policies, in the order the card offers them. */
const REMINDERS: readonly MemorySettings['remind'][] = ['never', 'once', 'every-turn']

/** The toolsets, in the order the card offers them. */
const TOOLSETS: readonly MemorySettings['toolset'][] = ['core', 'full']

/** Fields the card edits as free text or numbers, with the bounds each accepts. */
const NUMERIC_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  vectorWeight: [0, 1],
  minSimilarity: [0, 1],
  searchLimit: [1, 100],
}

/** One staged edit: the field's text as typed, before it is parsed and committed. */
type Draft = Partial<Record<keyof MemorySettings, string>>

/**
 * The memory settings card.
 * @param props - the standard kit plus this plugin's face.
 * @returns the card.
 * @see {@link MemorySettingsCardProps}
 */
export function MemorySettingsCard(props: MemorySettingsCardProps) {
  const { t, useSettings, setField, describe } = props
  const snapshot = useSettings(state => state)
  const settings = snapshot.value
  const writable = snapshot.writable !== false

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  const overview = useAsync(
    async () => {
      const result = await describe()
      if (!result.ok) throw new Error(result.message)
      return result.overview
    },
    [snapshot.revision],
    open,
  )

  // A change committed elsewhere — another window, a config reload — makes a staged edit describe a
  // value that no longer exists, so the staging is dropped rather than saved over the newer one.
  useEffect(() => { setDraft({}); setFailed(undefined) }, [snapshot.revision])

  const dirty = Object.keys(draft).length > 0
  const invalid = useMemo(() => Object.entries(draft).some(([field, text]) => {
    const bounds = NUMERIC_BOUNDS[field]
    if (bounds === undefined) return false
    const value = Number(text)
    return !Number.isFinite(value) || value < bounds[0] || value > bounds[1]
  }), [draft])

  const stage = useCallback((field: keyof MemorySettings, text: string): void => {
    setDraft(current => ({ ...current, [field]: text }))
  }, [])

  /**
   * Commit one field immediately.
   *
   * Switches and selects take this path rather than the staged one: neither has an intermediate
   * state worth a Save button, and staging them would leave a toggle looking flipped while the
   * stored value still said otherwise.
   */
  const commit = useCallback((field: keyof MemorySettings, value: boolean | string): void => {
    setFailed(undefined)
    void setField(field, value).catch((error: unknown) => {
      setFailed(t('settings.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
    })
  }, [setField, t])

  const save = useCallback((): void => {
    setSaving(true)
    setFailed(undefined)
    const writes = Object.entries(draft).map(([field, text]) => {
      const bounds = NUMERIC_BOUNDS[field]
      return setField(field, bounds === undefined ? text : Number(text))
    })
    void Promise.all(writes).then(
      () => { setSaving(false); setDraft({}) },
      (error: unknown) => {
        setSaving(false)
        setFailed(t('settings.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
      },
    )
  }, [draft, setField, t])

  /**
   * The value a field currently shows: the staged text when there is one, else the stored value.
   * @param field - the field to read.
   * @returns the display text.
   */
  const shown = (field: keyof MemorySettings): string =>
    draft[field] ?? String(settings?.[field] ?? '')

  if (settings === undefined) return null

  const embedding = overview.kind === 'loaded' ? overview.value.embedding : undefined
  const status = embedding === undefined
    ? undefined
    : !embedding.available
        ? { tone: css.badgeMuted, text: t('settings.embedding.none') }
        : embedding.ready
          ? { tone: css.badgeReady, text: t('settings.embedding.ready', { model: embedding.model ?? embedding.provider ?? '' }) }
          : { tone: css.badgeBlocked, text: t('settings.embedding.blocked', { detail: embedding.detail ?? '' }) }

  const reminders: readonly SelectOption<MemorySettings['remind']>[] = REMINDERS.map(option => ({
    value: option,
    label: t(`settings.remind.${option}` as Parameters<typeof t>[0]),
  }))
  const toolsets: readonly SelectOption<MemorySettings['toolset']>[] = TOOLSETS.map(option => ({
    value: option,
    label: t(`settings.toolset.${option}` as Parameters<typeof t>[0]),
  }))

  return (
    <li className={cx(fields.fields, css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('settings.name')}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {dirty && <span className={css.pending}>{t('editor.save')}</span>}
        <IconChevronDownOutline14 className={cx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div className={css.body}>
          {!writable && <p className={css.readOnly}>{t('settings.readOnly')}</p>}

          {overview.kind === 'loaded' && (
            <div className={css.field}>
              <div className={css.head}>
                <span className={css.label}>{t('settings.embedding')}</span>
                {status !== undefined && <span className={status.tone}>{status.text}</span>}
              </div>
              <p className={css.hint}>
                {t('settings.stats', {
                  active: String(overview.value.stats.active),
                  embedded: String(overview.value.stats.embedded),
                })}
              </p>
              {/* Where to go, not a button that goes there: the Memory view is a conversation tab,
                  and no plugin may reach across and switch another package's tab ring. */}
              <p className={css.hint}>{t('settings.manage')}</p>
            </div>
          )}

          <Switch
            label={t('settings.injectRules')}
            hint={t('settings.injectRulesHint')}
            checked={settings.injectRules}
            disabled={!writable}
            onChange={value => { commit('injectRules', value) }}
          />
          <Switch
            label={t('settings.injectSessionContext')}
            hint={t('settings.injectSessionContextHint')}
            checked={settings.injectSessionContext}
            disabled={!writable}
            onChange={value => { commit('injectSessionContext', value) }}
          />
          <Switch
            label={t('settings.autoSession')}
            checked={settings.autoSession}
            disabled={!writable}
            onChange={value => { commit('autoSession', value) }}
          />

          <div className={css.field}>
            <div className={css.head}><span className={css.label}>{t('settings.remind')}</span></div>
            <Select
              value={settings.remind}
              options={reminders}
              label={t('settings.remind')}
              disabled={!writable}
              onChange={(next) => { commit('remind', next) }}
            />
          </div>

          <div className={css.field}>
            <div className={css.head}><span className={css.label}>{t('settings.toolset')}</span></div>
            <Select
              value={settings.toolset}
              options={toolsets}
              label={t('settings.toolset')}
              disabled={!writable}
              onChange={(next) => { commit('toolset', next) }}
            />
          </div>

          <NumberField
            label={t('settings.vectorWeight')}
            hint={t('settings.vectorWeightHint')}
            value={shown('vectorWeight')}
            step={0.05}
            bounds={NUMERIC_BOUNDS['vectorWeight']!}
            invalidText={t('settings.invalid')}
            disabled={!writable}
            onChange={text => { stage('vectorWeight', text) }}
          />
          <NumberField
            label={t('settings.minSimilarity')}
            value={shown('minSimilarity')}
            step={0.05}
            bounds={NUMERIC_BOUNDS['minSimilarity']!}
            invalidText={t('settings.invalid')}
            disabled={!writable}
            onChange={text => { stage('minSimilarity', text) }}
          />
          <NumberField
            label={t('settings.searchLimit')}
            value={shown('searchLimit')}
            step={1}
            bounds={NUMERIC_BOUNDS['searchLimit']!}
            invalidText={t('settings.invalid')}
            disabled={!writable}
            onChange={text => { stage('searchLimit', text) }}
          />

          <div className={css.field}>
            <div className={css.head}><span className={css.label}>{t('settings.databasePath')}</span></div>
            <TextInput
              value={shown('databasePath')}
              disabled={!writable}
              onChange={(event) => { stage('databasePath', event.target.value) }}
            />
            <p className={css.hint}>{t('settings.databasePathHint')}</p>
          </div>

          {(dirty || failed !== undefined) && (
            <div className={css.footer}>
              {failed !== undefined && (
                <Alert
                  tone="error"
                  className={css.failed}
                  dismissLabel={t('alert.dismiss')}
                  onDismiss={() => { setFailed(undefined) }}
                >
                  {failed}
                </Alert>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !dirty}
                onClick={() => { setDraft({}); setFailed(undefined) }}
              >
                {t('editor.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={saving || !dirty || invalid || !writable}
                onClick={save}
              >
                {saving ? t('editor.saving') : t('editor.save')}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** A labelled on/off row. */
interface SwitchProps {
  readonly label: string
  readonly hint?: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
}

/**
 * One boolean setting.
 * @param props - the label, the value, and the writer.
 * @returns the row.
 */
function Switch(props: SwitchProps) {
  const { label, hint, checked, disabled, onChange } = props
  return (
    <div className={css.field}>
      <div className={css.head}>
        <span className={css.label}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          className={cx(css.switch, checked && css.switchOn)}
          disabled={disabled}
          onClick={() => { onChange(!checked) }}
        >
          <span className={css.switchKnob} />
        </button>
      </div>
      {hint !== undefined && <p className={css.hint}>{hint}</p>}
    </div>
  )
}

/** A labelled numeric row with its accepted bounds. */
interface NumberFieldProps {
  readonly label: string
  readonly hint?: string
  readonly value: string
  readonly step: number
  readonly bounds: readonly [number, number]
  readonly invalidText: string
  readonly disabled: boolean
  readonly onChange: (text: string) => void
}

/**
 * One numeric setting, with its own validity shown before a save is attempted.
 * @param props - the label, the staged text, and the bounds.
 * @returns the row.
 */
function NumberField(props: NumberFieldProps) {
  const { label, hint, value, step, bounds, invalidText, disabled, onChange } = props
  const parsed = Number(value)
  const invalid = !Number.isFinite(parsed) || parsed < bounds[0] || parsed > bounds[1]
  return (
    <div className={css.field}>
      <div className={css.head}><span className={css.label}>{label}</span></div>
      <TextInput
        type="number"
        inputMode="decimal"
        step={step}
        min={bounds[0]}
        max={bounds[1]}
        value={value}
        disabled={disabled}
        invalid={invalid}
        onChange={(event) => { onChange(event.target.value) }}
      />
      {invalid && <p className={css.invalid}>{invalidText}</p>}
      {!invalid && hint !== undefined && <p className={css.hint}>{hint}</p>}
    </div>
  )
}
