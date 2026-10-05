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
  } catch (e) {

  }
})()
