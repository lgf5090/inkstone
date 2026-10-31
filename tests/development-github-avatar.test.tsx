// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { GithubAvatar } from '../src/client/features/development/github/components/GithubAvatar'
import { renderElement } from '../src/client/lib/test-render'

describe('GitHub avatar', () => {
  it('falls back to the owner initial when the image is missing or fails', () => {
    const missing = renderElement(<GithubAvatar src="" name="octo" />)
    expect(missing.container.textContent).toBe('O')
    missing.unmount()

    const broken = renderElement(<GithubAvatar src="https://avatars.example.com/octo.png" name="zed" />)
    const image = broken.container.querySelector('img')
    expect(image).not.toBeNull()
    act(() => { image!.dispatchEvent(new Event('error')) })
    expect(broken.container.textContent).toBe('Z')
    broken.unmount()
  })
})
