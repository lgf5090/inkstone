const BASE = process.argv[2] ?? process.env.INKSTONE_BASE ?? 'http://localhost:8896'
const USER = process.env.INKSTONE_USER ?? 'iconsdev'
const PASS = process.env.INKSTONE_PASS ?? 'IconsDev!2026'
let pass = 0
let fail = 0

function check(name, condition, extra = '') {
  if (condition) {
    pass += 1
    console.log(`  ok ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

function cookieFrom(response) {
  const values = response.headers.getSetCookie?.() ?? []
  const single = values.length ? values[0] : response.headers.get('set-cookie')
  return single ? single.split(';')[0] : ''
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  if (!response.ok) throw new Error(`login ${response.status}`)
  const cookie = cookieFrom(response)
  if (!cookie) throw new Error('login returned no session cookie')
  return cookie
}

function client(cookie) {
  return async function request(method, path, body, headers = {}) {
    const isForm = body instanceof FormData
    const response = await fetch(`${BASE}/api/development/icons${path}`, {
      method,
      headers: {
        'x-inkstone-client': '1',
        cookie,
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
    const type = response.headers.get('content-type') ?? ''
    const data = type.includes('json') ? await response.json().catch(() => null) : await response.arrayBuffer()
    return { status: response.status, data, headers: response.headers }
  }
}

function svg(tag) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${tag}</title><path d="M2 2h20v20H2z" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
}

async function waitFor(fn, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

const suffix = Date.now().toString(36)
const collectionName = `e2e-col-${suffix}`
const tagName = `e2e-tag-${suffix}`
const iconName = `e2e-icon-${suffix}`

const cookie = await login()
const api = client(cookie)
const created = { assetId: null, collectionId: null, tagId: null }

try {
  console.log('[collection]')
  const collection = await api('POST', '/collections', { name: collectionName, description: '', source: 'upload', license: '', homepage: '', sortOrder: 0 })
  check('create collection', collection.status === 201 && collection.data?.data?.id, JSON.stringify(collection.data))
  created.collectionId = collection.data?.data?.id ?? null
  const renamed = await api('PATCH', `/collections/${created.collectionId}`, { name: `${collectionName}-renamed` })
  check('rename collection', renamed.status === 200)

  console.log('[tag]')
  const tag = await api('POST', '/tags', { name: tagName, color: '#336699', parentId: null, sortOrder: 0 })
  check('create tag', tag.status === 201 && tag.data?.data?.id, JSON.stringify(tag.data))
  created.tagId = tag.data?.data?.id ?? null

  console.log('[upload]')
  const form = new FormData()
  form.set('file', new Blob([svg(iconName)], { type: 'image/svg+xml' }), `${iconName}.svg`)
  form.set('name', iconName)
  form.set('collectionId', created.collectionId)
  const uploaded = await api('POST', '/assets', form)
  check('upload svg', uploaded.status === 201 && uploaded.data?.data?.asset?.id, JSON.stringify(uploaded.data))
  created.assetId = uploaded.data?.data?.asset?.id ?? null
  check('uploaded asset named', uploaded.data?.data?.asset?.name === iconName)

  console.log('[thumbnail]')
  const thumbUrl = await waitFor(async () => {
    const detail = await api('GET', `/assets/${created.assetId}`)
    const url = detail.data?.data?.thumbUrl ?? ''
    return url.includes('/webp/') ? url : null
  }, 15000)
  check('96px webp thumbnail generated', Boolean(thumbUrl), 'thumbUrl did not become webp within 15s')
  if (thumbUrl) {
    const thumb = await fetch(BASE + thumbUrl, { headers: { cookie, 'x-inkstone-client': '1' } })
    check('thumbnail serves webp', thumb.ok && (thumb.headers.get('content-type') ?? '').includes('image/webp'))
  }
  const origin = await fetch(BASE + (uploaded.data?.data?.asset?.rawUrl ?? ''), { headers: { cookie, 'x-inkstone-client': '1' } })
  check('original loads on demand', origin.ok)

  console.log('[tag link]')
  const tagged = await api('PATCH', `/assets/${created.assetId}`, { tagIds: [created.tagId] })
  check('attach tag', tagged.status === 200 && tagged.data?.data?.tags?.length === 1)

  console.log('[list and search]')
  const list = await api('GET', '/assets?limit=60')
  check('list returns assets', list.status === 200 && Array.isArray(list.data?.data?.items))
  const search = await api('GET', `/assets?limit=10&q=${encodeURIComponent(iconName)}`)
  check('search finds uploaded icon', (search.data?.data?.items ?? []).some((item) => item.id === created.assetId))
  const detail = await api('GET', `/assets/${created.assetId}`)
  check('detail carries collection and tag', detail.status === 200 && detail.data?.data?.collectionId === created.collectionId && detail.data?.data?.tags?.some((entry) => entry.id === created.tagId))

  console.log('[batch convert]')
  const job = await api('POST', '/jobs', { assetIds: [created.assetId], options: { kind: 'png', sizes: [24, 48] } })
  check('create conversion job', job.status === 202 && job.data?.data?.id, JSON.stringify(job.data))
  const jobId = job.data?.data?.id
  const mode = job.data?.data?.mode
  if (mode === 'queue') {
    const done = await waitFor(async () => {
      const current = await api('GET', `/jobs/${jobId}`)
      return ['done', 'partial', 'failed'].includes(current.data?.data?.status) ? current.data.data : null
    }, 30000)
    check('queued job finishes with outputs', done?.status === 'done', JSON.stringify(done))
    const items = await api('GET', `/jobs/${jobId}/items`)
    const outputs = items.data?.data?.[0]?.outputs ?? {}
    check('job records png outputs', Boolean(outputs['24'] && outputs['48']), JSON.stringify(outputs))
    const png = outputs['48'] ? await fetch(BASE + outputs['48'], { headers: { cookie, 'x-inkstone-client': '1' } }) : null
    const pngBytes = png ? new Uint8Array(await png.arrayBuffer()) : new Uint8Array()
    check('downloaded output is a PNG', pngBytes[0] === 0x89 && pngBytes[1] === 0x50, `${pngBytes.length} bytes`)
  } else {
    check('browser mode returns a job for client conversion', Boolean(jobId))
  }

  console.log('[export zip]')
  const exported = await api('POST', '/exports', { format: 'zip', assetIds: [created.assetId] })
  check('create zip export', exported.status === 201 && exported.data?.data?.id, JSON.stringify(exported.data))
  const download = await fetch(BASE + (exported.data?.data?.downloadUrl ?? ''), { headers: { cookie, 'x-inkstone-client': '1' } })
  const zip = new Uint8Array(await download.arrayBuffer())
  check('zip download starts with PK', zip[0] === 0x50 && zip[1] === 0x4b, `${zip.length} bytes`)

  console.log('[iconify import]')
  const imported = await api('POST', '/imports', { kind: 'iconify', prefix: 'lucide', limit: 2 })
  check('iconify import completes', imported.status === 201 && imported.data?.data?.status === 'done', JSON.stringify(imported.data))
} finally {
  console.log('[cleanup]')
  if (created.assetId) await api('DELETE', `/assets/${created.assetId}`)
  if (created.tagId) await api('DELETE', `/tags/${created.tagId}`)
  if (created.collectionId) await api('DELETE', `/collections/${created.collectionId}`)
}

console.log(JSON.stringify({ pass, fail }))
if (fail) process.exit(1)
