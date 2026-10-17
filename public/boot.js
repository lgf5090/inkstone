;(function () {
  try {
    var raw = localStorage.getItem('inkstone.ui')
    var saved = raw ? JSON.parse(raw) : null
    var pref = (saved && saved.theme) || 'system'
    var accent = (saved && saved.accent) || 'cinnabar'
    var background = saved && saved.background === 'white' ? 'white' : 'paper'
    var dark =
      pref === 'dark' ||
      (pref === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    var root = document.documentElement
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.accent = accent
    root.dataset.background = background
    var storedLocale = localStorage.getItem('inkstone-locale')
    var locale =
      storedLocale === 'zh-CN' || storedLocale === 'en-US'
        ? storedLocale
        : saved && (saved.language === 'zh-CN' || saved.language === 'en-US')
          ? saved.language
          : navigator.language.toLowerCase().startsWith('zh')
            ? 'zh-CN'
            : 'en-US'
    root.lang = locale
    document.title = 'Inkstone'
    var description = document.querySelector('meta[name="description"]')
    if (description) {
      description.content = 'A private, self-hosted Markdown notebook built on Cloudflare.'
    }
    if (saved && saved.fontScale) {
      root.style.setProperty('--prose-size', saved.fontScale + 'px')
    }
    window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/'
  } catch (e) {

  }
})()

;(function () {
  // A deploy replaces every content-hashed chunk, so a document that came out of a cache one build
  // behind names files the server no longer has. The asset server answers a missing `.js` with the
  // single-page shell, the module fails its MIME check, and nothing renders: the start-up overlay
  // pulses forever. This file is a plain script the document loads before any module, so it still
  // runs when the module graph is the thing that broke — the only place a start-up failure can be
  // answered. One reload hands the visitor the current document; the session flag stops a genuinely
  // broken deployment from reloading in a loop.
  var RECOVERY_KEY = 'inkstone.boot-recovery'
  // The locale catalog cannot carry this copy: it is one of the files a stale document loses, and
  // the message has to be readable exactly when the catalog is not.
  var FAILURE_COPY = {
    'en-US': {
      title: 'Inkstone could not start',
      detail: 'This page was loaded from an older version of the app. Reload to get the current one.',
      action: 'Reload',
    },
    'zh-CN': {
      title: 'Inkstone 没能启动',
      detail: '这个页面来自旧版本，重新加载可以取到当前版本。',
      action: '重新加载',
    },
  }
  var booted = false
  var installed = Boolean(window.__inkstoneBoot)

  // A browser that refuses session storage cannot prove it has not already reloaded, so it is
  // answered with the message rather than a loop it cannot remember having started.
  function recoveryAttempted() {
    try {
      return sessionStorage.getItem(RECOVERY_KEY) === '1'
    } catch (e) {
      return true
    }
  }

  function setRecoveryAttempted(attempted) {
    try {
      if (attempted) sessionStorage.setItem(RECOVERY_KEY, '1')
      else sessionStorage.removeItem(RECOVERY_KEY)
    } catch (e) {

    }
  }

  function showFailure() {
    // A module script in the head can fail before the body exists, and the overlay is in the body:
    // waiting for it keeps the message in the document the visitor is looking at.
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showFailure, { once: true })
      return
    }
    var boot = document.getElementById('boot')
    if (!boot) {
      boot = document.createElement('div')
      boot.id = 'boot'
      document.body.appendChild(boot)
    }
    // The overlay is hidden from assistive technology while it is only decoration; the message is
    // the one thing on the page now, so it has to be announced and its button reachable.
    boot.removeAttribute('aria-hidden')
    var copy = FAILURE_COPY[document.documentElement.lang] || FAILURE_COPY['en-US']
    var panel = document.createElement('div')
    panel.className = 'boot-failure'
    panel.setAttribute('role', 'alert')
    var title = document.createElement('p')
    title.className = 'boot-failure-title'
    title.textContent = copy.title
    var detail = document.createElement('p')
    detail.className = 'boot-failure-detail'
    detail.textContent = copy.detail
    var action = document.createElement('button')
    action.type = 'button'
    action.className = 'boot-failure-action'
    action.textContent = copy.action
    action.addEventListener('click', function () {
      location.reload()
    })
    panel.appendChild(title)
    panel.appendChild(detail)
    panel.appendChild(action)
    boot.replaceChildren(panel)
    action.focus()
  }

  function fail() {
    if (recoveryAttempted()) {
      showFailure()
      return
    }
    setRecoveryAttempted(true)
    location.reload()
  }

  window.__inkstoneBoot = {
    fail: fail,
    booted: function () {
      return booted
    },
    ready: function () {
      booted = true
      // Cleared once the current document rendered, so the next deploy recovers the same way
      // instead of finding this tab's guard already used.
      setRecoveryAttempted(false)
    },
  }

  // An entry chunk that cannot be fetched, or that comes back as HTML, fires `error` on its own
  // element and never produces the promise `start()` awaits — no rejection for the app to catch.
  // Once the app is up this listener steps aside, so a feature's third-party script (the drawing
  // engine's) failing later is not answered with a page reload. The listener reads the recovery
  // object off `window` rather than closing over one, so a re-install in a test replaces the state
  // it consults instead of leaving a second, stale copy behind.
  if (!installed) {
    window.addEventListener('error', function (event) {
      var target = event.target
      if (!target || target.tagName !== 'SCRIPT') return
      var recovery = window.__inkstoneBoot
      if (!recovery || recovery.booted()) return
      recovery.fail()
    }, true)
    // A lazy chunk a newer deployment replaced fails its dynamic import *after* the app is up, so the
    // listener above has already stepped aside. Vite announces exactly that as `vite:preloadError`; the
    // same one-reload guard answers it, and a deployment that is genuinely broken still ends at the
    // panel instead of reloading forever. `preventDefault` stops Vite from rethrowing into the feature's
    // error boundary, which is a dead end for a tab that has been open since the last release.
    window.addEventListener('vite:preloadError', function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      var recovery = window.__inkstoneBoot
      if (recovery) recovery.fail()
    })
  }
})()
