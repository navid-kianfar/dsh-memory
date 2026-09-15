/**
 * Write `generated/` from the endpoint table in `typert-endpoints.mjs`.
 *
 * This runs on every build, so it deliberately does NOT record the fingerprint. The fingerprint is
 * the claim "someone checked the endpoint table against `src/host/` after it last changed"; a build
 * that re-recorded it would make that claim for every edit, and `check-typert.mjs` could never fail.
 * Recording it is `regen-typert.mjs`, run on purpose after updating the table.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { renderArtifacts } from './typert-emit.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Write every rendered file.
 * @returns the rendered files, keyed by path.
 */
export async function writeArtifacts() {
  const files = await renderArtifacts()
  await mkdir(new URL('generated/', `file://${ROOT}`), { recursive: true })
  for (const [path, content] of files) await writeFile(new URL(path, `file://${ROOT}`), content)
  return files
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await writeArtifacts()
  const host = files.get('generated/typert.host.js') ?? ''
  const hash = createHash('sha256').update(host).digest('hex').slice(0, 12)
  console.log(`typert: emitted generated/ (${hash}); run \`node scripts/regen-typert.mjs\` to record the fingerprint after changing the endpoint table`)
}
