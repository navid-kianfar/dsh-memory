/**
 * The one definition of what the vendored Typert artifact is generated FROM.
 *
 * `generated/` is produced by the harness's Typert generator, which only runs inside a
 * deepseek-harness checkout. That makes it a build output this package cannot rebuild on its own, so
 * it is committed — and a committed build output rots silently unless something watches its inputs.
 * The fingerprint is that watch: any edit to the Host surface invalidates it.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Sources the generator reads: the `@Remote` methods and every type they name. */
export const TYPERT_INPUTS = ['src/host/index.ts', 'src/host/types.ts']

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
