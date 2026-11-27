const addButton = document.querySelector('#add')
const optionsButton = document.querySelector('#options')
const pageUrl = document.querySelector('#page-url')
const status = document.querySelector('#status')
let baseUrl = ''
let currentUrl = ''

function showError(message) {
  status.textContent = message
  addButton.disabled = true
}

async function load() {
  const stored = await chrome.storage.sync.get('baseUrl')
  baseUrl = String(stored.baseUrl ?? '').trim().replace(/\/$/, '')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentUrl = tab?.url ?? ''
  pageUrl.textContent = currentUrl || 'No active web page.'
  if (!baseUrl) {
    showError('Set your Inkstone address in Settings first.')
    return
  }
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
  }
  catch {
    showError('The saved Inkstone address is not valid.')
    return
  }
  if (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://')) {
    showError('This page cannot be added as a web subscription.')
    return
  }
  status.textContent = 'Inkstone will discover the page’s feed address.'
  addButton.disabled = false
}

addButton.addEventListener('click', () => {
  const target = new URL('/rss', baseUrl)
  target.searchParams.set('add', currentUrl)
  void chrome.tabs.create({ url: target.href })
})

optionsButton.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

void load().catch(() => showError('The current page could not be read.'))
