import sharp from 'sharp'
import DailyRecord from './models/DailyRecord.js'
import BusLog from './models/BusLog.js'
import SectionNc from './models/SectionNc.js'
import DayArchive from './models/DayArchive.js'
import AuditLog from './models/AuditLog.js'
import { cloudinaryConfig, uploadImage } from './cloudinary.js'

export { cloudinaryConfig }

// Excel-fed data (the coordinator's exit/entry sheets, the CC NC sheet and the
// bus arrival sheet) is kept for RETENTION_DAYS. Before a day is removed, an
// image of that day's rows is rendered, uploaded to Cloudinary, and only then
// are the rows deleted. If the upload fails the day is kept and retried later.

const FOLDER = 'daily-check/archive'
const RUN_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_RUN_DELAY_MS = 15 * 1000

const CLEARED_RESTRICTION = {
  restrictionType: null,
  restrictionReason: null,
  restrictionEndDate: null,
  restrictionUntilResolved: false,
  pendingSubjects: [],
  resolutionStatus: 'none',
  resolvedOn: null,
}

export const retentionDays = () => {
  const configured = Number(process.env.RETENTION_DAYS)
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 30
}

const isoDaysAgo = (days) => {
  const when = new Date()
  when.setHours(12, 0, 0, 0)
  when.setDate(when.getDate() - days)
  return when.toLocaleDateString('en-CA')
}

// Every date that still holds Excel-fed rows, oldest first.
export async function expiredDates(days = retentionDays()) {
  const [recordDates, busDates, ncDates] = await Promise.all([
    DailyRecord.distinct('date', { restrictionType: { $in: ['exit', 'entry'] } }),
    BusLog.distinct('date'),
    SectionNc.distinct('date'),
  ])

  const cutoff = isoDaysAgo(days)
  return [...new Set([...recordDates, ...busDates, ...ncDates])]
    .filter((date) => typeof date === 'string' && date < cutoff)
    .sort()
}

async function loadDay(date) {
  const [records, nc, buses] = await Promise.all([
    DailyRecord.find({ date, restrictionType: { $in: ['exit', 'entry'] } })
      .select(
        'grade section rollNo name restrictionType restrictionReason pendingSubjects resolutionStatus'
      )
      .sort({ section: 1, rollNo: 1 })
      .lean(),
    SectionNc.find({ date }).sort({ grade: 1, section: 1 }).lean(),
    BusLog.find({ date }).sort({ route: 1 }).lean(),
  ])

  return { date, records, nc, buses }
}

const escapeXml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char]
  })

const clip = (value, max) => {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const classLabel = (grade, section) => `${grade === 'PU1' ? '11' : '12'}${section}`

const cap = (value) =>
  typeof value === 'string' && value ? value.charAt(0).toUpperCase() + value.slice(1) : value

const WIDTH = 1120
const PAD = 40
const ROW_HEIGHT = 22

// A plain, printable table image of the day: no styling beyond what a printed
// sheet would have, so the snapshot stays readable years later.
export function renderDaySvg(day, days = retentionDays()) {
  const parts = []
  let y = 74

  parts.push(
    `<text x="${PAD}" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="21" font-weight="700" fill="#0f172a">Daily check archive</text>`,
    `<text x="${PAD}" y="76" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#475467">${escapeXml(
      `${day.date} · Excel data kept ${days} days, then removed from the app`
    )}</text>`
  )
  y = 112

  const heading = (text) => {
    parts.push(
      `<text x="${PAD}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="#0f172a">${escapeXml(
        text
      )}</text>`
    )
    y += 20
  }

  const table = (columns, rows) => {
    const header = columns
      .map(
        (column, index) =>
          `<text x="${column.x}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="700" fill="#667085">${escapeXml(
            column.label.toUpperCase()
          )}</text>`
      )
      .join('')
    parts.push(header)
    y += 8
    parts.push(
      `<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="#d0d5dd" stroke-width="1" />`
    )
    y += 16

    for (const row of rows) {
      const cells = columns
        .map(
          (column) =>
            `<text x="${column.x}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="12.5" fill="#1d2939">${escapeXml(
              clip(row[column.key], column.max || 46)
            )}</text>`
        )
        .join('')
      parts.push(cells)
      y += ROW_HEIGHT
    }

    parts.push(
      `<line x1="${PAD}" y1="${y - 8}" x2="${WIDTH - PAD}" y2="${y - 8}" stroke="#e4e7ec" stroke-width="1" />`
    )
    y += 18
  }

  const callout = (text) => {
    parts.push(
      `<text x="${PAD}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="12.5" fill="#667085">${escapeXml(
        text
      )}</text>`
    )
    y += 22
  }

  const bySection = new Map()
  for (const record of day.records) {
    const key = classLabel(record.grade, record.section)
    if (!bySection.has(key)) bySection.set(key, [])
    bySection.get(key).push(record)
  }

  heading('Exit and entry restrictions')
  if (bySection.size === 0) {
    callout('No restriction rows were fed for this day.')
  } else {
    for (const [label, records] of [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const exitCount = records.filter((record) => record.restrictionType === 'exit').length
      const entryCount = records.length - exitCount
      callout(`${label} · ${exitCount} exit, ${entryCount} entry`)
      table(
        [
          { key: 'no', label: 'No', x: PAD, max: 4 },
          { key: 'rollNo', label: 'Roll no', x: PAD + 40 },
          { key: 'name', label: 'Student', x: PAD + 130 },
          { key: 'type', label: 'Sheet', x: PAD + 330 },
          { key: 'detail', label: 'Reason / subjects', x: PAD + 410, max: 60 },
          { key: 'status', label: 'Status', x: PAD + 880 },
        ],
        records.map((record, index) => ({
          no: index + 1,
          rollNo: record.rollNo,
          name: record.name,
          type: record.restrictionType === 'exit' ? 'Exit' : 'Entry',
          detail:
            record.restrictionType === 'exit'
              ? record.restrictionReason || 'Exit restriction'
              : (record.pendingSubjects || []).join(', ') || 'All subjects',
          status: cap(record.resolutionStatus),
        }))
      )
    }
  }

  heading('CC NC sheet')
  if (day.nc.length === 0) {
    callout('No NC rows were fed for this day.')
  } else {
    table(
      [
        { key: 'section', label: 'Section', x: PAD },
        { key: 'count', label: 'NC count', x: PAD + 140 },
        { key: 'ne', label: 'Updated in NE', x: PAD + 260 },
        { key: 'author', label: 'Entered by', x: PAD + 400, max: 30 },
      ],
      day.nc.map((row) => ({
        section: classLabel(row.grade, row.section),
        count: row.count ?? 0,
        ne: row.updatedInNe ? 'Yes' : 'No',
        author: row.author || 'Coordinator',
      }))
    )
  }

  heading('Bus arrivals')
  if (day.buses.length === 0) {
    callout('No bus rows were fed for this day.')
  } else {
    table(
      [
        { key: 'route', label: 'Route', x: PAD },
        { key: 'arrival', label: 'Arrival', x: PAD + 120 },
        { key: 'late', label: 'Late', x: PAD + 240 },
        { key: 'affected', label: 'Students affected', x: PAD + 360 },
        { key: 'override', label: 'Override', x: PAD + 520, max: 40 },
      ],
      day.buses.map((bus) => ({
        route: bus.route,
        arrival: bus.arrivalTime || 'Not arrived',
        late: bus.late ? 'Late' : 'Not late',
        affected: bus.affectedStudents ?? 0,
        override: bus.overrideReason || '-',
      }))
    )
  }

  const height = Math.max(y + 24, 360)
  const body = parts.join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}"><rect width="${WIDTH}" height="${height}" fill="#ffffff" />${body}</svg>`
}

export async function renderDayImage(day, days = retentionDays()) {
  return sharp(Buffer.from(renderDaySvg(day, days))).png().toBuffer()
}

export async function uploadSnapshot(png, date) {
  const upload = await uploadImage(png, {
    folder: FOLDER,
    publicId: date,
    mime: 'image/png',
    overwrite: true,
  })
  return { ...upload, bytes: png.length }
}

// Snapshot first, delete second. A failed upload leaves the day untouched.
export async function purgeDay(date, { days = retentionDays(), dryRun = false } = {}) {
  const day = await loadDay(date)
  const total = day.records.length + day.nc.length + day.buses.length
  if (total === 0) return { date, skipped: 'empty' }
  if (dryRun) return { date, wouldArchive: total }

  const png = await renderDayImage(day, days)
  const upload = await uploadSnapshot(png, date)

  await DayArchive.findOneAndUpdate(
    { date },
    {
      $set: {
        url: upload.url,
        publicId: upload.publicId,
        bytes: upload.bytes,
        rows: total,
        counts: {
          exit: day.records.filter((record) => record.restrictionType === 'exit').length,
          entry: day.records.filter((record) => record.restrictionType === 'entry').length,
          ncSections: day.nc.length,
          busRoutes: day.buses.length,
        },
        deletedAt: new Date(),
      },
    },
    { upsert: true }
  )

  await DailyRecord.updateMany(
    { date, restrictionType: { $in: ['exit', 'entry'] } },
    { $set: CLEARED_RESTRICTION }
  )
  await BusLog.deleteMany({ date })
  await SectionNc.deleteMany({ date })

  await AuditLog.create({
    action: 'Excel data archived and deleted',
    detail: `${date}: ${total} row(s) snapshotted at ${upload.url} before deletion`,
  })

  return { date, archived: total, url: upload.url }
}

export async function runRetention({ days = retentionDays(), dryRun = false } = {}) {
  const dates = await expiredDates(days)
  if (dates.length === 0) return { days, dates, purged: 0, results: [] }

  if (!dryRun && !cloudinaryConfig()) {
    console.warn('[retention] CLOUDINARY_* is not set, so nothing was deleted.')
    return { days, dates, purged: 0, results: [], skipped: 'cloudinary' }
  }

  const results = []
  for (const date of dates) {
    try {
      const result = await purgeDay(date, { days, dryRun })
      results.push(result)
      if (result.archived) console.log(`[retention] ${date}: ${result.archived} row(s) archived, then deleted`)
    } catch (error) {
      results.push({ date, error: error.message })
      console.error(`[retention] ${date} kept: ${error.message}`)
    }
  }

  return {
    days,
    dates,
    purged: results.filter((result) => result.archived).length,
    results,
  }
}

export function startRetention() {
  const tick = () =>
    runRetention().catch((error) => console.error('[retention]', error.message))

  const first = setTimeout(tick, FIRST_RUN_DELAY_MS)
  const timer = setInterval(tick, RUN_EVERY_MS)
  if (first.unref) first.unref()
  if (timer.unref) timer.unref()
  return timer
}
