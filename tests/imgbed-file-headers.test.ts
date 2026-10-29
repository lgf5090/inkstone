import { describe, expect, it } from 'vitest'
import { imgbedResponseHeaders, imgbedTransformHeaders, imgbedTransformPolicy } from '../src/worker/imgbed/file-headers'

const access = (overrides: Partial<{ enabled: boolean; sizes: string }> = {}) => ({
  allowedDomains: '',
  whiteListMode: false,
  imageTransformEnabled: overrides.enabled ?? true,
  imageTransformAllowedSizes: overrides.sizes ?? '',
})

describe('imgbed file headers', () => {
  it('forces active content to an attachment and keeps images inline', () => {
    const html = imgbedResponseHeaders({ fileType: 'text/html', fileName: 'x.html' })
    expect(html.get('Content-Type')).toBe('text/plain')
    expect(html.get('Content-Disposition')).toContain('attachment')
    expect(html.get('X-Content-Type-Options')).toBe('nosniff')

    const pdf = imgbedResponseHeaders({ fileType: 'application/pdf', fileName: 'x.pdf' })
    expect(pdf.get('Content-Disposition')).toContain('attachment')

    const png = imgbedResponseHeaders({ fileType: 'image/png', fileName: 'x.png' })
    expect(png.get('Content-Disposition')).toContain('inline')
    expect(png.get('Cache-Control')).toBe('public, max-age=300')
  })

  it('sandboxes SVG responses', () => {
    const svg = imgbedResponseHeaders({ fileType: 'image/svg+xml', fileName: 'x.svg' })
    expect(svg.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'")
    expect(svg.get('Content-Disposition')).toContain('inline')
  })

  it('rejects transforms while the setting is off', () => {
    const decision = imgbedTransformPolicy(new URLSearchParams({ width: '300' }), access({ enabled: false }))
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.status).toBe(403)
  })

  it('clamps dimensions and validates fit', () => {
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '5000' }), access()).ok).toBe(false)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '0' }), access()).ok).toBe(false)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '300', fit: 'cover' }), access()).ok).toBe(false)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '300', height: '200', fit: 'nope' }), access()).ok).toBe(false)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '300', height: '200', fit: 'cover' }), access()).ok).toBe(true)
  })

  it('enforces the allowed size list', () => {
    const sizes = '300x200, autox400'
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '300', height: '200' }), access({ sizes })).ok).toBe(true)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '301', height: '200' }), access({ sizes })).ok).toBe(false)
    expect(imgbedTransformPolicy(new URLSearchParams({ width: '300', height: '400' }), access({ sizes })).ok).toBe(false)
  })

  it('keeps cache and security headers on transformed responses', () => {
    const base = new Headers({
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ETag: '"abc"',
    })
    const transformed = new Response('x', { headers: { 'Content-Type': 'image/webp', 'Content-Length': '1' } })
    const merged = imgbedTransformHeaders(base, transformed, { requested: true, width: 300, height: 200, fallback: false })
    expect(merged.get('Cache-Control')).toBe('public, max-age=300')
    expect(merged.get('Access-Control-Allow-Origin')).toBe('*')
    expect(merged.get('X-Content-Type-Options')).toBe('nosniff')
    expect(merged.get('Content-Type')).toBe('image/webp')
    expect(merged.get('ETag')).toContain('300x200')
  })
})
