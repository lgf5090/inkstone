


const BASE = process.argv[2] ?? 'http://localhost:7712'
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

function getSetCookie(response) {
  const values = response.headers.getSetCookie?.() ?? []
  if (values.length) return values
  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

function byteStream(total, chunkSize = 256 * 1024) {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close()
        return
      }
      const size = Math.min(chunkSize, total - sent)
      sent += size
      controller.enqueue(new Uint8Array(size))
    },
  })
}

function makeClient() {
  const jar = { cookie: '' }
  return {
    jar,
    async req(method, path, body, headers = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          'X-Inkstone-Client': '1',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(jar.cookie ? { Cookie: jar.cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      })
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const kv = c.split(';')[0]
        if (kv.startsWith('inkstone_session=')) jar.cookie = kv.split('=')[1] ? kv : ''
      }
      const isJson = res.headers.get('content-type')?.includes('json')
      const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '')
      return { status: res.status, data }
    },
  }
}

async function importJson(client, bundle, filename = 'inkstone-export.json') {
  const form = new FormData()
  form.set('file', new Blob([JSON.stringify(bundle)], { type: 'application/json' }), filename)
  form.set('conflict', 'newer')
  const res = await fetch(BASE + '/api/import', {
    method: 'POST',
    headers: {
      'X-Inkstone-Client': '1',
      ...(client.jar.cookie ? { Cookie: client.jar.cookie } : {}),
    },
    body: form,
  })
  return {
    status: res.status,
    data: await res.json().catch(() => null),
  }
}

const owner = makeClient()

console.log('[setup]')
{
  const s = await owner.req('GET', '/api/auth/session')
  check('site name is Inkstone', s.data?.site?.name === 'Inkstone', JSON.stringify(s.data?.site))
  check('fresh instance (not initialized)', s.data?.site?.initialized === false)

  const health = await fetch(BASE + '/api/health')
  check('API responses disable MIME sniffing', health.headers.get('x-content-type-options') === 'nosniff')
  check('API responses deny framing', health.headers.get('x-frame-options') === 'DENY')
  check('API responses are not cached', health.headers.get('cache-control') === 'no-store')
}

console.log('[register validation]')
{
  const bad = await owner.req('POST', '/api/auth/register', { username: 'Bad Name!', password: 'supersecret99' })
  check('invalid username -> 400', bad.status === 400 && bad.data?.error?.code === 'invalid_username')
  const weak = await owner.req('POST', '/api/auth/register', { username: 'owner-1', password: 'short' })
  check('weak password -> 400', weak.status === 400 && weak.data?.error?.code === 'weak_password')
  const oversized = await owner.req('POST', '/api/auth/register', {
    username: 'owner-1',
    password: 'x'.repeat(5000),
  })
  check(
    'oversized auth body -> 413',
    oversized.status === 413 && oversized.data?.error?.code === 'payload_too_large',
  )
}

console.log('[register owner]')
{
  const reg = await owner.req('POST', '/api/auth/register', { username: 'Owner-1', password: 'supersecret99', locale: 'zh-CN' })
  check('register -> 201 owner', reg.status === 201 && reg.data?.user?.role === 'owner', JSON.stringify(reg.data?.error ?? reg.data?.user))
  check('username normalized', reg.data?.user?.username === 'owner-1')
  check('session cookie set', owner.jar.cookie.length > 0)

  const notes = await owner.req('GET', '/api/notes?view=all')
  const list = notes.data?.notes ?? notes.data?.items ?? []
  check('workspace starts with exactly two bilingual notes', Array.isArray(list) && list.length === 2, `status=${notes.status} n=${list.length}`)
  const englishWelcome = list.find((note) => /^Welcome to Inkstone/u.test(note.title ?? ''))
  const chineseWelcome = list.find(
    (note) => note.id !== englishWelcome?.id && /Inkstone/u.test(note.title ?? ''),
  )
  check(
    'workspace includes Chinese and English welcome notes',
    Boolean(chineseWelcome && englishWelcome),
    JSON.stringify(list.slice(0, 2).map((note) => note.title)),
  )
  if (chineseWelcome?.id) {
    const full = await owner.req('GET', `/api/notes/${chineseWelcome.id}`)
    const content = full.data?.content ?? ''
    check('Chinese welcome note uses formal YAML Front Matter', /^---\r?\ntitle:/u.test(content))
    check('Chinese welcome note contains Han text', /\p{Script=Han}/u.test(content))
    check('Chinese welcome note documents Windows shortcuts only', /Ctrl \+ K/u.test(content) && !/[⌘]|\b(?:Command|Cmd|macOS)\b/u.test(content))
  }
  if (englishWelcome?.id) {
    const full = await owner.req('GET', `/api/notes/${englishWelcome.id}`)
    const content = full.data?.content ?? ''
    check('English welcome note uses formal YAML Front Matter', /^---\r?\ntitle:/u.test(content))
    check('English welcome note contains no Han text', !/\p{Script=Han}/u.test(content))
    check('English welcome note documents Windows shortcuts only', /Ctrl \+ K/u.test(content) && !/[⌘]|\b(?:Command|Cmd|macOS)\b/u.test(content))
  }

  const dup = await owner.req('POST', '/api/auth/register', { username: 'other', password: 'supersecret99' })
  check('registration closed after first user', dup.status === 403 && dup.data?.error?.code === 'registration_closed')
}

console.log('[profile]')
{
  const anonymous = makeClient()
  const denied = await anonymous.req('PUT', '/api/auth/profile', { name: 'No session' })
  check('profile update requires authentication', denied.status === 401)

  const before = await owner.req('GET', '/api/sync?since=0')
  const renamed = await owner.req('PUT', '/api/auth/profile', { name: '  Owner   Writer  ' })
  check(
    'display name is normalized without changing username',
    renamed.status === 200 &&
      renamed.data?.name === 'Owner Writer' &&
      renamed.data?.username === 'owner-1',
    JSON.stringify(renamed.data),
  )
  const delta = await owner.req('GET', `/api/sync?since=${before.data?.cursor ?? 0}`)
  check('profile changes enter the multi-device sync stream', delta.status === 200 && delta.data?.profileChanged === true)

  const generatedValue = 'dicebear:0123456789abcdef0123456789abcdef'
  const generated = await owner.req('PUT', '/api/auth/profile', { avatarUrl: generatedValue })
  check('generated avatar seed persists', generated.status === 200 && generated.data?.avatarUrl === generatedValue)

  const invalidSeed = await owner.req('PUT', '/api/auth/profile', { avatarUrl: 'dicebear:short' })
  check('invalid generated avatar seed -> 400', invalidSeed.status === 400 && invalidSeed.data?.error?.code === 'invalid_avatar')
  const remoteImage = await owner.req('PUT', '/api/auth/profile', { avatarUrl: 'https://tracker.invalid/avatar.png' })
  check('remote avatar URL is rejected', remoteImage.status === 400 && remoteImage.data?.error?.code === 'invalid_avatar')
  const svgImage = await owner.req('PUT', '/api/auth/profile', { avatarUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })
  check('uploaded SVG avatar is rejected', svgImage.status === 400 && svgImage.data?.error?.code === 'invalid_avatar')

  const uploadedValue = 'data:image/png;base64,iVBORw0KGgo='
  const uploaded = await owner.req('PUT', '/api/auth/profile', { avatarUrl: uploadedValue })
  const storedAvatarUrl = uploaded.data?.avatarUrl
  check(
    'validated bitmap avatar stores only an object URL in D1',
    uploaded.status === 200 && /^\/api\/avatars\/(?:r2|kv)\//.test(storedAvatarUrl ?? ''),
  )
  const avatarImage = storedAvatarUrl ? await fetch(BASE + storedAvatarUrl) : null
  check(
    'stored avatar bytes remain publicly readable',
    avatarImage?.status === 200 && Buffer.from(await avatarImage.arrayBuffer()).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  )
  const renamedAgain = await owner.req('PUT', '/api/auth/profile', { name: 'Owner Notes' })
  check(
    'name-only update preserves a custom avatar',
    renamedAgain.status === 200 && renamedAgain.data?.avatarUrl === storedAvatarUrl,
  )
  const reset = await owner.req('PUT', '/api/auth/profile', { avatarUrl: '' })
  check('empty avatar preference restores name-derived default', reset.status === 200 && reset.data?.avatarUrl === '')

  const wrongIdentity = makeClient()
  const displayNameLogin = await wrongIdentity.req('POST', '/api/auth/login', {
    username: 'Owner Notes',
    password: 'supersecret99',
  })
  check('display name cannot replace the sign-in username', displayNameLogin.status === 401)
  const session = await owner.req('GET', '/api/auth/session')
  check(
    'profile survives a fresh session read',
    session.status === 200 &&
      session.data?.user?.name === 'Owner Notes' &&
      session.data?.user?.username === 'owner-1' &&
      session.data?.user?.avatarUrl === '',
  )
}

console.log('[notes smoke]')
let noteId = null
{
  const oversizedFolder = await owner.req('POST', '/api/folders', { name: 'x'.repeat(9000) })
  check('oversized JSON is rejected before route validation',
    oversizedFolder.status === 413 && oversizedFolder.data?.error?.code === 'payload_too_large')

  const invalid = await owner.req('POST', '/api/notes', { title: 42 })
  check('invalid note field type -> 400', invalid.status === 400, `status=${invalid.status}`)

  const created = await owner.req('POST', '/api/notes', { content: '# e2e \u5192\u70df\n\n\u8fd9\u4e00\u7bc7\u7531\u6d4b\u8bd5\u521b\u5efa\u3002 #zeta #alpha' })
  noteId = created.data?.id ?? null
  check('create note', created.status === 200 || created.status === 201, `status=${created.status}`)
  check('note tags use a stable canonical order on create', JSON.stringify(created.data?.tags) === JSON.stringify(['alpha', 'zeta']))
  if (noteId) {
    const missingRev = await owner.req('PATCH', `/api/notes/${noteId}`, {
      content: '# \u4e0d\u5141\u8bb8\u7ed5\u8fc7\u5e76\u53d1\u4fdd\u62a4',
    })
    check('save without rev -> 400', missingRev.status === 400, `status=${missingRev.status}`)

    const invalidFolder = await owner.req('PATCH', `/api/notes/${noteId}`, {
      rev: created.data.rev,
      folderId: 'folder-does-not-exist',
    })
    check('invalid folder is not silently ignored', invalidFolder.status === 400)

    const restoreActive = await owner.req('POST', `/api/notes/${noteId}/restore`)
    check('active note cannot be restored', restoreActive.status === 400)
    const purgeActive = await owner.req('DELETE', `/api/notes/${noteId}/purge`)
    check('active note cannot be purged', purgeActive.status === 404)

    const patched = await owner.req('PATCH', `/api/notes/${noteId}`, {
      rev: created.data.rev,
      content: '# e2e \u5192\u70df\n\n\u6539\u8fc7\u4e00\u7248\u3002 #zeta #alpha',
    })
    check('save with rev', (patched.status === 200) && patched.data?.rev === created.data.rev + 1, `status=${patched.status}`)
    check('note tag order stays stable after save', JSON.stringify(patched.data?.tags) === JSON.stringify(['alpha', 'zeta']))
    const search = await owner.req('GET', `/api/search?q=${encodeURIComponent('\u5192\u70df')}`)
    const hits = search.data?.results ?? search.data?.notes ?? []
    check('chinese search finds it', Array.isArray(hits) && hits.length >= 1, `status=${search.status} n=${hits.length}`)
  }
}

console.log('[trash sync]')
if (noteId) {
  const trashed = await owner.req('DELETE', `/api/notes/${noteId}`)
  check('move note to trash', trashed.status === 200)

  const sync = await owner.req('GET', '/api/sync?since=0')
  const synced = sync.data?.notes?.find((note) => note.id === noteId)
  check('full sync includes trashed note', sync.status === 200 && Boolean(synced?.deletedAt))

  const hidden = await owner.req('GET', `/api/search?q=${encodeURIComponent('\u5192\u70df')}`)
  const hiddenHits = hidden.data?.results ?? []
  check('trashed note is absent from search', !hiddenHits.some((hit) => hit.note?.id === noteId))

  const trashSearch = await owner.req('GET', `/api/search?q=${encodeURIComponent('\u5192\u70df in:trash')}`)
  check(
    'text search can find a note inside trash',
    trashSearch.data?.mode === 'like' &&
      (trashSearch.data?.results ?? []).some((hit) => hit.note?.id === noteId),
  )

  const restored = await owner.req('POST', `/api/notes/${noteId}/restore`)
  check('restore note', restored.status === 200 && restored.data?.deletedAt === null)
}

console.log('[permanent delete cursor]')
{
  const created = await owner.req('POST', '/api/notes', { content: '# deletion cursor probe' })
  await owner.req('DELETE', `/api/notes/${created.data?.id}`)
  const purged = await owner.req('DELETE', `/api/notes/${created.data?.id}/purge`)
  const cursor = purged.data?.cursor
  check('permanent delete returns its exact change cursor',
    purged.status === 200 && Number.isSafeInteger(cursor) && cursor > 0)

  const staleWrite = await owner.req('PATCH', `/api/notes/${created.data?.id}`, {
    rev: created.data?.rev,
    content: '# must recover locally',
  })
  check('write to a purged note reports the same deletion cursor',
    staleWrite.status === 404 && staleWrite.data?.error?.details?.deletionCursor === cursor)
}

console.log('[search filters and stable backlinks]')
{
  const noisy = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      owner.req('POST', '/api/notes', {
        content: `# filterneedleunique ${index + 1}\n\n${'filterneedleunique '.repeat(10)}`,
      }),
    ),
  )
  const eligible = await owner.req('POST', '/api/notes', {
    content: '# \u552f\u4e00\u5408\u683c\u641c\u7d22\u7ed3\u679c\n\nfilterneedleunique #filtermatchtag',
  })
  const filtered = await owner.req(
    'GET',
    `/api/search?q=${encodeURIComponent('filterneedleunique tag:filtermatchtag')}&limit=1`,
  )
  check('create FTS filter fixtures', noisy.every((item) => item.status === 201) && eligible.status === 201)
  check(
    'FTS applies tag filters before ranking and limit',
    filtered.status === 200 && filtered.data?.mode === 'fts' &&
      filtered.data?.results?.length === 1 && filtered.data.results[0]?.note?.id === eligible.data?.id,
  )

  const [reindexed, editedDuringReindex] = await Promise.all([
    owner.req('POST', '/api/search/reindex'),
    owner.req('PATCH', `/api/notes/${eligible.data?.id}`, {
      rev: eligible.data?.rev,
      content: '# \u552f\u4e00\u5408\u683c\u641c\u7d22\u7ed3\u679c\n\nreindexeditorwinner #filtermatchtag',
    }),
  ])
  const [newIndexSearch, staleIndexSearch] = await Promise.all([
    owner.req('GET', `/api/search?q=${encodeURIComponent('reindexeditorwinner')}`),
    owner.req(
      'GET',
      `/api/search?q=${encodeURIComponent('filterneedleunique tag:filtermatchtag')}&limit=1`,
    ),
  ])
  check(
    'reindex cannot overwrite an editor write with a stale FTS row',
    reindexed.status === 200 && editedDuringReindex.status === 200 &&
      (newIndexSearch.data?.results ?? []).some((hit) => hit.note?.id === eligible.data?.id) &&
      !(staleIndexSearch.data?.results ?? []).some((hit) => hit.note?.id === eligible.data?.id),
    `reindex=${reindexed.status} edit=${editedDuringReindex.status}`,
  )

  const targetA = await owner.req('POST', '/api/notes', {
    title: 'Stable Link Target',
    content: '# Stable Link Target\n\nA',
  })
  const targetB = await owner.req('POST', '/api/notes', {
    title: 'Stable Link Target',
    content: '# Stable Link Target\n\nB',
  })
  const source = await owner.req('POST', '/api/notes', {
    content: '# Stable Link Source\n\n[[Stable Link Target]]',
  })
  const [backA, backB] = await Promise.all([
    owner.req('GET', `/api/notes/${targetA.data?.id}/backlinks`),
    owner.req('GET', `/api/notes/${targetB.data?.id}/backlinks`),
  ])
  const pointsToA = (backA.data?.backlinks ?? []).some((item) => item.id === source.data?.id)
  const pointsToB = (backB.data?.backlinks ?? []).some((item) => item.id === source.data?.id)
  check(
    'duplicate-title link resolves to exactly one deterministic target',
    targetA.status === 201 && targetB.status === 201 && source.status === 201 && pointsToA !== pointsToB,
  )

  const winner = pointsToA ? targetA : targetB
  const fallback = pointsToA ? targetB : targetA
  const renamed = await owner.req('PATCH', `/api/notes/${winner.data?.id}`, {
    rev: winner.data?.rev,
    title: 'Renamed Link Target',
    content: '# Renamed Link Target\n\nrenamed',
  })
  const fallbackBacklinks = await owner.req('GET', `/api/notes/${fallback.data?.id}/backlinks`)
  const renamedBacklinks = await owner.req('GET', `/api/notes/${winner.data?.id}/backlinks`)
  check(
    'renaming a target re-resolves old-title links to the remaining duplicate',
    renamed.status === 200 &&
      (fallbackBacklinks.data?.backlinks ?? []).some((item) => item.id === source.data?.id) &&
      !(renamedBacklinks.data?.backlinks ?? []).some((item) => item.id === source.data?.id),
  )

  const targetC = await owner.req('POST', '/api/notes', {
    title: 'Stable Link Target',
    content: '# Stable Link Target\n\nC',
  })
  const trashedFallback = await owner.req('DELETE', `/api/notes/${fallback.data?.id}`)
  const thirdBacklinks = await owner.req('GET', `/api/notes/${targetC.data?.id}/backlinks`)
  check(
    'trashing a target re-resolves links to the next deterministic duplicate',
    targetC.status === 201 && trashedFallback.status === 200 &&
      (thirdBacklinks.data?.backlinks ?? []).some((item) => item.id === source.data?.id),
  )

  const restoredFallback = await owner.req('POST', `/api/notes/${fallback.data?.id}/restore`)
  const restoredBacklinks = await owner.req('GET', `/api/notes/${fallback.data?.id}/backlinks`)
  const graph = await owner.req('GET', '/api/graph')
  check(
    'restoring the older duplicate deterministically takes its links back',
    restoredFallback.status === 200 &&
      (restoredBacklinks.data?.backlinks ?? []).some((item) => item.id === source.data?.id) &&
      (graph.data?.edges ?? []).some(
        (edge) => edge.source === source.data?.id && edge.target === fallback.data?.id,
      ),
  )

  const spacedTarget = await owner.req('POST', '/api/notes', {
    title: 'Spaced   Link   Target',
    content: 'manual title spacing',
  })
  const spacedSource = await owner.req('POST', '/api/notes', {
    content: '# Spaced Link Source\n\n[[Spaced Link Target]]',
  })
  const spacedBacklinks = await owner.req('GET', `/api/notes/${spacedTarget.data?.id}/backlinks`)
  check(
    'normalized title keys match links across repeated whitespace',
    spacedTarget.status === 201 && spacedSource.status === 201 &&
      (spacedBacklinks.data?.backlinks ?? []).some((item) => item.id === spacedSource.data?.id),
  )
}

console.log('[atomic note writes]')
{
  const created = await owner.req('POST', '/api/notes', { content: '# \u5e76\u53d1\u57fa\u7ebf\n\n\u7b49\u5f85\u7ade\u4e89\u5199\u5165\u3002' })
  const raceId = created.data?.id
  check('create race note', created.status === 201 && Boolean(raceId))

  if (raceId) {
    const alphaContent = '# \u539f\u5b50\u5199\u5165 Alpha\n\natomicwinneralpha #race-alpha [[Alpha Target]]'
    const betaContent = '# \u539f\u5b50\u5199\u5165 Beta\n\natomicwinnerbeta #race-beta [[Beta Target]]'
    const [alpha, beta] = await Promise.all([
      owner.req('PATCH', `/api/notes/${raceId}`, { rev: created.data.rev, content: alphaContent }),
      owner.req('PATCH', `/api/notes/${raceId}`, { rev: created.data.rev, content: betaContent }),
    ])
    const outcomes = [alpha, beta]
    const winner = outcomes.find((result) => result.status === 200)
    const loser = outcomes.find((result) => result.status === 409)
    check('same-rev concurrent saves produce one winner and one conflict', Boolean(winner && loser),
      `statuses=${outcomes.map((result) => result.status).join(',')}`)

    const current = await owner.req('GET', `/api/notes/${raceId}`)
    const winnerIsAlpha = winner?.data?.content === alphaContent
    const expectedContent = winnerIsAlpha ? alphaContent : betaContent
    const expectedTag = winnerIsAlpha ? 'race-alpha' : 'race-beta'
    const rejectedTag = winnerIsAlpha ? 'race-beta' : 'race-alpha'
    check('winner content is the durable note state', current.data?.content === expectedContent)
    check(
      'derived tags match only the CAS winner',
      current.data?.tags?.includes(expectedTag) && !current.data?.tags?.includes(rejectedTag),
      JSON.stringify(current.data?.tags),
    )
    check(
      'conflict response carries the durable winner',
      loser?.data?.error?.details?.server?.content === expectedContent,
    )

    const winnerSearch = await owner.req(
      'GET',
      `/api/search?q=${encodeURIComponent(winnerIsAlpha ? 'atomicwinneralpha' : 'atomicwinnerbeta')}`,
    )
    const loserSearch = await owner.req(
      'GET',
      `/api/search?q=${encodeURIComponent(winnerIsAlpha ? 'atomicwinnerbeta' : 'atomicwinneralpha')}`,
    )
    check('FTS contains the CAS winner', (winnerSearch.data?.results ?? []).some((hit) => hit.note?.id === raceId))
    check('FTS excludes the rejected write', !(loserSearch.data?.results ?? []).some((hit) => hit.note?.id === raceId))

    const baseRev = current.data?.rev
    const [pin, star] = await Promise.all([
      owner.req('PATCH', `/api/notes/${raceId}`, { rev: baseRev, isPinned: true }),
      owner.req('PATCH', `/api/notes/${raceId}`, { rev: baseRev, isStarred: true }),
    ])
    check(
      'metadata writes use the same CAS boundary',
      [pin.status, star.status].sort((a, b) => a - b).join(',') === '200,409',
      `statuses=${pin.status},${star.status}`,
    )
    const afterMetadata = await owner.req('GET', `/api/notes/${raceId}`)
    check('metadata mutation increments rev', afterMetadata.data?.rev === baseRev + 1)
    check('only the winning metadata mutation is applied',
      Number(Boolean(afterMetadata.data?.isPinned)) + Number(Boolean(afterMetadata.data?.isStarred)) === 1)
  }

  let repeatedAtomic = true
  let repeatedDetail = ''
  for (let index = 0; index < 6; index++) {
    const base = await owner.req('POST', '/api/notes', {
      content: `# \u91cd\u590d\u539f\u5b50\u57fa\u7ebf ${index}`,
    })
    const alpha = `# \u91cd\u590d Alpha ${index}\n\nrepeat-alpha-${index} #repeat-alpha-${index}`
    const beta = `# \u91cd\u590d Beta ${index}\n\nrepeat-beta-${index} #repeat-beta-${index}`
    const outcomes = await Promise.all([
      owner.req('PATCH', `/api/notes/${base.data?.id}`, { rev: base.data?.rev, content: alpha }),
      owner.req('PATCH', `/api/notes/${base.data?.id}`, { rev: base.data?.rev, content: beta }),
    ])
    const winner = outcomes.find((result) => result.status === 200)
    const loser = outcomes.find((result) => result.status === 409)
    const current = await owner.req('GET', `/api/notes/${base.data?.id}`)
    const winnerAlpha = winner?.data?.content === alpha
    const expectedContent = winnerAlpha ? alpha : beta
    const expectedTag = winnerAlpha ? `repeat-alpha-${index}` : `repeat-beta-${index}`
    const rejectedTerm = winnerAlpha ? `repeat-beta-${index}` : `repeat-alpha-${index}`
    const acceptedSearch = await owner.req('GET', `/api/search?q=${encodeURIComponent(expectedTag)}`)
    const rejectedSearch = await owner.req('GET', `/api/search?q=${encodeURIComponent(rejectedTerm)}`)
    const okay = Boolean(winner && loser) &&
      current.data?.content === expectedContent &&
      current.data?.tags?.includes(expectedTag) &&
      !current.data?.tags?.includes(rejectedTerm) &&
      (acceptedSearch.data?.results ?? []).some((hit) => hit.note?.id === base.data?.id) &&
      !(rejectedSearch.data?.results ?? []).some((hit) => hit.note?.id === base.data?.id)
    if (!okay) {
      repeatedAtomic = false
      repeatedDetail = `iteration=${index} statuses=${outcomes.map((item) => item.status).join(',')}`
      break
    }
  }
  check('repeated same-rev races keep body, tags and FTS under one winner', repeatedAtomic, repeatedDetail)
}

console.log('[sync retry durability]')
{
  const base = await owner.req('POST', '/api/notes', {
    title: 'Sync version base',
    content: '# Sync version base',
  })
  const remote = await owner.req('PATCH', `/api/notes/${base.data?.id}`, {
    rev: base.data?.rev,
    title: 'Remote version title',
    content: '# Remote version that must remain recoverable',
  })
  const rebased = await owner.req('PATCH', `/api/notes/${base.data?.id}`, {
    rev: remote.data?.rev,
    title: 'Latest queued local title',
    content: '# Latest queued local version',
    preserveVersion: true,
  })
  const versions = await owner.req('GET', `/api/notes/${base.data?.id}/versions`)
  const remoteVersionId = (versions.data?.versions ?? []).find(
    (version) => version.title === 'Remote version title',
  )?.id
  const remoteVersion = remoteVersionId
    ? await owner.req('GET', `/api/notes/${base.data?.id}/versions/${remoteVersionId}`)
    : null
  check(
    'conflict rebase preserves the replaced remote body in version history',
    base.status === 201 && remote.status === 200 && rebased.status === 200 &&
      remoteVersion?.status === 200 &&
      remoteVersion.data?.content === '# Remote version that must remain recoverable',
  )

  if (base.data?.id) {
    const last = base.data.id.at(-1)
    const requestedId = `${base.data.id.slice(0, -1)}${last === '0' ? '1' : '0'}`
    const content = '# Idempotent recovery note'
    const created = await owner.req('POST', '/api/notes', { id: requestedId, content })
    const retried = await owner.req('POST', '/api/notes', { id: requestedId, content })
    const loaded = await owner.req('GET', `/api/notes/${requestedId}`)
    check(
      'retrying recovery creation keeps one stable note id',
      created.status === 201 && retried.status === 200 &&
        created.data?.id === requestedId && retried.data?.id === requestedId && loaded.data?.content === content,
      `statuses=${created.status},${retried.status},${loaded.status}`,
    )
  }
}

console.log('[folder subtree integrity]')
{
  const left = await owner.req('POST', '/api/folders', { name: '\u5e76\u53d1\u76ee\u5f55\u7532' })
  const right = await owner.req('POST', '/api/folders', { name: '\u5e76\u53d1\u76ee\u5f55\u4e59' })
  check('create folders for cycle race', left.status === 201 && right.status === 201)
  if (left.data?.id && right.data?.id) {
    const [leftMove, rightMove] = await Promise.all([
      owner.req('PATCH', `/api/folders/${left.data.id}`, { parentId: right.data.id }),
      owner.req('PATCH', `/api/folders/${right.data.id}`, { parentId: left.data.id }),
    ])
    check(
      'concurrent cross-moves cannot create a folder cycle',
      [leftMove.status, rightMove.status].sort((a, b) => a - b).join(',') === '200,409',
      `statuses=${leftMove.status},${rightMove.status}`,
    )
    const folders = await owner.req('GET', '/api/folders')
    const leftAfter = folders.data?.folders?.find((item) => item.id === left.data.id)
    const rightAfter = folders.data?.folders?.find((item) => item.id === right.data.id)
    check('folder graph remains acyclic',
      !(leftAfter?.parentId === right.data.id && rightAfter?.parentId === left.data.id))
  }

  const folder = await owner.req('POST', '/api/folders', { name: '\u5f85\u5220\u9664\u6811' })
  const folderId = folder.data?.id
  const note = folderId
    ? await owner.req('POST', '/api/notes', { content: '# \u5df2\u5728\u56de\u6536\u7ad9', folderId })
    : null
  check('create folder and note', folder.status === 201 && note?.status === 201)

  if (folderId && note?.data?.id) {
    await owner.req('DELETE', `/api/notes/${note.data.id}`)
    const removed = await owner.req('DELETE', `/api/folders/${folderId}?strategy=delete`)
    check('delete folder subtree', removed.status === 200)

    const sync = await owner.req('GET', '/api/sync?since=0')
    const synced = sync.data?.notes?.find((item) => item.id === note.data.id)
    check(
      'trashed note no longer references deleted folder',
      Boolean(synced?.deletedAt) && synced?.folderId === null,
    )
    await owner.req('DELETE', `/api/notes/${note.data.id}/purge`)
  }

  const [sameA, sameB] = await Promise.all([
    owner.req('POST', '/api/folders', { name: '\u540c\u7ea7\u552f\u4e00\u76ee\u5f55' }),
    owner.req('POST', '/api/folders', { name: '\u540c\u7ea7\u552f\u4e00\u76ee\u5f55' }),
  ])
  const folderList = await owner.req('GET', '/api/folders')
  check(
    'concurrent sibling creation produces exactly one folder',
    [sameA.status, sameB.status].sort((a, b) => a - b).join(',') === '201,409' &&
      folderList.data?.folders?.filter((item) => item.name === '\u540c\u7ea7\u552f\u4e00\u76ee\u5f55').length === 1,
    `statuses=${sameA.status},${sameB.status}`,
  )

  const moveContainer = await owner.req('POST', '/api/folders', { name: '\u4e0a\u79fb\u51b2\u7a81\u5bb9\u5668' })
  const moveChild = await owner.req('POST', '/api/folders', {
    name: '\u4e0a\u79fb\u540c\u540d\u76ee\u5f55',
    parentId: moveContainer.data?.id,
  })
  const rootCollision = await owner.req('POST', '/api/folders', { name: '\u4e0a\u79fb\u540c\u540d\u76ee\u5f55' })
  const rejectedMove = await owner.req('DELETE', `/api/folders/${moveContainer.data?.id}`)
  const afterRejectedMove = await owner.req('GET', '/api/folders')
  check(
    'move-up folder deletion rejects name collisions without partial moves',
    moveContainer.status === 201 && moveChild.status === 201 && rootCollision.status === 201 &&
      rejectedMove.status === 409 &&
      afterRejectedMove.data?.folders?.some((item) => item.id === moveContainer.data?.id) &&
      afterRejectedMove.data?.folders?.find((item) => item.id === moveChild.data?.id)?.parentId === moveContainer.data?.id &&
      afterRejectedMove.data?.folders?.find((item) => item.id === rootCollision.data?.id)?.parentId === null,
    `delete=${rejectedMove.status}`,
  )
}

console.log('[tag rewrite concurrency]')
{
  const created = await owner.req('POST', '/api/notes', {
    content: '# \u6807\u7b7e\u5e76\u53d1\n\n\u539f\u59cb\u6b63\u6587 #rename-old',
  })
  const tags = await owner.req('GET', '/api/tags')
  const oldTag = tags.data?.tags?.find((tag) => tag.name === 'rename-old')
  check('create source tag', created.status === 201 && Boolean(oldTag?.id))
  if (created.data?.id && oldTag?.id) {
    const editedContent = '# \u6807\u7b7e\u5e76\u53d1\n\n\u7528\u6237\u540c\u65f6\u8f93\u5165\u7684\u5185\u5bb9\u5fc5\u987b\u4fdd\u7559\u3002 edit-survives #rename-old'
    const [rename, edit] = await Promise.all([
      owner.req('PATCH', `/api/tags/${oldTag.id}`, { name: 'rename-new' }),
      owner.req('PATCH', `/api/notes/${created.data.id}`, { rev: created.data.rev, content: editedContent }),
    ])
    check('tag rename completes under an editor race', rename.status === 200, `status=${rename.status}`)
    check('concurrent editor write is either committed or explicitly conflicted',
      edit.status === 200 || edit.status === 409, `status=${edit.status}`)
    const current = await owner.req('GET', `/api/notes/${created.data.id}`)
    if (edit.status === 200) {
      check('a successful concurrent editor write is never overwritten',
        current.data?.content?.includes('edit-survives'))
    }
    check('renamed tag is reflected in durable Markdown',
      current.data?.content?.includes('#rename-new') && !current.data?.content?.includes('#rename-old'))
    check('renamed tag relation matches durable Markdown',
      current.data?.tags?.includes('rename-new') && !current.data?.tags?.includes('rename-old'))
    const versions = await owner.req('GET', `/api/notes/${created.data.id}/versions`)
    const versionBodies = await Promise.all(
      (versions.data?.versions ?? []).map((version) =>
        owner.req('GET', `/api/notes/${created.data.id}/versions/${version.id}`),
      ),
    )
    const snapshotContents = versionBodies
      .filter((result) => result.status === 200)
      .map((result) => result.data?.content)
    check(
      'a losing tag rewrite cannot borrow the winner revision for a ghost snapshot',
      new Set(snapshotContents).size === snapshotContents.length,
    )
  }


  const colorNote = await owner.req('POST', '/api/notes', {
    content: '# \u6807\u7b7e\u989c\u8272\u5e76\u53d1\n\n#rename-color-old',
  })
  const colorTags = await owner.req('GET', '/api/tags')
  const colorSource = colorTags.data?.tags?.find((tag) => tag.name === 'rename-color-old')
  if (colorNote.status === 201 && colorSource?.id) {
    const [renamed, recolored] = await Promise.all([
      owner.req('PATCH', `/api/tags/${colorSource.id}`, { name: 'rename-color-new' }),
      owner.req('PATCH', `/api/tags/${colorSource.id}`, { color: '#abcdef' }),
    ])
    const finalTags = await owner.req('GET', '/api/tags')
    const finalTag = finalTags.data?.tags?.find((tag) => tag.name === 'rename-color-new')
    check(
      'tag rename preserves a concurrent color update that already succeeded',
      renamed.status === 200 && [200, 404, 409].includes(recolored.status) && Boolean(finalTag) &&
        (recolored.status !== 200 || finalTag?.color === '#abcdef'),
      `rename=${renamed.status} color=${recolored.status} final=${finalTag?.color}`,
    )
  }
  else {
    check('tag rename preserves a concurrent color update that already succeeded', false, 'fixture failed')
  }
}

console.log('[tag delete concurrency]')
{
  const created = await owner.req('POST', '/api/notes', {
    content: '# \u6807\u7b7e\u5220\u9664\u5e76\u53d1\n\n\u539f\u59cb\u6b63\u6587 #delete-race',
  })
  const tags = await owner.req('GET', '/api/tags')
  const sourceTag = tags.data?.tags?.find((tag) => tag.name === 'delete-race')
  check('create deletable tag', created.status === 201 && Boolean(sourceTag?.id))
  if (created.data?.id && sourceTag?.id) {
    const editedContent = '# \u6807\u7b7e\u5220\u9664\u5e76\u53d1\n\n\u5e76\u53d1\u8f93\u5165\u5fc5\u987b\u4fdd\u7559\u3002 delete-edit-survives #delete-race'
    const [removed, edit] = await Promise.all([
      owner.req('DELETE', `/api/tags/${sourceTag.id}`),
      owner.req('PATCH', `/api/notes/${created.data.id}`, { rev: created.data.rev, content: editedContent }),
    ])
    check('tag delete completes under an editor race', removed.status === 200, `status=${removed.status}`)
    check('concurrent editor during tag delete is committed or explicitly conflicted',
      edit.status === 200 || edit.status === 409, `status=${edit.status}`)
    const current = await owner.req('GET', `/api/notes/${created.data.id}`)
    if (edit.status === 200) {
      check('tag delete never overwrites a successful concurrent edit',
        current.data?.content?.includes('delete-edit-survives'))
    }
    check('deleted tag is absent from durable Markdown and relations',
      !current.data?.content?.includes('#delete-race') && !current.data?.tags?.includes('delete-race'))
  }
}

console.log('[import atomicity]')
{
  const created = await owner.req('POST', '/api/notes', {
    content: '# \u5bfc\u5165\u5e76\u53d1\u57fa\u7ebf\n\n\u539f\u59cb\u6b63\u6587 #import-old',
  })
  const importedContent = '# \u5bfc\u5165\u6210\u4e3a\u8d62\u5bb6\n\nimport-winner #import-new [[\u5bfc\u5165\u76ee\u6807]]'
  const editedContent = '# \u7f16\u8f91\u5668\u6210\u4e3a\u8d62\u5bb6\n\neditor-winner #editor-new [[\u7f16\u8f91\u76ee\u6807]]'
  const bundle = {
    format: 'inkstone-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: 'owner-1', name: '' },
    folders: [],
    tags: [],
    notes: [{
      ...created.data,
      content: importedContent,
      title: '\u5bfc\u5165\u6210\u4e3a\u8d62\u5bb6',
      updatedAt: (created.data?.updatedAt ?? Date.now()) + 1,
    }],
  }
  const [edited, imported] = await Promise.all([
    owner.req('PATCH', `/api/notes/${created.data?.id}`, {
      rev: created.data?.rev,
      content: editedContent,
    }),
    importJson(owner, bundle, 'race-import.json'),
  ])
  const durable = await owner.req('GET', `/api/notes/${created.data?.id}`)
  check(
    'a successful concurrent editor save is never overwritten by import',
    edited.status === 200
      ? durable.data?.content === editedContent && imported.data?.skippedNotes === 1
      : edited.status === 409 && imported.status === 200 && durable.data?.content === importedContent,
    `edit=${edited.status} import=${imported.status}`,
  )

  const beforeReplace = durable.data
  const replacement = '# \u539f\u5b50\u5bfc\u5165\u66ff\u6362\n\nimport-atomic-search #import-atomic [[Atomic Target]]'
  const replacementBundle = {
    ...bundle,
    tags: [{ name: 'import-atomic', color: '#123456' }],
    notes: [{
      ...beforeReplace,
      content: replacement,
      title: '\u539f\u5b50\u5bfc\u5165\u66ff\u6362',
      updatedAt: (beforeReplace?.updatedAt ?? Date.now()) + 1000,
    }],
  }
  const replaced = await importJson(owner, replacementBundle, 'replace-import.json')
  const afterReplace = await owner.req('GET', `/api/notes/${created.data?.id}`)
  const importedSearch = await owner.req('GET', `/api/search?q=${encodeURIComponent('import-atomic-search')}`)
  const importedTags = await owner.req('GET', '/api/tags')
  const versions = await owner.req('GET', `/api/notes/${created.data?.id}/versions`)
  const previousVersion = versions.data?.versions?.[0]?.id
    ? await owner.req('GET', `/api/notes/${created.data?.id}/versions/${versions.data.versions[0].id}`)
    : null
  check(
    'import commits body, tags, links, FTS and change revision together',
    replaced.status === 200 && replaced.data?.updatedNotes === 1 &&
      afterReplace.data?.content === replacement &&
      afterReplace.data?.tags?.includes('import-atomic') &&
      importedTags.data?.tags?.find((tag) => tag.name === 'import-atomic')?.color === '#123456' &&
      (importedSearch.data?.results ?? []).some((hit) => hit.note?.id === created.data?.id),
  )
  check(
    'import snapshots the previous body before replacement',
    previousVersion?.status === 200 && previousVersion.data?.content === beforeReplace?.content,
  )

  const importFolderId = '0000000000aaaaaaaaaaaaaaaa'
  const importAlphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  const lockedBundle = {
    format: 'inkstone-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: 'owner-1', name: '' },
    folders: [{
      id: importFolderId,
      parentId: null,
      name: '\u5e76\u53d1\u5bfc\u5165\u552f\u4e00\u76ee\u5f55',
      icon: '📦',
      position: 42,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 5_000,
    }],
    tags: [],
    notes: Array.from({ length: 24 }, (_, index) => ({
      id: `0000000000${'b'.repeat(15)}${importAlphabet[index]}`,
      folderId: importFolderId,
      title: `\u5e76\u53d1\u5bfc\u5165\u9501 ${index + 1}`,
      content: `# \u5e76\u53d1\u5bfc\u5165\u9501 ${index + 1}\n\n#import-lock-${index + 1}`,
      updatedAt: Date.now(),
      createdAt: Date.now() - 1000,
      position: index + 1,
    })),
  }
  const [lockedA, lockedB] = await Promise.all([
    importJson(owner, lockedBundle, 'locked-a.json'),
    importJson(owner, lockedBundle, 'locked-b.json'),
  ])
  const importedFolders = await owner.req('GET', '/api/folders')
  const importStatuses = [lockedA.status, lockedB.status]
  const bothCompleted = importStatuses.every((status) => status === 200)
  check(
    'overlapping imports conflict or safely serialize after lock release',
    importStatuses.every((status) => status === 200 || status === 409) &&
      importStatuses.includes(200) &&
      (!bothCompleted ||
        ((lockedA.data?.createdNotes ?? 0) + (lockedB.data?.createdNotes ?? 0) === 24 &&
          (lockedA.data?.skippedNotes ?? 0) + (lockedB.data?.skippedNotes ?? 0) >= 24)),
    `statuses=${importStatuses.join(',')} created=${(lockedA.data?.createdNotes ?? 0) + (lockedB.data?.createdNotes ?? 0)} skipped=${(lockedA.data?.skippedNotes ?? 0) + (lockedB.data?.skippedNotes ?? 0)}`,
  )
  check(
    'bundle folder hierarchy and metadata are created once',
    importedFolders.data?.folders?.filter((item) => item.name === '\u5e76\u53d1\u5bfc\u5165\u552f\u4e00\u76ee\u5f55').length === 1 &&
      importedFolders.data?.folders?.find((item) => item.name === '\u5e76\u53d1\u5bfc\u5165\u552f\u4e00\u76ee\u5f55')?.icon === '📦',
  )
}

console.log('[protected share attachment]')
if (noteId) {
  // The route counts the body while it streams, under a ceiling of 25 MiB plus a 512 KiB form
  // envelope, and a chunked request carries no declared length to check first — so the fixture has
  // to clear that ceiling to be testing the counter at all. Eleven MiB only ever proved it against
  // the 10 MiB single-file limit this app had before the ceiling moved to 25 MiB.
  const chunkedOversize = byteStream(27 * 1024 * 1024)
  const streamedOversize = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=inkstone-e2e',
      'X-Inkstone-Client': '1',
      Cookie: owner.jar.cookie,
    },
    body: chunkedOversize,
    duplex: 'half',
  })
  const streamedError = await streamedOversize.json().catch(() => null)
  check(
    'chunked multipart cannot bypass the actual upload limit',
    streamedOversize.status === 413 && streamedError?.error?.code === 'payload_too_large',
    `status=${streamedOversize.status}`,
  )

  const spoofedForm = new FormData()
  spoofedForm.set('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'fake.png')
  spoofedForm.set('noteId', noteId)
  const spoofedUpload = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
    body: spoofedForm,
  })
  const spoofedAttachment = await spoofedUpload.json().catch(() => null)
  const spoofedDownload = spoofedAttachment?.id
    ? await fetch(BASE + `/api/files/${spoofedAttachment.id}`, {
        headers: { Cookie: owner.jar.cookie },
      })
    : null
  check(
    'spoofed image is forced to a non-inline download',
    spoofedUpload.status === 201 &&
      spoofedAttachment?.mime === 'application/octet-stream' &&
      spoofedDownload?.headers.get('content-disposition')?.startsWith('attachment;') === true,
  )
  // The reader's own copy may be held for a year because only that reader can delete the bytes; a
  // share grant is revocable, so its reads are asserted no-store further below.
  check('owner attachment reads are cached privately, never by a shared cache',
    spoofedDownload?.headers.get('cache-control') === 'private, max-age=31536000, immutable')
  if (spoofedAttachment?.id) await owner.req('DELETE', `/api/files/${spoofedAttachment.id}`)

  const form = new FormData()
  form.set('file', new Blob(['inkstone protected attachment'], { type: 'text/plain' }), 'e2e.txt')
  form.set('noteId', noteId)
  const uploadRes = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: {
      'X-Inkstone-Client': '1',
      Cookie: owner.jar.cookie,
    },
    body: form,
  })
  const attachment = await uploadRes.json().catch(() => null)
  const shareFixtureNote = await owner.req('GET', `/api/notes/${noteId}`)
  const linkedShareAttachment = attachment?.id
    ? await owner.req('PATCH', `/api/notes/${noteId}`, {
        rev: shareFixtureNote.data?.rev,
        content: `${shareFixtureNote.data?.content ?? ''}\n\n[\u53d7\u4fdd\u62a4\u9644\u4ef6](/api/files/${attachment.id})`,
      })
    : null
  check(
    'upload attachment and persist its note reference',
    uploadRes.status === 201 && Boolean(attachment?.id) && linkedShareAttachment?.status === 200,
  )

  const created = await owner.req('POST', `/api/share/${noteId}`, {
    password: 'e2e-share-secret',
  })
  const slug = created.data?.share?.slug
  check('create password-protected share', created.status === 200 && /^[0-9a-hjkmnp-tv-z]{20}$/.test(slug ?? ''))

  const [shareUpdateA, shareUpdateB] = await Promise.all([
    owner.req('POST', `/api/share/${noteId}`, { expiresIn: 60_000 }),
    owner.req('POST', `/api/share/${noteId}`, { expiresIn: 120_000 }),
  ])
  check('concurrent share updates keep one stable URL',
    shareUpdateA.status === 200 && shareUpdateB.status === 200 &&
      shareUpdateA.data?.share?.slug === slug && shareUpdateB.data?.share?.slug === slug)
  check('share updates that omit password preserve protection',
    shareUpdateA.data?.share?.hasPassword === true && shareUpdateB.data?.share?.hasPassword === true)

  if (attachment?.id && slug) {
    const oversizedPassword = await owner.req('POST', `/api/public/${slug}`, {
      password: 'x'.repeat(9000),
    })
    check('public share preserves oversized-body 413',
      oversizedPassword.status === 413 && oversizedPassword.data?.error?.code === 'payload_too_large')

    const assetPath = `/api/files/${attachment.id}?share=${encodeURIComponent(slug)}`
    const withoutCookie = await fetch(BASE + assetPath)
    check('protected attachment rejects a missing share cookie', withoutCookie.status === 401)

    const publicNote = await fetch(BASE + `/api/public/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inkstone-Client': '1',
      },
      body: JSON.stringify({ password: 'e2e-share-secret' }),
    })
    const publicData = await publicNote.json().catch(() => null)
    const shareCookieName = `inkstone_share_${slug}`
    const shareCookieHeader = getSetCookie(publicNote).find((value) => value.startsWith(`${shareCookieName}=`)) ?? ''
    const shareCookie = shareCookieHeader.split(';', 1)[0]
    check(
      'share password yields a path-limited HttpOnly asset cookie',
      publicNote.status === 200 &&
        Boolean(shareCookie) &&
        /;\s*HttpOnly/i.test(shareCookieHeader) &&
        /;\s*SameSite=Strict/i.test(shareCookieHeader) &&
        /;\s*Path=\/api\/files/i.test(shareCookieHeader),
      `status=${publicNote.status} data=${JSON.stringify(publicData)}`,
    )

    const withCookie = await fetch(BASE + assetPath, { headers: { Cookie: shareCookie } })
    check(
      'valid share cookie reads the attachment',
      withCookie.status === 200 &&
        withCookie.headers.get('cache-control') === 'private, no-store' &&
        (await withCookie.text()) === 'inkstone protected attachment',
      `status=${withCookie.status}`,
    )

    const rotated = await owner.req('POST', `/api/share/${noteId}`, {
      password: 'e2e-share-secret-rotated',
    })
    check('share password rotation succeeds', rotated.status === 200)
    const oldCookieAfterRotation = await fetch(BASE + assetPath, { headers: { Cookie: shareCookie } })
    check('changing share password revokes old attachment sessions immediately',
      oldCookieAfterRotation.status === 401)
    const oldPassword = await owner.req('POST', `/api/public/${slug}`, {
      password: 'e2e-share-secret',
    })
    check('old share password is rejected after rotation', oldPassword.status === 401)
    const newPassword = await fetch(BASE + `/api/public/${slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inkstone-Client': '1',
      },
      body: JSON.stringify({ password: 'e2e-share-secret-rotated' }),
    })
    const newShareCookieHeader = getSetCookie(newPassword).find(
      (value) => value.startsWith(`${shareCookieName}=`),
    ) ?? ''
    const newShareCookie = newShareCookieHeader.split(';', 1)[0]
    const newCookieAsset = await fetch(BASE + assetPath, { headers: { Cookie: newShareCookie } })
    check('new share password and cookie can read the attachment',
      newPassword.status === 200 && Boolean(newShareCookie) && newCookieAsset.status === 200)

    const wrongCookie = await fetch(BASE + assetPath, {
      headers: { Cookie: `${shareCookieName}=invalid` },
    })
    check('invalid share cookie is rejected', wrongCookie.status === 401)
  }

  if (linkedShareAttachment?.status === 200) {
    const unlinkedShareAttachment = await owner.req('PATCH', `/api/notes/${noteId}`, {
      rev: linkedShareAttachment.data?.rev,
      content: shareFixtureNote.data?.content ?? '',
    })
    check('protected-share fixture restores the original note body', unlinkedShareAttachment.status === 200)
  }

  if (attachment?.id) {
    const removed = await owner.req('DELETE', `/api/files/${attachment.id}`)
    check('owner deletes attachment', removed.status === 200)
  }
  await owner.req('DELETE', `/api/share/${noteId}`)
}

console.log('[attachment prune consistency]')
if (noteId) {
  const form = new FormData()
  form.set('file', new Blob(['referenced attachment'], { type: 'text/plain' }), 'referenced.txt')
  form.set('noteId', noteId)
  const uploaded = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
    body: form,
  })
  const attachment = await uploaded.json().catch(() => null)
  const current = await owner.req('GET', `/api/notes/${noteId}`)
  const linked = attachment?.id
    ? await owner.req('PATCH', `/api/notes/${noteId}`, {
        rev: current.data?.rev,
        content: `${current.data?.content ?? ''}\n\n[\u4fdd\u7559\u9644\u4ef6](/api/files/${attachment.id})`,
      })
    : null
  const kept = await owner.req('POST', '/api/files/prune')
  const stillReadable = attachment?.id
    ? await fetch(BASE + `/api/files/${attachment.id}`, { headers: { Cookie: owner.jar.cookie } })
    : null
  check(
    'prune keeps an attachment referenced by durable note content',
    uploaded.status === 201 && linked?.status === 200 && kept.data?.removed === 0 && stillReadable?.status === 200,
  )

  if (attachment?.id && linked?.status === 200) {
    const unlinked = await owner.req('PATCH', `/api/notes/${noteId}`, {
      rev: linked.data?.rev,
      content: current.data?.content ?? '',
    })
    const pruned = await owner.req('POST', '/api/files/prune')
    const gone = await fetch(BASE + `/api/files/${attachment.id}`, {
      headers: { Cookie: owner.jar.cookie },
    })
    check(
      'prune removes metadata only after the reference is gone',
      unlinked.status === 200 && pruned.data?.removed === 1 && gone.status === 404,
      `unlink=${unlinked.status} removed=${pruned.data?.removed} get=${gone.status}`,
    )
  }
}

console.log('[revocable session]')
{
  const before = await owner.req('GET', '/api/auth/session')
  check('session valid before logout', Boolean(before.data?.user))
  const savedCookie = owner.jar.cookie
  await owner.req('POST', '/api/auth/logout')
  owner.jar.cookie = savedCookie
  const after = await owner.req('GET', '/api/auth/session')
  check('old token revoked server-side', after.data?.user === null, JSON.stringify(after.data?.user))
  owner.jar.cookie = ''
}

console.log('[login]')
{
  const login = await owner.req('POST', '/api/auth/login', { username: 'OWNER-1', password: 'supersecret99' })
  check('login case-insensitive username', login.status === 200 && login.data?.user?.username === 'owner-1')
}

console.log('[registration toggle]')
{
  const status0 = await owner.req('GET', '/api/auth/session')
  check('default closed', status0.data?.site?.registrationOpen === false)

  const wrongPw = await owner.req('PUT', '/api/settings/registration', { enabled: true, password: 'wrong-password' })
  check('toggle with wrong password -> 401', wrongPw.status === 401 && wrongPw.data?.error?.code === 'wrong_password')

  const open = await owner.req('PUT', '/api/settings/registration', { enabled: true, password: 'supersecret99' })
  check('owner opens registration', open.status === 200 && open.data?.registrationOpen === true)

  const member = makeClient()
  const reg2 = await member.req('POST', '/api/auth/register', { username: 'second-user', password: 'supersecret99', locale: 'en-US' })
  check('second user registers while open (member)', reg2.status === 201 && reg2.data?.user?.role === 'member')
  const memberNotes = await member.req('GET', '/api/notes?view=all')
  const memberList = memberNotes.data?.notes ?? memberNotes.data?.items ?? []
  const memberEnglishWelcome = memberList.find((note) => /^Welcome to Inkstone/u.test(note.title ?? ''))
  const memberChineseWelcome = memberList.find(
    (note) => note.id !== memberEnglishWelcome?.id && /Inkstone/u.test(note.title ?? ''),
  )
  check(
    'English registration gets both welcome notes',
    memberList.length === 2 && Boolean(memberChineseWelcome && memberEnglishWelcome),
    JSON.stringify(memberList.slice(0, 2).map((note) => note.title)),
  )
  if (memberEnglishWelcome?.id) {
    const englishWelcomeNote = await member.req('GET', `/api/notes/${memberEnglishWelcome.id}`)
    const content = englishWelcomeNote.data?.content ?? ''
    check('English welcome note uses formal YAML Front Matter', /^---\r?\ntitle:/u.test(content))
    check('English welcome note contains no Han text', !/\p{Script=Han}/u.test(content))
    check('English welcome note documents Windows shortcuts only', /Ctrl \+ K/u.test(content) && !/[⌘]|\b(?:Command|Cmd|macOS)\b/u.test(content))
  }

  console.log('[attachment backup round-trip]')
  const roundTripNote = await owner.req('POST', '/api/notes', {
    title: 'Attachment backup round-trip',
    content: '# Attachment backup round-trip\n\nbackup-attachment-round-trip',
  })
  const roundTripForm = new FormData()
  roundTripForm.set(
    'file',
    new Blob(['attachment survives export and cross-account restore'], { type: 'text/plain' }),
    'round-trip.txt',
  )
  roundTripForm.set('noteId', roundTripNote.data?.id)
  const roundTripUpload = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
    body: roundTripForm,
  })
  const sourceAttachment = await roundTripUpload.json().catch(() => null)
  const linkedRoundTrip = sourceAttachment?.id
    ? await owner.req('PATCH', `/api/notes/${roundTripNote.data?.id}`, {
        rev: roundTripNote.data?.rev,
        content: `# Attachment backup round-trip\n\nbackup-attachment-round-trip\n\n[round trip](/api/files/${sourceAttachment.id})`,
      })
    : null
  check(
    'round-trip fixture links a real attachment',
    roundTripUpload.status === 201 && linkedRoundTrip?.status === 200,
  )

  const reusedAttachmentNote = sourceAttachment?.id
    ? await owner.req('POST', '/api/notes', {
        content: `# Reused attachment share\n\n[shared copy](/api/files/${sourceAttachment.id})`,
      })
    : null
  const reusedShare = reusedAttachmentNote?.data?.id
    ? await owner.req('POST', `/api/share/${reusedAttachmentNote.data.id}`, {})
    : null
  const reusedSlug = reusedShare?.data?.share?.slug
  const reusedPublicAsset = sourceAttachment?.id && reusedSlug
    ? await fetch(
        BASE + `/api/files/${sourceAttachment.id}?share=${encodeURIComponent(reusedSlug)}`,
      )
    : null
  check(
    'a shared note can serve an attachment originally uploaded for another note',
    reusedShare?.status === 200 && reusedPublicAsset?.status === 200,
  )

  const trashFixture = await owner.req('POST', '/api/notes', {
    title: 'Backup trash round-trip',
    content: '# Backup trash round-trip\n\ntrashed-note-must-survive-backup #trash-round-trip',
  })
  const trashAttachmentForm = new FormData()
  trashAttachmentForm.set(
    'file',
    new Blob(['trash attachment must survive prune'], { type: 'text/plain' }),
    'trash-round-trip.txt',
  )
  trashAttachmentForm.set('noteId', trashFixture.data?.id)
  const trashAttachmentUpload = await fetch(BASE + '/api/files', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
    body: trashAttachmentForm,
  })
  const trashAttachment = await trashAttachmentUpload.json().catch(() => null)
  const linkedTrashFixture = trashAttachment?.id
    ? await owner.req('PATCH', `/api/notes/${trashFixture.data?.id}`, {
        rev: trashFixture.data?.rev,
        content: `${trashFixture.data?.content ?? ''}\n\n[trash file](/api/files/${trashAttachment.id})`,
      })
    : null
  const trashedFixture = linkedTrashFixture?.data?.id
    ? await owner.req('DELETE', `/api/notes/${linkedTrashFixture.data.id}`)
    : null
  check(
    'round-trip fixture moves a note with an attachment to trash',
    trashAttachmentUpload.status === 201 &&
      linkedTrashFixture?.status === 200 &&
      trashedFixture?.status === 200,
  )
  const prunedWithTrash = await owner.req('POST', '/api/files/prune')
  const trashAttachmentAfterPrune = trashAttachment?.id
    ? await fetch(BASE + `/api/files/${trashAttachment.id}`, {
        headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
      })
    : null
  check(
    'prune keeps attachments referenced only by notes in trash',
    prunedWithTrash.status === 200 && trashAttachmentAfterPrune?.status === 200,
  )

  const jsonExport = await fetch(BASE + '/api/export?format=json', {
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
  })
  const jsonBundle = await jsonExport.json().catch(() => null)
  check(
    'JSON export explicitly excludes attachment binaries',
    jsonExport.status === 200 && Array.isArray(jsonBundle?.attachments) && jsonBundle.attachments.length === 0,
  )

  const zipExport = await fetch(BASE + '/api/export?format=zip', {
    headers: { 'X-Inkstone-Client': '1', Cookie: owner.jar.cookie },
  })
  const zipBytes = await zipExport.arrayBuffer()
  check(
    'ZIP export returns a private downloadable archive',
    zipExport.status === 200 &&
      zipExport.headers.get('content-type') === 'application/zip' &&
      zipExport.headers.get('cache-control')?.includes('no-store') &&
      zipBytes.byteLength > 0,
  )

  const restoreForm = new FormData()
  restoreForm.set('file', new Blob([zipBytes], { type: 'application/zip' }), 'round-trip.zip')
  restoreForm.set('conflict', 'newer')
  const restoredResponse = await fetch(BASE + '/api/import', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: member.jar.cookie },
    body: restoreForm,
  })
  const restoredResult = await restoredResponse.json().catch(() => null)
  const restoredSearch = await member.req(
    'GET',
    `/api/search?q=${encodeURIComponent('backup-attachment-round-trip')}`,
  )
  const restoredNoteId = restoredSearch.data?.results?.find((hit) =>
    hit.note?.title === 'Attachment backup round-trip')?.note?.id
  const restoredNote = restoredNoteId
    ? await member.req('GET', `/api/notes/${restoredNoteId}`)
    : null
  const restoredAttachmentId = /\/api\/files\/([0-9a-hjkmnp-tv-z]{26})/u.exec(
    restoredNote?.data?.content ?? '',
  )?.[1]
  const restoredAttachment = restoredAttachmentId
    ? await fetch(BASE + `/api/files/${restoredAttachmentId}`, {
        headers: { 'X-Inkstone-Client': '1', Cookie: member.jar.cookie },
      })
    : null
  const restoredAttachmentText = restoredAttachment
    ? await restoredAttachment.text().catch(() => '')
    : ''
  check(
    'ZIP import restores attachment bytes and rewrites cross-account ids',
    restoredResponse.status === 200 &&
      restoredResult?.createdAttachments >= 1 &&
      restoredNote?.status === 200 &&
      restoredAttachmentId &&
      restoredAttachmentId !== sourceAttachment?.id &&
      restoredAttachment?.status === 200 &&
      restoredAttachmentText === 'attachment survives export and cross-account restore',
    `status=${restoredResponse.status} result=${JSON.stringify(restoredResult)}`,
  )

  const restoredTrash = await member.req('GET', '/api/notes?view=trash&limit=100')
  const restoredTrashNotes = restoredTrash.data?.notes ?? restoredTrash.data?.items ?? []
  check(
    'ZIP import preserves trashed notes without resurrecting them',
    restoredTrash.status === 200 &&
      restoredTrashNotes.some((note) =>
        note.title === 'Backup trash round-trip' && Number.isFinite(note.deletedAt)),
  )

  const repeatedRestoreForm = new FormData()
  repeatedRestoreForm.set(
    'file',
    new Blob([zipBytes], { type: 'application/zip' }),
    'round-trip-again.zip',
  )
  repeatedRestoreForm.set('conflict', 'newer')
  const repeatedRestoreResponse = await fetch(BASE + '/api/import', {
    method: 'POST',
    headers: { 'X-Inkstone-Client': '1', Cookie: member.jar.cookie },
    body: repeatedRestoreForm,
  })
  const repeatedRestore = await repeatedRestoreResponse.json().catch(() => null)
  check(
    're-importing a cross-account backup is idempotent',
    repeatedRestoreResponse.status === 200 &&
      repeatedRestore?.createdNotes === 0 &&
      repeatedRestore?.updatedNotes === 0 &&
      repeatedRestore?.skippedNotes > 0 &&
      repeatedRestore?.createdAttachments === 0 &&
      repeatedRestore?.skippedAttachments >= 2,
    `status=${repeatedRestoreResponse.status} result=${JSON.stringify(repeatedRestore)}`,
  )

  const privateFolder = await owner.req('POST', '/api/folders', { name: 'Owner private folder' })
  const privateNote = await owner.req('POST', '/api/notes', {
    content: '# Owner private note\n\nmember must never read this #owner-private',
    folderId: privateFolder.data?.id,
  })
  const ownerTags = await owner.req('GET', '/api/tags')
  const privateTag = ownerTags.data?.tags?.find((tag) => tag.name === 'owner-private')
  const memberRead = await member.req('GET', `/api/notes/${privateNote.data?.id}`)
  check('member cannot read another user note', memberRead.status === 404)
  const memberWrite = await member.req('PATCH', `/api/notes/${privateNote.data?.id}`, {
    rev: privateNote.data?.rev,
    content: '# stolen',
  })
  check('member cannot modify another user note', memberWrite.status === 404)
  const memberFolderWrite = await member.req('PATCH', `/api/folders/${privateFolder.data?.id}`, { name: 'stolen' })
  check('member cannot modify another user folder', memberFolderWrite.status === 404)
  if (privateTag?.id) {
    const memberTagWrite = await member.req('PATCH', `/api/tags/${privateTag.id}`, { color: '#fff' })
    check('member cannot modify another user tag', memberTagWrite.status === 404)
  }
  const memberShare = await member.req('POST', `/api/share/${privateNote.data?.id}`, {})
  check('member cannot publish another user note', memberShare.status === 404)
  const memberShareLookup = await member.req('GET', `/api/share/${privateNote.data?.id}`)
  check('share lookup does not reveal another user share', memberShareLookup.status === 200 && memberShareLookup.data?.share === null)

  const backupTarget = await owner.req('POST', '/api/backup/targets', {
    type: 's3',
    name: 'Owner private backup',
    enabled: false,
    config: {
      endpoint: 'https://s3.amazonaws.com',
      region: 'auto',
      bucket: 'owner-backup',
      prefix: '',
      pathStyle: true,
      mode: 'archive',
    },
    secret: { accessKeyId: 'owner-key', secretAccessKey: 'owner-secret' },
  })
  check('owner can create an encrypted backup target', backupTarget.status === 201 && Boolean(backupTarget.data?.id))
  check(
    'backup target responses never expose plaintext or ciphertext',
    backupTarget.data?.hasSecret === true &&
      !Object.hasOwn(backupTarget.data ?? {}, 'secret') &&
      !JSON.stringify(backupTarget.data ?? {}).includes('owner-secret'),
  )
  const invalidTypeSwitch = backupTarget.data?.id
    ? await owner.req('PATCH', `/api/backup/targets/${backupTarget.data.id}`, {
        type: 'webdav',
        name: 'Must supply new credentials',
        config: {
          url: 'https://dav.example.com/backups',
          username: 'owner',
          prefix: '',
          mode: 'archive',
        },
      })
    : null
  check(
    'switching backup type requires credentials for the new adapter',
    invalidTypeSwitch?.status === 400,
  )
  const memberDeleteTarget = await member.req('DELETE', `/api/backup/targets/${backupTarget.data?.id}`)
  check('member cannot delete another user backup target', memberDeleteTarget.status === 404)
  const memberTargets = await member.req('GET', '/api/backup/targets')
  check('member backup listing is isolated', memberTargets.status === 200 && memberTargets.data?.targets?.length === 0)

  if (backupTarget.data?.id) await owner.req('DELETE', `/api/backup/targets/${backupTarget.data.id}`)
  if (privateNote.data?.id) {
    await owner.req('DELETE', `/api/notes/${privateNote.data.id}`)
    await owner.req('DELETE', `/api/notes/${privateNote.data.id}/purge`)
  }
  if (privateFolder.data?.id) await owner.req('DELETE', `/api/folders/${privateFolder.data.id}`)

  const memberTry = await member.req('PUT', '/api/settings/registration', { enabled: false, password: 'supersecret99' })
  check('member cannot toggle -> 403', memberTry.status === 403)

  const close = await owner.req('PUT', '/api/settings/registration', { enabled: false, password: 'supersecret99' })
  check('owner closes registration', close.status === 200 && close.data?.registrationOpen === false)

  const third = makeClient()
  const reg3 = await third.req('POST', '/api/auth/register', { username: 'third-user', password: 'supersecret99' })
  check('closed again -> 403', reg3.status === 403 && reg3.data?.error?.code === 'registration_closed')
}

console.log('[concurrent settings merge]')
{
  const syncBefore = await owner.req('GET', '/api/sync?since=0')
  const [appearance, editor] = await Promise.all([
    owner.req('PUT', '/api/settings', { appearance: { theme: 'dark' } }),
    owner.req('PUT', '/api/settings', { editor: { lineNumbers: true } }),
  ])
  check('concurrent settings patches both complete', appearance.status === 200 && editor.status === 200)
  const settings = await owner.req('GET', '/api/settings')
  check('concurrent settings patches preserve both sections',
    settings.data?.appearance?.theme === 'dark' && settings.data?.editor?.lineNumbers === true)
  const settingsDelta = await owner.req('GET', `/api/sync?since=${syncBefore.data?.cursor ?? 0}`)
  check('settings changes are visible to other devices through sync',
    settingsDelta.status === 200 && settingsDelta.data?.settingsChanged === true)
}

console.log('[change password kicks other devices]')
{
  const deviceB = makeClient()
  const loginB = await deviceB.req('POST', '/api/auth/login', { username: 'owner-1', password: 'supersecret99' })
  check('second device login', loginB.status === 200 && deviceB.jar.cookie !== owner.jar.cookie)

  const wrongCurrent = await deviceB.req('POST', '/api/auth/password', {
    currentPassword: 'nope-nope',
    newPassword: 'supersecret100',
  })
  check('change with wrong current -> 401', wrongCurrent.status === 401 && wrongCurrent.data?.error?.code === 'wrong_password')

  const preChangeCookie = deviceB.jar.cookie
  const change = await deviceB.req('POST', '/api/auth/password', {
    currentPassword: 'supersecret99',
    newPassword: 'supersecret100',
  })
  check('change password', change.status === 200)
  check('password change rotates the current session token',
    Boolean(deviceB.jar.cookie) && deviceB.jar.cookie !== preChangeCookie)
  const copiedOldSession = makeClient()
  copiedOldSession.jar.cookie = preChangeCookie
  const copiedOldSessionInfo = await copiedOldSession.req('GET', '/api/auth/session')
  check('a copied pre-change session token is revoked', copiedOldSessionInfo.data?.user === null)

  const sessionA = await owner.req('GET', '/api/auth/session')
  check('device A revoked after change', sessionA.data?.user === null)
  const sessionB = await deviceB.req('GET', '/api/auth/session')
  check('device B survives', Boolean(sessionB.data?.user))

  const oldPw = await owner.req('POST', '/api/auth/login', { username: 'owner-1', password: 'supersecret99' })
  check('old password rejected', oldPw.status === 401)
  const newPw = await owner.req('POST', '/api/auth/login', { username: 'owner-1', password: 'supersecret100' })
  check('new password works', newPw.status === 200)
  await deviceB.req('POST', '/api/auth/logout')
}

console.log('[realtime origin boundary]')
{
  const crossOrigin = await owner.req('GET', '/api/sync/ws', undefined, {
    Origin: 'https://attacker.example',
  })
  check('cross-origin WebSocket handshakes are rejected', crossOrigin.status === 403)
}

console.log('[throttle]')
{
  const attacker = makeClient()
  for (let i = 1; i <= 5; i++) {
    const bad = await attacker.req('POST', '/api/auth/login', { username: 'owner-1', password: 'wrong-password' })
    check(`wrong password #${i} -> 401`, bad.status === 401 && bad.data?.error?.code === 'invalid_credentials', `status=${bad.status}`)
  }
  const locked = await attacker.req('POST', '/api/auth/login', { username: 'owner-1', password: 'supersecret100' })
  check('locked out even with correct password -> 429', locked.status === 429 && locked.data?.error?.code === 'too_many_attempts')
  const otherIp = await attacker.req(
    'POST',
    '/api/auth/login',
    { username: 'owner-1', password: 'supersecret100' },
    { 'CF-Connecting-IP': '203.0.113.9' },
  )
  check(
    'a different IP is not able to lock out the account globally',
    otherIp.status === 200 && otherIp.data?.user?.username === 'owner-1',
    `status=${otherIp.status}`,
  )
}

console.log('[pre-computation throttle]')
{
  const parallel = makeClient()
  const attempts = await Promise.all(Array.from({ length: 10 }, () =>
    parallel.req(
      'POST',
      '/api/auth/login',
      { username: 'owner-1', password: 'parallel-wrong-password' },
      { 'CF-Connecting-IP': '198.51.100.44' },
    )))
  const expensive = attempts.filter((result) => result.status === 401).length
  const rejected = attempts.filter((result) => result.status === 429).length
  check('parallel login work is capped before password verification',
    expensive <= 8 && rejected >= 2,
    `statuses=${attempts.map((result) => result.status).join(',')}`)
  check('pre-computation throttle returns only explicit auth outcomes',
    attempts.every((result) => result.status === 401 || result.status === 429))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
