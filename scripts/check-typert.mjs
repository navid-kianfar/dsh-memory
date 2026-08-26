/**
 * Fail when the emitted Typert artifact no longer matches the Host surface it describes.
 *
 * A stale artifact is not a build error — it is a silent wire mismatch: the browser validates
 * arguments and results against schemas that no longer describe what the Host sends. This check is
 * the only thing standing between an edit to `src/host/` and that failure reaching a user.
 */
import { readFile } from 'node:fs/promises'
import {
  FINGERPRINT_FILE, ROOT, declaredEndpoints, fingerprint, generatedEndpoints,
} from './typert-fingerprint.mjs'

const REGENERATE = 'run `node scripts/build-typert.mjs` after updating scripts/typert-endpoints.mjs'

// Compared as SETS: the artifact and the source are both written in a readable order, and the two
// orders agreeing is a coincidence rather than a contract.
const declared = [...await declaredEndpoints()].sort()
const generated = [...await generatedEndpoints()].sort()
if (declared.join(',') !== generated.join(',')) {
  console.error(`typert: endpoints differ.\n  src/host declares: ${declared.join(', ') || '(none)'}`)
  console.error(`  generated/ carries: ${generated.join(', ') || '(none)'}\n  ${REGENERATE}`)
  process.exit(1)
}

let recorded
try {
  recorded = (await readFile(new URL(FINGERPRINT_FILE, `file://${ROOT}`), 'utf8')).trim()
} catch {
  // No fingerprint at all means the artifact predates this check, which is indistinguishable from
  // stale — refuse rather than assume it happens to be current.
  console.error(`typert: ${FINGERPRINT_FILE} is missing; ${REGENERATE}`)
  process.exit(1)
}

const current = await fingerprint()
if (recorded !== current) {
  console.error(`typert: the Host surface changed since generated/ was produced.\n  ${REGENERATE}`)
  console.error('  (a comment-only edit trips this too — regenerating is cheap and always correct)')
  process.exit(1)
}
console.log(`typert: artifact matches the Host surface (${declared.length} endpoint(s))`)
