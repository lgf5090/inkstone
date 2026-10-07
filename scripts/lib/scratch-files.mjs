// One definition of what a scratch probe is, so a measurement in flight is invisible
// to every scanner at once rather than to some of them. `**/*.tmp.*` is already the
// exclusion in both tsconfig projects and in the vitest project that globs the
// source tree, but the two text gates below walk the working tree themselves, so
// without the same rule here one session's probe turns the shared pipeline red for
// everyone else. The gate that names the leftovers out loud is
// tests/no-scratch-test-files.test.ts, and it stays loud on purpose: this module
// hides the noise, not the accountability.

import fs from 'node:fs'
import path from 'node:path'

export const SCRATCH_MARKER = '.tmp.'

export function isScratchPath(file) {
  return path.basename(file).includes(SCRATCH_MARKER)
}

export function* walkSource(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walkSource(target)
    else if (!isScratchPath(target)) yield target
  }
}
