;(function () {
  var form = document.getElementById('login')
  if (!form) return
  var fallback = form.getAttribute('data-sign-in-failed') || 'Sign-in failed'
  var twoFactorPrompt = form.getAttribute('data-two-factor-required') || 'Two-factor verification required'
  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    var values = new FormData(form)
    var button = form.querySelector('button')
    var error = document.getElementById('error')
    button.disabled = true
    error.textContent = ''
    try {
      var response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
        body: JSON.stringify({ username: values.get('username'), password: values.get('password') }),
      })
      var body = await response.json().catch(function () { return null })
      if (!response.ok) {
        throw new Error((body && body.error && body.error.message) || fallback)
      }
      if (body && body.twoFactorRequired) {
        var next = new URL('/login', location.origin)
        next.searchParams.set('next', location.pathname + location.search)
        error.textContent = twoFactorPrompt
        var link = document.createElement('a')
        link.href = next.pathname + '?' + next.searchParams.toString()
        link.textContent = twoFactorPrompt
        error.appendChild(link)
        button.disabled = false
        return
      }
      location.reload()
    } catch (reason) {
      error.textContent = reason.message || fallback
      button.disabled = false
    }
  })
})()
