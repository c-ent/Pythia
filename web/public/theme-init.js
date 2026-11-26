// Runs in <head> before the app and before first paint, so a saved Dark
// theme never flashes light (also offline: it is precached). Same key and
// rules as applyTheme in src/theme/theme.ts; change both together.
;(function () {
  var choice = 'system'
  try {
    choice = localStorage.getItem('pythia.theme') || 'system'
  } catch {
    // No storage: follow the system.
  }
  var dark =
    choice === 'dark' ||
    (choice !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  var theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#0f0f10' : '#17191e')
})()
