/**
 * Regenerate `generated/` and record the fingerprint of everything it was generated from.
 *
 * Run this after updating `typert-endpoints.mjs` to match a change in `src/host/index.ts` or
 * `src/host/types.ts`. Recording the fingerprint is the acknowledgement that the table was checked
 * against the Host surface, which is why the everyday build does not do it.
 */
import { writeFile } from 'node:fs/promises'
import { writeArtifacts } from './build-typert.mjs'
import { FINGERPRINT_FILE, ROOT, fingerprint } from './typert-fingerprint.mjs'

const files = await writeArtifacts()
await writeFile(new URL(FINGERPRINT_FILE, `file://${ROOT}`), `${await fingerprint()}\n`)
console.log(`typert: regenerated ${files.size} file(s) and recorded the fingerprint`)
