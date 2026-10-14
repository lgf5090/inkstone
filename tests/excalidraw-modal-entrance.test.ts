import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The two classes the text-to-diagram modal and the official-library modal enter with.
 *
 * They used to enter with `animate-in fade-in zoom-in-95`, which nothing in this project defines: that
 * vocabulary belongs to an animation plugin that is not a dependency, so the classes were decoration for
 * an animation that never ran, and no test of the components could tell the difference. Read here rather
 * than in a component's own test because this is the project that may touch the filesystem.
 */
describe('the modal entrance animations', () => {
  const css = readFileSync('src/client/styles/app.css', 'utf8')

  const keyframeOf = (className: string): string => {
    const body = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    return /animation:\s*([\w-]+)/.exec(body)?.[1] ?? ''
  }

  it.each(['anim-fade', 'anim-pop'])('%s animates a keyframe the same file defines', (className) => {
    const keyframe = keyframeOf(className)
    expect(keyframe).toBeTruthy()
    expect(css).toContain(`@keyframes ${keyframe}`)
  })

  it('never defined the plugin classes the modals used to carry', () => {
    for (const dead of ['animate-in', 'fade-in', 'zoom-in-95']) {
      expect(css).not.toMatch(new RegExp(`\\.${dead}\\s*\\{`))
    }
  })
})
