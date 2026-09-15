/**
 * The one definition of what the vendored Typert artifact is generated FROM.
 *
 * `generated/` is rendered by `typert-emit.mjs` from a hand-maintained endpoint table, because the
 * harness's own Typert generator only runs inside a deepseek-harness checkout. It is committed, and a
 * committed output of a hand-maintained input rots silently unless something watches both. The
 * fingerprint is that watch: any edit to the Host surface or to the table invalidates it, and only
 * `regen-typert.mjs` — run on purpose — records a new one.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Everything `generated/` is a function of: the `@Remote` methods and every type they name, the
 * endpoint table the artifact is rendered from, and the renderer itself. Leaving the table out would
 * let it drift from the Host surface — or be edited without regenerating — with the check still green.
 */
export const TYPERT_INPUTS = [
  'src/host/index.ts', 'src/host/types.ts', 'scripts/typert-endpoints.mjs', 'scripts/typert-emit.mjs',
]

/** Where the recorded fingerprint lives. */
export const FINGERPRINT_FILE = 'generated/.fingerprint'

/** Repository root, resolved from this script's own location. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Hash the generator's inputs.
 * @returns a hex digest covering every input file, in a fixed order.
 */
export async function fingerprint() {
  const hash = createHash('sha256')
  for (const relative of TYPERT_INPUTS) {
    hash.update(relative)
    hash.update(await readFile(new URL(relative, `file://${ROOT}`)))
  }
  return hash.digest('hex')
}

/**
 * Read the `@Remote` method names the Host currently declares.
 * @returns the declared endpoint names, in source order.
 */
export async function declaredEndpoints() {
  const source = await readFile(new URL('src/host/index.ts', `file://${ROOT}`), 'utf8')
  return [...source.matchAll(/@Remote\('([^']+)'\)/g)].map(match => match[1])
}

/**
 * Read the endpoint names the vendored artifact carries.
 * @returns the generated method names, in artifact order.
 */
export async function generatedEndpoints() {
  const source = await readFile(new URL('generated/typert.remote-client.js', `file://${ROOT}`), 'utf8')
  return [...source.matchAll(/^\s+method: '([^']+)',$/gm)].map(match => match[1])
}
