const fs = require('fs')
const path = require('path')

const repo = path.join(__dirname, '..')
const src = path.join(repo, 'src', 'tests', 'data')
const dest = path.join(repo, 'dist', 'tests', 'data')

if (!fs.existsSync(src)) {
  console.log('No test data to copy:', src)
  process.exit(0)
}

try {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  // Node 16+ has fs.cpSync
  if (fs.cpSync) {
    fs.cpSync(src, dest, { recursive: true })
  } else {
    // fallback: copy files manually
    const files = fs.readdirSync(src)
    for (const f of files) {
      const s = path.join(src, f)
      const d = path.join(dest, f)
      const stat = fs.statSync(s)
      if (stat.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        // naive copy
        const inner = fs.readdirSync(s)
        for (const fi of inner) fs.copyFileSync(path.join(s, fi), path.join(d, fi))
      } else {
        fs.copyFileSync(s, d)
      }
    }
  }
  console.log('Copied test data from', src, 'to', dest)
} catch (err) {
  console.error('Failed copying test data:', err)
  process.exit(1)
}