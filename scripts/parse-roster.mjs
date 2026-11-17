// Parses the "Student Data" sheet (exported as markdown) into a roster JSON.
import fs from 'node:fs'
import path from 'node:path'

const src = process.argv[2]
const out = process.argv[3]
const text = fs.readFileSync(src, 'utf8').split(/\r?\n/)

const start = text.findIndex((l) => l.startsWith('## Student Data'))
const end = text.findIndex((l, i) => i > start && l.startsWith('## '))

const rows = []
for (let i = start; i < (end === -1 ? text.length : end); i += 1) {
  const cells = text[i].split('|').map((c) => c.trim())
  if (cells.length < 5) continue
  const [, sn, section, rollNo, name] = cells
  if (!/^\d+$/.test(sn) || !/^[A-Z]{1,2}$/.test(section)) continue
  if (!/^\d{2}[A-Z]{1,2}\d{3}$/.test(rollNo)) continue
  if (!name) continue
  rows.push({ rollNo, name, section, batch: rollNo.slice(0, 2) })
}

const byBatch = {}
const bySection = {}
for (const r of rows) {
  byBatch[r.batch] = (byBatch[r.batch] || 0) + 1
  bySection[r.section] = (bySection[r.section] || 0) + 1
}

console.log('parsed students:', rows.length)
console.log('batches:', JSON.stringify(byBatch))
console.log('sections:', Object.keys(bySection).sort().join(','))
console.log('per-section counts:', JSON.stringify(bySection))
console.log('sample:', JSON.stringify(rows.slice(0, 3)))
console.log('last:', JSON.stringify(rows.slice(-2)))

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(rows, null, 2))
console.log('wrote', out)
