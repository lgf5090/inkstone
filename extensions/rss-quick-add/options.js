const input = document.querySelector('#base-url')
const saveButton = document.querySelector('#save')
const status = document.querySelector('#status')

async function load() {
  const stored = await chrome.storage.sync.get('baseUrl')
  input.value = String(stored.baseUrl ?? '')
}

saveButton.addEventListener('click', async () => {
  const value = input.value.trim().replace(/\/$/, '')
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
  }
  catch {
    status.textContent = 'Enter a valid HTTP or HTTPS address.'
    return
  }
  await chrome.storage.sync.set({ baseUrl: value })
  status.textContent = 'Saved.'
})

void load().catch(() => { status.textContent = 'Settings could not be loaded.' })
