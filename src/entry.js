if (new URLSearchParams(location.search).get('debug') === 'true') {
  await import('./debug/style.css')
  await import('./debug/main.js')
} else {
  await import('./main.js')
}
