// Bundles the Vite build into one self-contained HTML page for publishing as an Artifact.
import fs from 'fs'
import path from 'path'
const dist = 'dist'
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const js = html.match(/src="\/?(assets\/[^"]+\.js)"/)[1]
const css = html.match(/href="\/?(assets\/[^"]+\.css)"/)[1]
const jsCode = fs.readFileSync(path.join(dist, js), 'utf8').replace(/<\/script/gi, '<\\/script')
const cssCode = fs.readFileSync(path.join(dist, css), 'utf8').replace(/<\/style/gi, '<\\/style')
  // CSS is inlined into the page here, so image paths are relative to the page, not to assets/
  .replace(/url\((['"]?)\.\.\/img\//g, 'url($1img/')
const out = `<title>MooNest</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="theme-color" content="#2f6b4f">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Outfit:wght@500;600;700;800&family=Instrument+Serif:ital@0;1&family=Fredoka:wght@600;700&display=swap">
<style>${cssCode}</style>
<div id="root"></div>
<script type="module">${jsCode}</script>
`
const target = process.argv[2] || 'moonest-app.html'
fs.writeFileSync(target, out)
console.log('wrote', target, (out.length / 1024).toFixed(0) + ' KB')
