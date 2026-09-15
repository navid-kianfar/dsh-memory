/**
 * The drift check itself: that `check-typert.mjs` can actually fail.
 *
 * A check that re-derives its own baseline passes forever. These run the real scripts against a
 * throwaway copy of the inputs they read, change one input at a time, and require the check to notice
 * — and require the everyday build NOT to silence it, since the build runs on every install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

let copy: string

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'dsh-memory-typert-'))
  cpSync(join(REPO, 'scripts'), join(copy, 'scripts'), { recursive: true })
  cpSync(join(REPO, 'generated'), join(copy, 'generated'), { recursive: true })
  mkdirSync(join(copy, 'src', 'host'), { recursive: true })
  for (const file of ['index.ts', 'types.ts']) cpSync(join(REPO, 'src', 'host', file), join(copy, 'src', 'host', file))
})

afterEach(() => {
  rmSync(copy, { recursive: true, force: true })
})

/**
 * Run one of the copied scripts.
 * @param script - the script's file name under `scripts/`.
 * @returns whether it exited zero.
 */
function run(script: string): boolean {
  try {
    execFileSync(process.execPath, [join(copy, 'scripts', script)], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('check-typert', () => {
  it('passes on the committed artifact', () => {
    expect(run('check-typert.mjs')).toBe(true)
  })

  it('fails when the endpoint table changes, and a build does not make it pass again', () => {
    appendFileSync(join(copy, 'scripts', 'typert-endpoints.mjs'), '\n// a changed table\n')
    expect(run('check-typert.mjs')).toBe(false)
    expect(run('build-typert.mjs')).toBe(true)
    expect(run('check-typert.mjs')).toBe(false)
    expect(run('regen-typert.mjs')).toBe(true)
    expect(run('check-typert.mjs')).toBe(true)
  })

  it('fails when the Host surface changes', () => {
    appendFileSync(join(copy, 'src', 'host', 'types.ts'), '\nexport type Drift = string\n')
    expect(run('check-typert.mjs')).toBe(false)
  })

  it('fails when a generated file was edited by hand', () => {
    writeFileSync(join(copy, 'generated', 'typert.remote-client.d.ts'), '/* edited */\n')
    expect(run('check-typert.mjs')).toBe(false)
  })
})
