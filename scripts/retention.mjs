import '../src/env.js'
import mongoose from 'mongoose'
import { connectDb, isConnected } from '../src/db.js'
import { runRetention, retentionDays } from '../src/retention.js'

// Manual run of the retention job:
//   npm run retention            archive + delete everything past RETENTION_DAYS
//   npm run retention -- --dry   only list what would be archived
const dryRun = process.argv.includes('--dry')

await connectDb()
if (!isConnected()) {
  console.error('No database connection.')
  process.exit(1)
}

const days = retentionDays()
const result = await runRetention({ days, dryRun })

console.log(`Retention window: ${days} days`)
console.log(`Dates past the window: ${result.dates.length ? result.dates.join(', ') : 'none'}`)
for (const item of result.results) {
  if (item.error) console.log(`  ${item.date}: kept (${item.error})`)
  else if (dryRun) console.log(`  ${item.date}: ${item.wouldArchive} row(s) would be archived`)
  else if (item.archived) console.log(`  ${item.date}: ${item.archived} row(s) archived at ${item.url}`)
}
if (result.skipped === 'cloudinary') console.log('CLOUDINARY_* is not configured, so nothing was deleted.')

await mongoose.disconnect()
