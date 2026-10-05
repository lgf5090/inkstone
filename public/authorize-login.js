;(function () {
  var form = document.getElementById('login')
  if (!form) return
  var fallback = form.getAttribute('data-sign-in-failed') || 'Sign-in failed'
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
      if (!response.ok) {
        var body = await response.json().catch(function () { return null })
        throw new Error((body && body.error && body.error.message) || fallback)
      }
      location.reload()
    } catch (reason) {
      error.textContent = reason.message || fallback
      button.disabled = false
    }
  })
})()
