/**
 * Retention as a deployment configures it: an absent category takes the default, and a category the
 * deployment set to "never" never expires — two cases a `??` fallback used to collapse into one.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION_DAYS, expiresAt } from '../src/domain/retention.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

describe('expiresAt', () => {
  it('takes the built-in default for a category the table does not mention', () => {
    expect(expiresAt('session', 0, NOW, {})).toBe(NOW + DEFAULT_RETENTION_DAYS.session! * DAY)
  })

  it('never expires a category the table sets to null', () => {
    expect(expiresAt('session', 0, NOW, { session: null })).toBeUndefined()
  })

  it('treats an explicitly undefined entry as unset rather than as never', () => {
    expect(expiresAt('sprint', 0, NOW, { sprint: undefined })).toBe(NOW + DEFAULT_RETENTION_DAYS.sprint! * DAY)
  })

  it('applies a configured lifetime and the priority multiplier', () => {
    expect(expiresAt('decision', 1, NOW, { decision: 10 })).toBe(NOW + 15 * DAY)
  })
})
