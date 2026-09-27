if (new URLSearchParams(location.search).get('debug') === 'true') {
  document.title = 'Smear Frames — Debug Scene'
  await import('./debug/style.css')
  await import('./debug/main.js')
} else {
  await import('./main.js')
}
