import express from 'express'
import { randomUUID } from 'node:crypto'
import { ensureDay } from './day.js'
import { uploadImage } from './cloudinary.js'
import DayArchive from './models/DayArchive.js'
import {
  DEFAULT_BUS_CUTOFF,
  DEFAULT_ENTRY_SUBJECTS,
  DEFAULT_EXIT_REASONS,
  todayIso,
} from './defaults.js'

const SECOND_CUTOFF = DEFAULT_BUS_CUTOFF
const ENTRY_CUTOFF = '09:00'
const ACK_WINDOW_MINUTES = 30
const EXIT_STATUSES = ['pending', 'acknowledged', 'absent', 'excused', 'resolved']
const ACTIVE_WINDOW_DAYS = 30

const DEFAULT_SETTINGS = {
  exitReasons: [...DEFAULT_EXIT_REASONS],
  entrySubjects: [...DEFAULT_ENTRY_SUBJECTS],
  busCutoff: DEFAULT_BUS_CUTOFF,
  routeCutoffs: {},
}

const parseNcCountFromDetail = (detail) => {
  const match = String(detail || '').match(/(?:crossed\s*(\d+)|(\d+))\s*nc/i)
  if (match) {
    const num = Number(match[1] || match[2])
    return Number.isFinite(num) && num > 0 ? num : 3
  }
  return /nc/i.test(String(detail || '')) ? 3 : 0
}

const HANDOVER_OUTCOMES = {
  cleared: { label: 'Cleared & Sent to Class', status: 'resolved' },
  'sent-home': { label: 'Sent Home', status: 'excused' },
  'parent-called': { label: 'Parent Called', status: 'acknowledged' },
}

async function loadSettings(Settings) {
  const doc = await Settings.findOne({ key: 'main' }).lean()
  if (!doc) return { ...DEFAULT_SETTINGS }

  const cutoffs = doc.routeCutoffs
  return {
    exitReasons: doc.exitReasons?.length ? doc.exitReasons : DEFAULT_SETTINGS.exitReasons,
    entrySubjects: doc.entrySubjects?.length ? doc.entrySubjects : DEFAULT_SETTINGS.entrySubjects,
    busCutoff: doc.busCutoff || DEFAULT_SETTINGS.busCutoff,
    routeCutoffs:
      cutoffs instanceof Map ? Object.fromEntries(cutoffs) : cutoffs || {},
  }
}

async function writeAudit(AuditLog, action, detail) {
  await AuditLog.create({ at: new Date(), action, detail })
}

const MESSAGE_TYPES = {
  update: 'Update',
  announcement: 'Announcement',
  'authorized-exit': 'Authorized Exit',
  broadcast: 'Broadcast',
}

// Names used on the admin desk. Older leader rows carry no fromRole, so a row
// whose sender is not one of these desks is treated as the class teacher's.
const ADMIN_SENDERS = new Set(['Admin / Coordinator', 'Super Admin'])

const INBOX_ROLE_LABEL = {
  admin: 'Admin / Coordinator',
  superadmin: 'Super Admin',
  teacher: 'Class Teacher',
  leader: 'Class Leader',
  transport: 'Transport In-charge',
  gate: 'Gate / Security',
}

const INBOX_TARGETS = {
  teacher: ['LEADER', 'ADMIN', 'ALL'],
  leader: ['TEACHER', 'ADMIN', 'ALL'],
  transport: ['ADMIN', 'ALL'],
  gate: ['ADMIN', 'ALL'],
  admin: ['SUPERADMIN', 'TEACHER', 'LEADER', 'TRANSPORT', 'GATE', 'ALL'],
  superadmin: ['ADMIN', 'TEACHER', 'LEADER', 'ALL'],
}

const classLabelOf = (grade, section) => `${grade === 'PU1' ? '11' : '12'}${section}`

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isoDaysAgo = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA')

// The school day before an ISO date, used to spot a student who is on the same
// restriction sheet two days running.
const previousIso = (iso) => {
  const when = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(when.getTime())) return ''
  when.setUTCDate(when.getUTCDate() - 1)
  return when.toISOString().slice(0, 10)
}

const toMinutes = (clock) => {
  if (!clock) return null
  const [hours, minutes] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

// The school clock is Indian Standard Time no matter where the API runs, so
// every timestamp the dashboards show matches the wall clock in the office.
const IST = 'Asia/Kolkata'

const istParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '00'
  return { hour: part('hour'), minute: part('minute'), second: part('second') }
}

const istClock = (value) => {
  const { hour, minute } = istParts(value)
  return `${hour}:${minute}`
}

const istClockSeconds = (value) => {
  const { hour, minute, second } = istParts(value)
  return `${hour}:${minute}:${second}`
}

const clockNow = () => {
  const { hour, minute } = istParts()
  return Number(hour) * 60 + Number(minute)
}

// R1, R2, … R27 instead of the lexicographic R1, R10, R11, R2.
const routeNumber = (route) => {
  const match = String(route || '').match(/(\d+)/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

const byRoute = (a, b) =>
  routeNumber(a) - routeNumber(b) || String(a).localeCompare(String(b))

// Express 4 does not await handlers, so unwrap rejections into JSON errors.
const api = (handler) => (req, res, next) => handler(req, res).catch(next)

const httpError = (status, message) => Object.assign(new Error(message), { status })

async function allSections({ Student }) {
  const groups = await Student.aggregate([
    { $group: { _id: { grade: '$grade', section: '$section' } } },
    { $sort: { '_id.section': 1 } },
  ])
  return groups.map((group) => ({ grade: group._id.grade, section: group._id.section }))
}

function scope(query, fallbackDate) {
  const filter = { date: query.date || fallbackDate }
  if (query.grade && query.grade !== 'ALL') filter.grade = query.grade
  if (query.section && query.section !== 'ALL') filter.section = query.section
  return filter
}

const countByStatus = (groups) =>
  Object.fromEntries(EXIT_STATUSES.map((status) => [
    status,
    groups.find((group) => group._id === status)?.count || 0,
  ]))

export function buildRecordsRouter({
  Student,
  DailyRecord,
  BusLog,
  EntrySection,
  LeaderMessage,
  LeaderNote,
  TeacherNotice,
  InboxMessage,
  Section,
  Settings,
  AuditLog,
  GateLog,
  DailyNote,
  SectionNc,
  Announcement,
}) {
  const router = express.Router()

  // Any screen that reads today can safely ask for the day to exist first.
  // Memory-cached, so it is a no-op after the first call.
  const ensureToday = () => ensureDay({ Student, DailyRecord, BusLog })

  // ---- announcement photos ------------------------------------------------

  // One viewer per dashboard account, so "seen" is per person rather than
  // shared between everyone signed in as the same role.
  const viewerKey = (user) => (user ? `${user.role}:${user.email || user.name || ''}` : '')

  const announcementOut = (doc, viewer = '') => ({
    id: String(doc._id),
    caption: doc.caption || '',
    photoUrl: doc.photoUrl,
    author: doc.authorName,
    authorRole: doc.authorRole,
    context: doc.context || null,
    seen: viewer ? (doc.viewedBy || []).includes(viewer) : false,
    date: doc.createdAt
      ? new Date(doc.createdAt).toLocaleDateString('en-CA', { timeZone: IST })
      : '',
    atIst: doc.createdAt ? istClock(doc.createdAt) : '',
    createdAt: doc.createdAt,
  })

  // Snapshots taken before a past day's Excel rows were deleted, newest
  // first. The Broadcast screen shows these as proof of what was archived.
  router.get(
    '/archives',
    api(async (req, res) => {
      const docs = await DayArchive.find({}).sort({ date: -1 }).limit(120).lean()
      res.json({
        archives: docs.map((doc) => ({
          id: String(doc._id),
          date: doc.date,
          url: doc.url,
          rows: doc.rows || 0,
          counts: doc.counts || {},
          deletedAt: doc.deletedAt || null,
        })),
      })
    })
  )

  router.get(
    '/announcements',
    api(async (req, res) => {
      const docs = await Announcement.find({})
        .sort({ createdAt: -1 })
        .limit(60)
        .lean()
      const viewer = viewerKey(req.user)
      res.json({ announcements: docs.map((doc) => announcementOut(doc, viewer)) })
    })
  )

  // An announcement is read only when that particular row is opened, the same
  // way an inbox message is.
  router.post(
    '/announcements/:id/view',
    api(async (req, res) => {
      const viewer = viewerKey(req.user)
      if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw httpError(400, 'Unknown announcement.')

      const doc = await Announcement.findByIdAndUpdate(
        req.params.id,
        { $addToSet: { viewedBy: viewer } },
        { new: true }
      ).lean()
      if (!doc) throw httpError(404, 'That announcement is no longer available.')
      res.json({ ok: true, seen: true })
    })
  )

  // The camera sends a resized JPEG as a data URL; the API uploads it to
  // Cloudinary and keeps only the address, so the photo never sits in Mongo.
  router.post(
    '/announcements',
    api(async (req, res) => {
      const role = req.user?.role
      if (role !== 'leader') {
        throw httpError(403, 'Only the class leader posts announcement photos.')
      }

      const { image, caption = '' } = req.body || {}
      const text = String(caption).trim()
      if (text.length > 1000) throw httpError(400, 'Keep the announcement under 1000 characters.')

      const match = String(image || '').match(
        /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/
      )
      if (!match) throw httpError(400, 'Take or choose a photo to post.')

      const bytes = Buffer.from(match[2], 'base64')
      if (bytes.length > 6 * 1024 * 1024) {
        throw httpError(413, 'That photo is too large. Take it again.')
      }

      const mime =
        match[1] === 'png' ? 'image/png' : match[1] === 'webp' ? 'image/webp' : 'image/jpeg'
      const upload = await uploadImage(bytes, {
        folder: 'daily-check/announcements',
        mime,
      })

      const doc = await Announcement.create({
        caption: text,
        photoUrl: upload.url,
        photoPublicId: upload.publicId,
        authorRole: role,
        authorName: req.user?.name || INBOX_ROLE_LABEL[role] || role,
        authorEmail: req.user?.email || null,
        context: req.user?.grade
          ? `${classLabelOf(req.user.grade, req.user.section)} · ${INBOX_ROLE_LABEL[role]}`
          : null,
        viewedBy: [viewerKey(req.user)].filter(Boolean),
      })

      await writeAudit(
        AuditLog,
        'Announcement photo posted',
        `${INBOX_ROLE_LABEL[role] || role}: ${upload.url}`
      )
      res.status(201).json({ announcement: announcementOut(doc.toObject(), viewerKey(req.user)) })
    })
  )

  router.get(
    '/filters',
    api(async (req, res) => {
      const groups = await Student.aggregate([
        { $group: { _id: { grade: '$grade', section: '$section' }, count: { $sum: 1 } } },
        { $sort: { '_id.section': 1 } },
      ])

      const grades = { PU1: [], PU2: [] }
      let total = 0
      for (const group of groups) {
        grades[group._id.grade]?.push({ section: group._id.section, count: group.count })
        total += group.count
      }

      res.json({ grades, total, today: todayIso() })
    })
  )

  // The four live KPI cards: buses, exit, entry and class-leader messages.
  router.get(
    '/kpi',
    api(async (req, res) => {
      await ensureToday()
      const match = scope(req.query, todayIso())
      const date = match.date
      const isToday = date === todayIso()
      // Past days are complete, so every clock window has already elapsed.
      const clock = isToday ? clockNow() : 24 * 60
      const settings = await loadSettings(Settings)
      const cutoffMin = toMinutes(settings.busCutoff)

      const sectionFilter = {}
      if (match.grade) sectionFilter.grade = match.grade
      if (match.section) sectionFilter.section = match.section

      const exitMatch = { ...match, restrictionType: 'exit' }
      const entryMatch = { ...match, restrictionType: 'entry' }

      const [busRoutes, entrySections, messages, exitRows, entryRows, handover, exitGroups, entryGroups, busLateGroups, routeRiderGroups] =
        await Promise.all([
          BusLog.find({ date }).sort({ route: 1 }).lean(),
          EntrySection.find({ date, ...sectionFilter }).sort({ grade: 1, section: 1 }).lean(),
          LeaderMessage.find({ date, ...sectionFilter }).sort({ sentAt: -1 }).lean(),
          DailyRecord.find(exitMatch)
            .sort({ section: 1, rollNo: 1 })
            .limit(120)
            .select('-_id rollNo name grade section restrictionReason resolutionStatus')
            .lean(),
          DailyRecord.find(entryMatch)
            .sort({ section: 1, rollNo: 1 })
            .limit(120)
            .select('-_id rollNo name grade section restrictionReason resolutionStatus handover')
            .lean(),
          DailyRecord.countDocuments({ ...entryMatch, handover: true }),
          DailyRecord.aggregate([{ $match: exitMatch }, { $group: { _id: '$resolutionStatus', count: { $sum: 1 } } }]),
          DailyRecord.aggregate([{ $match: entryMatch }, { $group: { _id: '$resolutionStatus', count: { $sum: 1 } } }]),
          DailyRecord.aggregate([
            { $match: { date, busLate: true } },
            { $group: { _id: '$busRoute', count: { $sum: 1 } } },
          ]),
          DailyRecord.aggregate([
            {
              $match: {
                date,
                ...sectionFilter,
                busRoute: { $ne: null },
                rider: { $ne: false },
              },
            },
            { $group: { _id: '$busRoute', count: { $sum: 1 } } },
          ]),
        ])

      // Route codes are strings, so sort numerically (R1, R2, … R10).
      busRoutes.sort((a, b) => Number(a.route.slice(1)) - Number(b.route.slice(1)))

      // A manual transport override wins over the computed lateness, and the
      // affected count comes from the students actually marked late: the
      // stored BusLog.late/affectedStudents are only the last computed values.
      const busLateMap = new Map(busLateGroups.map((group) => [group._id, group.count]))
      const routeRiderMap = new Map(routeRiderGroups.map((group) => [group._id, group.count]))
      // Late status follows the live 8:20 cut-off (or a transport override), so
      // the KPI card cannot drift from the transport screen.
      const effectiveLate = (route) => {
        if (route.overrideLate === true || route.overrideLate === false) return route.overrideLate
        const arrival = toMinutes(route.arrivalTime)
        return arrival !== null && arrival > cutoffMin
      }
      const hasOverride = (route) => route.overrideLate === true || route.overrideLate === false

      const lateRoutes = busRoutes.filter(effectiveLate)
      const notArrived = busRoutes.filter((route) => !route.arrivalTime && !hasOverride(route))
      const busCutoffPassed = clock >= toMinutes(SECOND_CUTOFF)

      const exitByStatus = countByStatus(exitGroups)
      const exitTotal = EXIT_STATUSES.reduce((sum, status) => sum + exitByStatus[status], 0)

      const entryByStatus = countByStatus(entryGroups)
      const entryTotal = EXIT_STATUSES.reduce((sum, status) => sum + entryByStatus[status], 0)

      const entryCutoffPassed = clock >= toMinutes(ENTRY_CUTOFF)
      const incompleteSections = entrySections.filter(
        (section) => !section.submittedAt || toMinutes(section.submittedAt) > toMinutes(ENTRY_CUTOFF)
      )

      const messageItems = messages.map((message) => {
        const sent = toMinutes(message.sentAt)
        // A class leader marks a message read by opening the inbox; older rows
        // still carry an explicit acknowledgement stamp.
        const readAt = message.seenAt || message.acknowledgedAt || null
        const readName = message.seenBy || message.acknowledgedBy || null
        const readMinutes = toMinutes(readAt)
        const slowRead = readMinutes !== null && readMinutes - sent > ACK_WINDOW_MINUTES
        const overdue =
          clock - sent > ACK_WINDOW_MINUTES && (readMinutes === null || slowRead)
        return {
          grade: message.grade,
          section: message.section,
          title: message.title,
          sentAt: message.sentAt,
          sentAtIst: istClock(message.createdAt),
          readAt,
          readBy: readName,
          overdue,
        }
      })

      res.json({
        date,
        buses: {
          totalRoutes: busRoutes.length,
          lateRoutes: lateRoutes.length,
          affectedStudents: lateRoutes.reduce(
            (sum, route) => sum + (routeRiderMap.get(route.route) || 0),
            0
          ),
          cutoff: settings.busCutoff,
          notArrived: notArrived.map((route) => ({
            route: route.route,
            affectedStudents: busLateMap.get(route.route) || 0,
          })),
          secondCutoff: SECOND_CUTOFF,
          cutoffPassed: busCutoffPassed,
          alert: busCutoffPassed && notArrived.length > 0,
          routes: busRoutes.map((route) => ({
            route: route.route,
            arrivalTime: route.arrivalTime,
            late: effectiveLate(route),
            affectedStudents: busLateMap.get(route.route) || 0,
          })),
        },
        exit: {
          total: exitTotal,
          active: exitTotal - exitByStatus.resolved,
          ...exitByStatus,
          students: exitRows,
        },
        entry: {
          total: entryTotal,
          ...entryByStatus,
          handoverQueue: handover,
          cutoff: ENTRY_CUTOFF,
          cutoffPassed: entryCutoffPassed,
          sectionsIncomplete: entryCutoffPassed ? incompleteSections.length : 0,
          incompleteSections: entryCutoffPassed
            ? incompleteSections.map((section) => ({
                grade: section.grade,
                section: section.section,
                submittedAt: section.submittedAt,
              }))
            : [],
          students: entryRows,
        },
        messages: {
          sent: messageItems.length,
          overdue: messageItems.filter((message) => message.overdue).length,
          overdueSections: [
            ...new Set(
              messageItems
                .filter((message) => message.overdue)
                .map((message) => `${message.grade === 'PU1' ? '11' : '12'}${message.section}`)
            ),
          ],
          windowMinutes: ACK_WINDOW_MINUTES,
          items: messageItems,
        },
      })
    })
  )

  // ---- quick actions -----------------------------------------------------

  router.post(
    '/restrictions/exit',
    api(async (req, res) => {
      const { rollNo, reason, endDate = null, untilResolved = false, date } = req.body || {}

      if (!rollNo) throw httpError(400, 'Pick a student from the master list.')
      const settings = await loadSettings(Settings)
      if (!settings.exitReasons.includes(reason)) {
        throw httpError(400, 'Choose a reason from the list.')
      }
      if (!untilResolved && !endDate) {
        throw httpError(400, 'Set an end date or choose Until Resolved.')
      }

      const day = date || todayIso()
      const student = await Student.findOne({ rollNo }).lean()
      if (!student) throw httpError(404, 'That student is not in the master list.')

      const record = await DailyRecord.findOneAndUpdate(
        { date: day, rollNo: student.rollNo },
        {
          $set: {
            restrictionType: 'exit',
            restrictionReason: reason,
            resolutionStatus: 'pending',
            restrictionEndDate: untilResolved ? null : endDate,
            restrictionUntilResolved: Boolean(untilResolved),
            pendingSubjects: [],
            handover: false,
            resolvedOn: null,
          },
          $setOnInsert: {
            date: day,
            student: student._id,
            rollNo: student.rollNo,
            name: student.name,
            grade: student.grade,
            section: student.section,
            attendance: 'present',
            busRoute: student.busRoute,
            busLate: false,
          },
        },
        { upsert: true, new: true }
      ).lean()

      await writeAudit(
        AuditLog,
        'Exit restriction added',
        `${student.rollNo}: ${reason}${untilResolved ? ' (until resolved)' : ` until ${endDate}`}`
      )
      res.status(201).json({ date: day, student, record })
    })
  )

  router.post(
    '/restrictions/entry',
    api(async (req, res) => {
      const { rollNo, subjects = [], date } = req.body || {}

      if (!rollNo) throw httpError(400, 'Pick a student from the master list.')
      const picked = [...new Set(subjects)]
      if (picked.length === 0) throw httpError(400, 'Select at least one pending subject.')
      const settings = await loadSettings(Settings)
      const unknown = picked.filter((subject) => !settings.entrySubjects.includes(subject))
      if (unknown.length) throw httpError(400, `Unknown subject: ${unknown.join(', ')}`)

      const day = date || todayIso()
      const student = await Student.findOne({ rollNo }).lean()
      if (!student) throw httpError(404, 'That student is not in the master list.')

      const record = await DailyRecord.findOneAndUpdate(
        { date: day, rollNo: student.rollNo },
        {
          $set: {
            restrictionType: 'entry',
            restrictionReason: picked.join(', '),
            pendingSubjects: picked,
            resolutionStatus: 'pending',
            restrictionEndDate: null,
            restrictionUntilResolved: false,
            handover: false,
            resolvedOn: null,
          },
          $setOnInsert: {
            date: day,
            student: student._id,
            rollNo: student.rollNo,
            name: student.name,
            grade: student.grade,
            section: student.section,
            attendance: 'present',
            busRoute: student.busRoute,
            busLate: false,
          },
        },
        { upsert: true, new: true }
      ).lean()

      await writeAudit(
        AuditLog,
        'Entry restriction added',
        `${student.rollNo}: ${picked.join(', ')}`
      )
      res.status(201).json({ date: day, student, record })
    })
  )

  router.post(
    '/restrictions/exit/bulk',
    api(async (req, res) => {
      const { rows = [], date } = req.body || {}
      if (!Array.isArray(rows) || rows.length === 0) {
        throw httpError(400, 'Provide a list of exit restriction rows to import.')
      }

      const day = date || todayIso()
      const settings = await loadSettings(Settings)
      const defaultReason = settings.exitReasons[0] || 'Crossed 3 NCs'

      const rollMap = new Map()
      for (const row of rows) {
        if (!row.rollNo) continue
        const norm = String(row.rollNo).trim().toUpperCase()
        rollMap.set(norm, row)
      }

      const rollNos = Array.from(rollMap.keys())
      const students = await Student.find({ rollNo: { $in: rollNos } }).lean()
      const studentMap = new Map(students.map((s) => [s.rollNo, s]))

      const ops = []
      const errors = []
      let successCount = 0

      for (const [normRoll, row] of rollMap.entries()) {
        const student = studentMap.get(normRoll)
        if (!student) {
          errors.push({ rollNo: normRoll, error: 'Student not found on master roster' })
          continue
        }

        const reason = row.reason && String(row.reason).trim() ? String(row.reason).trim() : defaultReason
        // An explicit "today only" row must stay that way; give it today's date
        // so the register never holds a restriction with no expiry.
        const untilResolved = row.untilResolved === false
          ? false
          : Boolean(row.untilResolved || !row.endDate)
        const endDate = untilResolved ? null : row.endDate || day

        ops.push({
          updateOne: {
            filter: { date: day, rollNo: student.rollNo },
            update: {
              $set: {
                restrictionType: 'exit',
                restrictionReason: reason,
                resolutionStatus: 'pending',
                restrictionEndDate: endDate,
                restrictionUntilResolved: untilResolved,
                pendingSubjects: [],
                handover: false,
                resolvedOn: null,
              },
              $setOnInsert: {
                date: day,
                student: student._id,
                rollNo: student.rollNo,
                name: student.name,
                grade: student.grade,
                section: student.section,
                attendance: 'present',
                busRoute: student.busRoute,
                busLate: false,
              },
            },
            upsert: true,
          },
        })
        successCount += 1
      }

      if (ops.length > 0) {
        await DailyRecord.bulkWrite(ops, { ordered: false })
        await writeAudit(
          AuditLog,
          'Bulk exit restrictions feed',
          `${successCount} student(s) updated for ${day}${errors.length ? `, ${errors.length} failed` : ''}`
        )
      }

      res.json({ ok: true, count: successCount, total: rows.length, errors })
    })
  )

  router.post(
    '/restrictions/entry/bulk',
    api(async (req, res) => {
      const { rows = [], date } = req.body || {}
      if (!Array.isArray(rows) || rows.length === 0) {
        throw httpError(400, 'Provide a list of entry restriction rows to import.')
      }

      const day = date || todayIso()

      const rollMap = new Map()
      for (const row of rows) {
        if (!row.rollNo) continue
        const norm = String(row.rollNo).trim().toUpperCase()
        rollMap.set(norm, row)
      }

      const rollNos = Array.from(rollMap.keys())
      const students = await Student.find({ rollNo: { $in: rollNos } }).lean()
      const studentMap = new Map(students.map((s) => [s.rollNo, s]))

      const ops = []
      const errors = []
      let successCount = 0

      for (const [normRoll, row] of rollMap.entries()) {
        const student = studentMap.get(normRoll)
        if (!student) {
          errors.push({ rollNo: normRoll, error: 'Student not found on master roster' })
          continue
        }

        let subjects = []
        if (Array.isArray(row.subjects)) {
          subjects = row.subjects.map((s) => String(s).trim()).filter(Boolean)
        } else if (typeof row.subjects === 'string' && row.subjects.trim()) {
          subjects = row.subjects.split(/[,;/+]+/).map((s) => s.trim()).filter(Boolean)
        }

        if (subjects.length === 0) {
          subjects = ['All Subjects']
        }

        const reason = subjects.join(', ')

        ops.push({
          updateOne: {
            filter: { date: day, rollNo: student.rollNo },
            update: {
              $set: {
                restrictionType: 'entry',
                restrictionReason: reason,
                pendingSubjects: subjects,
                resolutionStatus: 'pending',
                restrictionEndDate: null,
                restrictionUntilResolved: false,
                handover: false,
                resolvedOn: null,
              },
              $setOnInsert: {
                date: day,
                student: student._id,
                rollNo: student.rollNo,
                name: student.name,
                grade: student.grade,
                section: student.section,
                attendance: 'present',
                busRoute: student.busRoute,
                busLate: false,
              },
            },
            upsert: true,
          },
        })
        successCount += 1
      }

      if (ops.length > 0) {
        await DailyRecord.bulkWrite(ops, { ordered: false })
        await writeAudit(
          AuditLog,
          'Bulk entry restrictions feed',
          `${successCount} student(s) updated for ${day}${errors.length ? `, ${errors.length} failed` : ''}`
        )
      }

      res.json({ ok: true, count: successCount, total: rows.length, errors })
    })
  )

  router.post(
    '/students',
    api(async (req, res) => {
      const { rollNo, name, grade, section, busRoute = null } = req.body || {}
      if (!rollNo || !name || !grade || !section) {
        throw httpError(400, 'Roll number, name, grade (PU1/PU2), and section are required.')
      }
      const normRoll = String(rollNo).trim().toUpperCase()
      const normGrade = grade === 'PU2' ? 'PU2' : 'PU1'
      const normSection = String(section).trim().toUpperCase()

      const exists = await Student.findOne({ rollNo: normRoll }).lean()
      if (exists) {
        throw httpError(400, `Student with roll number "${normRoll}" already exists.`)
      }

      const student = await Student.create({
        rollNo: normRoll,
        name: String(name).trim(),
        grade: normGrade,
        section: normSection,
        busRoute: busRoute ? String(busRoute).trim().toUpperCase() : null,
      })

      const day = todayIso()
      await DailyRecord.updateOne(
        { date: day, rollNo: normRoll },
        {
          $setOnInsert: {
            date: day,
            student: student._id,
            rollNo: student.rollNo,
            name: student.name,
            grade: student.grade,
            section: student.section,
            attendance: 'present',
            busRoute: student.busRoute,
            busLate: false,
            rider: true,
          },
        },
        { upsert: true }
      )

      await writeAudit(AuditLog, 'Student created', `${normRoll}: ${student.name} (${normGrade}/${normSection})`)
      res.status(201).json({ ok: true, student })
    })
  )

  router.post(
    '/students/bulk',
    api(async (req, res) => {
      const { rows = [] } = req.body || {}
      if (!Array.isArray(rows) || rows.length === 0) {
        throw httpError(400, 'Provide a list of student rows to import.')
      }

      const day = todayIso()
      const studentOps = []
      const dailyOps = []
      const errors = []
      let successCount = 0

      for (const row of rows) {
        const rollNo = row.rollNo ? String(row.rollNo).trim().toUpperCase() : ''
        const name = row.name ? String(row.name).trim() : ''
        let grade = row.grade ? String(row.grade).trim().toUpperCase() : ''
        let section = row.section ? String(row.section).trim().toUpperCase() : ''
        const busRoute = row.busRoute ? String(row.busRoute).trim().toUpperCase() : null

        if (!rollNo || !name) {
          errors.push({ rollNo: rollNo || 'N/A', error: 'Roll number and name are required.' })
          continue
        }

        if (!grade) {
          if (section.startsWith('11')) {
            grade = 'PU1'
            section = section.slice(2)
          } else if (section.startsWith('12')) {
            grade = 'PU2'
            section = section.slice(2)
          } else if (rollNo.startsWith('25') || rollNo.startsWith('24')) {
            grade = 'PU2'
          } else {
            grade = 'PU1'
          }
        }

        if (!section) section = 'A'

        studentOps.push({
          updateOne: {
            filter: { rollNo },
            update: {
              $set: {
                name,
                grade,
                section,
                busRoute,
              },
            },
            upsert: true,
          },
        })

        dailyOps.push({
          updateOne: {
            filter: { date: day, rollNo },
            update: {
              $set: {
                name,
                grade,
                section,
                busRoute,
              },
              $setOnInsert: {
                date: day,
                rollNo,
                attendance: 'present',
                busLate: false,
                rider: true,
              },
            },
            upsert: true,
          },
        })
        successCount += 1
      }

      if (studentOps.length > 0) {
        await Student.bulkWrite(studentOps, { ordered: false })
        await DailyRecord.bulkWrite(dailyOps, { ordered: false })
        // A route in this upload must appear on the transport log the same day.
        await syncRouteLogs(
          day,
          rows.map((row) => (row.busRoute ? String(row.busRoute).trim().toUpperCase() : null))
        )
        await writeAudit(AuditLog, 'Bulk roster import', `${successCount} students imported/updated from Excel/sheet`)
      }

      res.json({ ok: true, count: successCount, total: rows.length, errors })
    })
  )

  router.put(
    '/students/:rollNo',
    api(async (req, res) => {
      const rollNo = String(req.params.rollNo).trim().toUpperCase()
      const { name, grade, section, busRoute } = req.body || {}

      const student = await Student.findOne({ rollNo })
      if (!student) throw httpError(404, `Student with roll number "${rollNo}" not found.`)

      if (name) student.name = String(name).trim()
      if (grade) student.grade = grade === 'PU2' ? 'PU2' : 'PU1'
      if (section) student.section = String(section).trim().toUpperCase()
      if (busRoute !== undefined) student.busRoute = busRoute ? String(busRoute).trim().toUpperCase() : null

      await student.save()

      await DailyRecord.updateMany(
        { rollNo },
        {
          $set: {
            name: student.name,
            grade: student.grade,
            section: student.section,
            busRoute: student.busRoute,
          },
        }
      )
      await syncRouteLogs(todayIso(), [student.busRoute])

      await writeAudit(AuditLog, 'Student updated', `${rollNo}: ${student.name}`)
      res.json({ ok: true, student })
    })
  )

  router.post(
    '/messages',
    api(async (req, res) => {
      const { type, scope, sections = [], date, title, body } = req.body || {}

      if (!MESSAGE_TYPES[type]) throw httpError(400, 'Choose a message type.')

      const subject = String(title || '').trim() || MESSAGE_TYPES[type]
      const text = String(body || '').trim()
      if (subject.length > 120) throw httpError(400, 'Keep the subject under 120 characters.')
      if (text.length < 3) throw httpError(400, 'Write the message you want to send.')
      if (text.length > 1000) throw httpError(400, 'Keep the message under 1000 characters.')

      let targets = []
      let targetLabel = 'Whole School'

      if (scope === 'ALL') {
        targets = await allSections({ Student })
      } else if (scope === 'PU1' || scope === 'PU2') {
        targets = (await allSections({ Student })).filter((row) => row.grade === scope)
        targetLabel = scope
      } else if (scope === 'SECTIONS') {
        if (!Array.isArray(sections) || sections.length === 0) {
          throw httpError(400, 'Pick at least one section.')
        }
        const known = await allSections({ Student })
        // Section letters repeat across grades (11A and 12A both use "A"),
        // so targets are keyed by grade + section.
        const wanted = new Set(
          sections.map((entry) => `${entry.grade}:${entry.section}`)
        )
        targets = known.filter((row) => wanted.has(`${row.grade}:${row.section}`))
        if (targets.length === 0) throw httpError(400, 'Pick at least one section.')
        targetLabel = `Sections: ${targets.map((row) => `${row.grade === 'PU1' ? '11' : '12'}${row.section}`).join(', ')}`
      } else {
        throw httpError(400, 'Choose a target audience.')
      }

      const day = date || todayIso()
      const sentAt = istClock()

      const shared = {
        date: day,
        title: subject,
        type,
        target: targetLabel,
        sender: 'Admin / Coordinator',
        sentBy: req.user?.email || null,
        batchId: randomUUID(),
        body: text,
        sentAt,
      }

      // The same broadcast lands in the class leader inbox and on the class
      // teacher dashboard, so nobody has to forward it by hand.
      const leaderDocs = targets.map((row) => ({
        ...shared,
        grade: row.grade,
        section: row.section,
        acknowledgedAt: null,
      }))
      const teacherDocs = targets.map((row) => ({
        ...shared,
        grade: row.grade,
        section: row.section,
        readAt: null,
      }))

      // Transport and gate only receive, so the same broadcast lands in their
      // inboxes as one row each.
      const deskDocs = ['TRANSPORT', 'GATE'].map((toRole) => ({
        date: day,
        title: subject,
        body: text,
        fromRole: 'admin',
        fromName: shared.sender,
        fromEmail: shared.sentBy,
        fromContext: 'Admin / Coordinator',
        toRole,
        grade: null,
        section: null,
        sentAt,
        readAt: null,
      }))

      await Promise.all([
        LeaderMessage.insertMany(leaderDocs, { ordered: false }),
        TeacherNotice.insertMany(teacherDocs, { ordered: false }),
        InboxMessage.insertMany(deskDocs, { ordered: false }),
      ])

      await writeAudit(
        AuditLog,
        'Message sent',
        `${subject} (${MESSAGE_TYPES[type]}) → ${targetLabel} (${leaderDocs.length} section(s), leaders + teachers)`
      )
      res.status(201).json({
        date: day,
        sent: leaderDocs.length,
        teachers: teacherDocs.length,
        target: targetLabel,
        type,
        title: subject,
      })
    })
  )

  // Outbox for the signed-in admin: last five broadcasts by default, or a
  // title / day lookup when the admin is looking for a particular message.
  router.get(
    '/messages/sent',
    api(async (req, res) => {
      const account = String(req.user?.email || '').trim()
      const titleQuery = String(req.query.q || '').trim()
      const day = String(req.query.date || '').trim()
      const sortOldest = String(req.query.sort || '').toLowerCase() === 'oldest'
      const lookingUp = Boolean(titleQuery || day || sortOldest)

      const filter = account
        ? { $or: [{ sentBy: account }, { sentBy: null }, { sentBy: { $exists: false } }] }
        : {}
      if (day) filter.date = day
      if (titleQuery) filter.title = { $regex: escapeRegex(titleQuery), $options: 'i' }

      const docs = await LeaderMessage.find(filter)
        .sort({ createdAt: sortOldest ? 1 : -1 })
        .limit(lookingUp ? 2000 : 400)
        .lean()

      const groups = new Map()
      for (const doc of docs) {
        // Broadcasts created before batch ids fall back to a stable composite
        // key so their per-section rows still appear as one message.
        const key =
          doc.batchId ||
          `${doc.date}|${doc.sentAt}|${doc.title}|${doc.target}|${doc.sender || 'Admin / Coordinator'}`
        let group = groups.get(key)
        if (!group) {
          group = {
            id: key,
            batchId: doc.batchId || null,
            title: doc.title,
            body: doc.body || '',
            type: doc.type,
            typeLabel: MESSAGE_TYPES[doc.type] || doc.type,
            target: doc.target,
            sender: doc.sender || 'Admin / Coordinator',
            sentBy: doc.sentBy || null,
            date: doc.date,
            sentAt: doc.sentAt,
            sentAtIst: istClock(doc.createdAt),
            createdAt: doc.createdAt,
            sections: [],
            recipients: [],
            seen: 0,
            acknowledged: 0,
            read: 0,
            teacherRead: 0,
            teacherTotal: 0,
          }
          groups.set(key, group)
        }

        const label = `${doc.grade === 'PU1' ? '11' : '12'}${doc.section}`
        group.sections.push(label)
        // Per-section detail so the admin can open one message and see who was
        // reached and who has read it.
        group.recipients.push({
          label,
          grade: doc.grade,
          section: doc.section,
          seenAt: doc.seenAt || null,
          readAt: doc.seenAt || doc.acknowledgedAt || null,
          readBy: doc.seenBy || doc.acknowledgedBy || null,
          teacherReadAt: null,
          teacherReadBy: null,
        })
        if (doc.seenAt) group.seen += 1
        if (doc.acknowledgedAt) group.acknowledged += 1
        if (doc.seenAt || doc.acknowledgedAt) group.read += 1
      }

      // Class teacher read state lives on the matching notice row. Newer
      // broadcasts link by batch id; older rows fall back to the same
      // composite key used to group them.
      const noticeDays = [...new Set([...groups.values()].map((group) => group.date).filter(Boolean))]
      if (noticeDays.length > 0) {
        const notices = await TeacherNotice.find({ date: { $in: noticeDays } }).lean()
        for (const notice of notices) {
          const key =
            notice.batchId ||
            `${notice.date}|${notice.sentAt}|${notice.title}|${notice.target}|${
              notice.sender || 'Admin / Coordinator'
            }`
          const group = groups.get(key)
          if (!group) continue
          group.teacherTotal += 1
          if (notice.readAt) group.teacherRead += 1
          const recipient = group.recipients.find(
            (row) => row.grade === notice.grade && row.section === notice.section
          )
          if (recipient) {
            recipient.teacherReadAt = notice.readAt || null
            recipient.teacherReadBy = notice.readBy || null
          }
        }
      }

      const stamp = (group) => `${group.date || ''}T${group.sentAt || '00:00'}`
      const newestFirst = [...groups.values()]
        .map((group) => ({
          ...group,
          sectionCount: group.sections.length,
          sectionsLabel: [...group.sections].sort().join(', '),
          recipients: [...group.recipients].sort((a, b) => a.label.localeCompare(b.label)),
        }))
        .sort((a, b) => stamp(b).localeCompare(stamp(a)))

      const DEFAULT_VISIBLE = 5
      const pool = lookingUp ? newestFirst.slice(0, 200) : newestFirst.slice(0, DEFAULT_VISIBLE)
      const messages = sortOldest ? [...pool].reverse() : pool

      res.json({
        account: account || null,
        total: newestFirst.length,
        shown: messages.length,
        limited: !lookingUp,
        messages,
      })
    })
  )

  // ---- shared inbox -------------------------------------------------------

  const inboxRow = (doc) => ({
    id: String(doc._id),
    kind: 'inbox',
    title: doc.title,
    body: doc.body || '',
    fromName: doc.fromName || 'Daily Check',
    fromRole: doc.fromRole || 'admin',
    fromContext: doc.fromContext || null,
    sentAt: doc.sentAt,
    sentAtIst: istClock(doc.createdAt),
    readAt: doc.readAt || null,
    readBy: doc.readBy || null,
    at: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  })

  const inboxRoleFor = (role) =>
    role === 'teacher'
      ? 'TEACHER'
      : role === 'leader'
        ? 'LEADER'
        : role === 'transport'
          ? 'TRANSPORT'
          : role === 'gate'
            ? 'GATE'
            : role === 'superadmin'
              ? 'SUPERADMIN'
              : 'ADMIN'

  const senderContext = (user) =>
    user.role === 'teacher' || user.role === 'leader'
      ? `${classLabelOf(user.grade, user.section)} · ${INBOX_ROLE_LABEL[user.role]}`
      : INBOX_ROLE_LABEL[user.role] || 'Daily Check'

  // Every dashboard reads its own slice here: the role comes from the signed
  // session, never from the query string.
  router.get(
    '/messages/inbox',
    api(async (req, res) => {
      const user = req.user || {}
      const role = user.role || 'admin'
      // No date means the whole history: the chat keeps every thread, like a
      // messaging app, instead of only the selected day's rows.
      const date = req.query.date ? String(req.query.date) : null
      const scope = date ? { date } : {}
      const wanted = inboxRoleFor(role)

      const direct = await InboxMessage.find({
        ...scope,
        toRole: { $in: [wanted, 'ALL'] },
      })
        .sort({ createdAt: -1 })
        .lean()

      // A teacher only sees section-scoped rows for their own section; shared
      // broadcast rows carry no section and reach everyone.
      const visible = direct.filter(
        (doc) =>
          role !== 'teacher' ||
          !doc.grade ||
          (doc.grade === user.grade && doc.section === user.section)
      )

      // A chat shows both sides of today's conversation: what arrived and what
      // this role sent. Sending is never counted as unread for the sender.
      const sent = await InboxMessage.find({ ...scope, fromRole: role }).lean()
      const byId = new Map(visible.map((doc) => [String(doc._id), doc]))
      for (const doc of sent) if (!byId.has(String(doc._id))) byId.set(String(doc._id), doc)

      let unread = visible.filter((doc) => !doc.readAt && doc.fromRole !== role).length
      let items = [...byId.values()].map((doc) => ({
        ...inboxRow(doc),
        mine: doc.fromRole === role,
        toRole: doc.toRole,
      }))

      // The teacher inbox also carries the admin broadcasts and the leader's
      // notes, so one screen shows everything addressed to the class teacher.
      if (role === 'teacher') {
        const [notices, notes] = await Promise.all([
          TeacherNotice.find({ ...scope, grade: user.grade, section: user.section }).lean(),
          LeaderNote.find({ ...scope, grade: user.grade, section: user.section }).lean(),
        ])

        unread += notices.filter((notice) => !notice.readAt).length
        unread += notes.filter((note) => !note.readAt).length

        items = [
          ...items,
          ...notices.map((notice) => ({
            id: String(notice._id),
            kind: 'notice',
            title: notice.title,
            body: notice.body,
            fromName: notice.sender || 'Admin / Coordinator',
            fromRole: 'admin',
            fromContext: 'Admin / Coordinator',
            sentAt: notice.sentAt,
            sentAtIst: istClock(notice.createdAt),
            readAt: notice.readAt || null,
            readBy: notice.readBy || null,
            at: notice.createdAt ? new Date(notice.createdAt).toISOString() : null,
          })),
          ...notes.map((note) => ({
            id: String(note._id),
            kind: 'note',
            title: 'Note from the class leader',
            body: note.body,
            fromName: note.author,
            fromRole: 'leader',
            toRole: 'TEACHER',
            fromContext: classLabelOf(user.grade, user.section),
            sentAt: note.sentAt,
            sentAtIst: istClock(note.createdAt),
            readAt: note.readAt || null,
            readBy: note.readBy || null,
            at: note.createdAt ? new Date(note.createdAt).toISOString() : null,
            mine: false,
          })),
        ]

        // The teacher's own messages to the class leader live on the leader
        // message row, so they are added back as outgoing bubbles.
        const teacherSends = await LeaderMessage.find({
          ...scope,
          grade: user.grade,
          section: user.section,
          sentBy: user.email,
        }).lean()
        items = [
          ...items,
          ...teacherSends.map((message) => ({
            id: String(message._id),
            kind: 'leader',
            title: message.title,
            body: message.body || message.title,
            fromName: message.sender || user.name || 'Class Teacher',
            fromRole: 'teacher',
            toRole: 'LEADER',
            fromContext: classLabelOf(user.grade, user.section),
            sentAt: message.sentAt,
            sentAtIst: istClock(message.createdAt),
            readAt: message.seenAt || message.acknowledgedAt || null,
            readBy: message.seenBy || message.acknowledgedBy || null,
            at: message.createdAt ? new Date(message.createdAt).toISOString() : null,
            mine: true,
          })),
        ]
      }

      // A class leader's chat is the section's leader messages (admin
      // broadcasts and teacher updates) plus anything the leader sent back.
      if (role === 'leader') {
        const [leaderDocs, sectionDoc] = await Promise.all([
          LeaderMessage.find({
            ...scope,
            grade: user.grade,
            section: user.section,
          }).lean(),
          Section.findOne({ grade: user.grade, section: user.section })
            .select('teacher')
            .lean(),
        ])
        const classTeacher = sectionDoc?.teacher || null
        items = [
          ...items,
          ...leaderDocs.map((message) => {
            // Older rows predate fromRole, so the section's class teacher is
            // used as the second signal for who sent the message.
            const fromTeacher =
              message.fromRole === 'teacher' ||
              (Boolean(message.sender) && message.sender === classTeacher)
            return {
              id: String(message._id),
              kind: 'leader',
              title: message.title,
              body: message.body || message.title,
              fromName: message.sender || 'Admin / Coordinator',
              fromRole: fromTeacher ? 'teacher' : 'admin',
              toRole: null,
              fromContext: fromTeacher
                ? message.sender
                : message.sender || 'Admin / Coordinator',
              sentAt: message.sentAt,
              sentAtIst: istClock(message.createdAt),
              readAt: message.seenAt || message.acknowledgedAt || null,
              readBy: message.seenBy || message.acknowledgedBy || null,
              at: message.createdAt ? new Date(message.createdAt).toISOString() : null,
              mine: false,
            }
          }),
        ]
        unread += leaderDocs.filter((message) => !message.seenAt && !message.acknowledgedAt).length
      }

      items.sort((a, b) =>
        String(b.at || b.sentAt).localeCompare(String(a.at || a.sentAt))
      )

      res.json({ date, role, unread, messages: items })
    })
  )

  // Opening one message marks that single row read. `kind` says which store
  // the row came from; the role is always taken from the session.
  router.post(
    '/messages/inbox/:id/read',
    api(async (req, res) => {
      const user = req.user || {}
      const role = user.role || 'admin'
      const id = req.params.id
      const kind = String(req.body?.kind || 'inbox').toLowerCase()
      if (!/^[0-9a-f]{24}$/i.test(id)) throw httpError(400, 'Unknown message.')

      const readAt = istClock()
      const readBy = user.name || INBOX_ROLE_LABEL[role] || 'Daily Check'

      if (kind === 'inbox') {
        const doc = await InboxMessage.findOne({
          _id: id,
          toRole: { $in: [inboxRoleFor(role), 'ALL'] },
        })
        const otherSection =
          doc?.grade &&
          role === 'teacher' &&
          (doc.grade !== user.grade || doc.section !== user.section)
        if (!doc || otherSection) throw httpError(404, 'That message is not in your inbox.')
        if (!doc.readAt) {
          doc.readAt = readAt
          doc.readBy = readBy
          await doc.save()
        }
        res.json({ ok: true, kind, readAt: doc.readAt, readBy: doc.readBy })
        return
      }

      if (kind === 'notice' || kind === 'note') {
        if (role !== 'teacher') {
          throw httpError(403, 'Only the class teacher can read that message.')
        }
        const Model = kind === 'notice' ? TeacherNotice : LeaderNote
        const doc = await Model.findOne({ _id: id, grade: user.grade, section: user.section })
        if (!doc) throw httpError(404, 'That message is not in your inbox.')
        if (!doc.readAt) {
          doc.readAt = readAt
          doc.readBy = await teacherOf(user.grade, user.section)
          await doc.save()
        }
        res.json({ ok: true, kind, readAt: doc.readAt, readBy: doc.readBy })
        return
      }

      if (kind === 'leader') {
        if (role !== 'leader') {
          throw httpError(403, 'Only the class leader can read that message.')
        }
        const doc = await LeaderMessage.findOne({
          _id: id,
          grade: user.grade,
          section: user.section,
        })
        if (!doc) throw httpError(404, 'That message is not in your inbox.')
        if (!doc.seenAt) {
          doc.seenAt = istClockSeconds()
          doc.seenBy = user.name || 'Class Leader'
          await doc.save()
        }
        res.json({
          ok: true,
          kind,
          readAt: doc.seenAt || doc.acknowledgedAt || null,
          readBy: doc.seenBy || doc.acknowledgedBy || null,
        })
        return
      }

      throw httpError(400, 'Unknown message.')
    })
  )

  router.post(
    '/messages/inbox',
    api(async (req, res) => {
      const user = req.user || {}
      const role = user.role || 'admin'
      const allowed = INBOX_TARGETS[role] || ['ADMIN']
      const to = String(req.body?.to || '').trim().toUpperCase()
      if (!allowed.includes(to)) throw httpError(400, 'Choose who should receive this message.')

      const body = String(req.body?.body || '').trim()
      // Body can be formatted, so check the visible text, not the markup.
      const plainBody = body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim()
      if (body.length < 3 || plainBody.length < 3) {
        throw httpError(400, 'Write the message you want to send.')
      }
      if (body.length > 1000) throw httpError(400, 'Keep the message under 1000 characters.')

      const fromName = user.name || INBOX_ROLE_LABEL[role] || 'Daily Check'
      const title = (
        String(req.body?.title || '').trim() || `Message from ${fromName}`
      ).slice(0, 120)
      const day = req.body?.date || todayIso()
      const sentAt = istClock()
      const context = senderContext(user)
      const targets =
        to === 'ALL'
          ? ['ADMIN', 'SUPERADMIN', 'TEACHER', 'LEADER', 'TRANSPORT', 'GATE']
          : [to]

      let delivered = 0

      // A class teacher messaging the leader writes the same row the leader
      // inbox reads, so the daily-check message block is satisfied too. An
      // admin or super admin has no single section, so their message reaches
      // every leader through the shared inbox row below instead.
      if (to === 'LEADER' && role === 'teacher') {
        await LeaderMessage.create({
          date: day,
          grade: user.grade,
          section: user.section,
          title,
          type: 'update',
          target: 'Class Leader',
          fromRole: role === 'teacher' ? 'teacher' : 'admin',
          sender: fromName,
          sentBy: user.email || null,
          body,
          sentAt,
          acknowledgedAt: null,
        })
        delivered += 1
      }

      const docs = targets
        .filter((target) =>
          to === 'LEADER' && role === 'teacher' ? target !== 'LEADER' : true
        )
        .map((toRole) => ({
          date: day,
          title,
          body,
          fromRole: role,
          fromName,
          fromEmail: user.email || null,
          fromContext: context,
          toRole,
          grade: ['TEACHER', 'LEADER'].includes(toRole) ? user.grade : null,
          section: ['TEACHER', 'LEADER'].includes(toRole) ? user.section : null,
          sentAt,
          readAt: null,
        }))

      if (docs.length > 0) {
        await InboxMessage.insertMany(docs)
        delivered += docs.length
      }

      await writeAudit(AuditLog, 'Message sent', `${title} → ${to} (${delivered} inbox)`)
      res.status(201).json({ ok: true, sent: delivered, target: to, sentAt })
    })
  )

  // Section-wise teacher accountability table.
  router.get(
    '/sections',
    api(async (req, res) => {
      await ensureToday()
      const match = scope(req.query, todayIso())
      const date = match.date
      const isToday = date === todayIso()
      const clock = isToday ? clockNow() : 24 * 60

      const filter = {}
      if (match.grade) filter.grade = match.grade
      if (match.section) filter.section = match.section

      const [sections, entryDocs, groups, messages] = await Promise.all([
        Section.find(filter).sort({ grade: 1, section: 1 }).lean(),
        EntrySection.find({ date, ...filter }).lean(),
        DailyRecord.aggregate([
          { $match: { date } },
          {
            $group: {
              _id: {
                grade: '$grade',
                section: '$section',
                type: '$restrictionType',
                status: '$resolutionStatus',
              },
              count: { $sum: 1 },
            },
          },
        ]),
        LeaderMessage.find({ date, ...filter }).lean(),
      ])

      const counts = new Map()
      for (const group of groups) {
        const key = `${group._id.grade}:${group._id.section}`
        const bucket = counts.get(key) || { exit: {}, entry: {} }
        if (group._id.type === 'exit') bucket.exit[group._id.status] = group.count
        if (group._id.type === 'entry') bucket.entry[group._id.status] = group.count
        counts.set(key, bucket)
      }

      const entryBySection = new Map(
        entryDocs.map((doc) => [`${doc.grade}:${doc.section}`, doc])
      )

      const messagesBySection = new Map()
      for (const message of messages) {
        const key = `${message.grade}:${message.section}`
        const list = messagesBySection.get(key) || []
        list.push(message)
        messagesBySection.set(key, list)
      }

      const rows = sections.map((section) => {
        const key = `${section.grade}:${section.section}`
        const bucket = counts.get(key) || { exit: {}, entry: {} }
        const entryDoc = entryBySection.get(key)

        const exitPending = bucket.exit.pending || 0
        const exitAcknowledged = bucket.exit.acknowledged || 0
        const exitTotal = Object.values(bucket.exit).reduce((sum, value) => sum + value, 0)

        const entryPending = bucket.entry.pending || 0
        const entryTotal = Object.values(bucket.entry).reduce((sum, value) => sum + value, 0)
        let entryStatus = 'pending'
        if (entryDoc?.submittedAt) entryStatus = entryPending > 0 ? 'in-progress' : 'complete'

        const sectionMessages = messagesBySection.get(key) || []
        const readTimes = sectionMessages.map(
          (message) => message.seenAt || message.acknowledgedAt || null
        )
        const read = readTimes.filter(Boolean).length
        const overdue = sectionMessages.filter((message, index) => {
          const sent = toMinutes(message.sentAt)
          const readAt = toMinutes(readTimes[index])
          const slow = readAt !== null && readAt - sent > ACK_WINDOW_MINUTES
          return clock - sent > ACK_WINDOW_MINUTES && (readAt === null || slow)
        }).length

        const leaderAck =
          sectionMessages.length === 0
            ? 'no-messages'
            : read === sectionMessages.length
              ? 'yes'
              : read === 0
                ? 'no'
                : 'partial'

        const ncCount = entryDoc?.ncCount ?? null
        const updatedInNe = Boolean(entryDoc?.updatedInNe)

        return {
          grade: section.grade,
          section: section.section,
          label: `${section.grade === 'PU1' ? '11' : '12'}${section.section}`,
          teacher: section.teacher,
          exit: {
            total: exitTotal,
            pending: exitPending,
            acknowledged: exitAcknowledged,
            done: exitPending === 0,
          },
          entry: {
            status: entryStatus,
            submittedAt: entryDoc?.submittedAt || null,
            pending: entryPending,
            total: entryTotal,
          },
          nc: { count: ncCount, updatedInNe },
          leaderAck: { status: leaderAck, sent: sectionMessages.length, read, overdue },
          needsFollowUp:
            exitPending > 0 || entryStatus === 'pending' || ncCount === null || !updatedInNe,
        }
      })

      rows.sort((a, b) =>
        a.grade === b.grade
          ? a.section.localeCompare(b.section)
          : a.grade.localeCompare(b.grade)
      )

      res.json({ date, rows })
    })
  )

  // ---- class leader inbox ------------------------------------------------

  const clockSeconds = () => istClockSeconds()

  const leaderOf = async (grade, section) =>
    Student.findOne({ grade, section }).sort({ rollNo: 1 }).lean()

  router.get(
    '/inbox',
    api(async (req, res) => {
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const leader = await leaderOf(grade, section)

      // A message is marked read only when the leader opens it (see
      // POST /messages/inbox/:id/read), never just by listing the inbox.
      const messages = await LeaderMessage.find({ date, grade, section }).lean()

      const list = messages
        .map((message) => ({
          id: String(message._id),
          kind: 'leader',
          type: message.type,
          typeLabel: MESSAGE_TYPES[message.type] || message.type,
          title: message.title,
          sender: message.sender || 'Admin / Coordinator',
          body: message.body || message.title,
          students: (message.students || []).map((student) => student.name),
          exitTime: message.exitTime || null,
          sentAt: message.sentAt,
          sentAtIst: istClock(message.createdAt),
          status: message.seenAt || message.acknowledgedAt ? 'read' : 'unread',
          seenAt: message.seenAt || null,
          readAt: message.seenAt || message.acknowledgedAt || null,
          readBy: message.seenBy || message.acknowledgedBy || null,
        }))
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'unread' ? -1 : 1
          return (toMinutes(b.sentAt) || 0) - (toMinutes(a.sentAt) || 0)
        })

      res.json({
        date,
        grade,
        section,
        label: `${grade === 'PU1' ? '11' : '12'}${section}`,
        leader: leader ? { rollNo: leader.rollNo, name: leader.name } : null,
        counts: {
          unread: list.filter((message) => message.status === 'unread').length,
          read: list.filter((message) => message.status === 'read').length,
          total: list.length,
        },
        messages: list,
      })
    })
  )

  // ---- class leader workspace -------------------------------------------

  const leaderName = async (grade, section) => {
    const leader = await leaderOf(grade, section)
    return leader?.name || 'Class Leader'
  }

  const busTiming = (busRoutes, settings) => {
    const busByRoute = new Map(busRoutes.map((route) => [route.route, route]))
    const cutoff = toMinutes(settings.busCutoff) || toMinutes('08:20')
    return (record) => {
      const bus = busByRoute.get(record.busRoute)
      const arrival = toMinutes(bus?.arrivalTime)
      return {
        rollNo: record.rollNo,
        name: record.name,
        route: record.busRoute,
        arrivalTime: bus?.arrivalTime || null,
        minutesLate:
          arrival === null || arrival === undefined
            ? null
            : Math.max(0, arrival - cutoff),
      }
    }
  }

  const noteRow = (note) => ({
    id: String(note._id),
    kind: note.kind,
    body: note.body,
    author: note.author,
    sentAt: note.sentAt,
    sentAtIst: istClock(note.createdAt),
    readAt: note.readAt || null,
    readBy: note.readBy || null,
  })

  // One read gives the leader everything the overview and the detail pages
  // need, so the dashboard does not make five round trips.
  router.get(
    '/leader/today',
    api(async (req, res) => {
      await ensureToday()
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const settings = await loadSettings(Settings)

      const [records, entryDoc, messages, teacher, busRoutes, notes, leader] =
        await Promise.all([
          DailyRecord.find({ date, grade, section }).lean(),
          EntrySection.findOne({ date, grade, section }).lean(),
          LeaderMessage.find({ date, grade, section }).lean(),
          teacherOf(grade, section),
          BusLog.find({ date }).lean(),
          LeaderNote.find({ date, grade, section }).sort({ createdAt: 1 }).lean(),
          leaderOf(grade, section),
        ])

      const toLateBus = busTiming(busRoutes, settings)

      const attendance = { present: 0, late: 0, absent: 0 }
      for (const record of records) attendance[record.attendance] += 1

      // Derive lateness from the bus arrival against today's cut-off so every
      // dashboard agrees with transport, even after the cut-off is changed.
      const cutoffMin = toMinutes(settings.busCutoff)
      const lateRoutes = new Set(
        busRoutes
          .filter((bus) => {
            if (bus.overrideLate === true) return true
            if (bus.overrideLate === false) return false
            const arrival = toMinutes(bus.arrivalTime)
            return arrival !== null && arrival > cutoffMin
          })
          .map((bus) => bus.route)
      )

      const lateBuses = records
        .filter((record) => record.rider !== false && lateRoutes.has(record.busRoute))
        .map(toLateBus)
        .sort((a, b) => (b.minutesLate || 0) - (a.minutesLate || 0))

      const exit = records
        .filter((record) => record.restrictionType === 'exit')
        .map((record) => ({
          rollNo: record.rollNo,
          name: record.name,
          reason: record.restrictionReason,
          status: record.resolutionStatus,
          untilResolved: Boolean(record.restrictionUntilResolved),
          endDate: record.restrictionEndDate,
          acknowledgedBy: record.acknowledgedBy,
          acknowledgedAt: record.acknowledgedAt,
          note: record.resolutionNote,
        }))

      const entry = records
        .filter(
          (record) =>
            record.restrictionType === 'entry' && record.resolutionStatus === 'pending'
        )
        .map((record) => ({
          rollNo: record.rollNo,
          name: record.name,
          subjects: record.pendingSubjects?.length
            ? record.pendingSubjects
            : (record.restrictionReason || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
          handover: Boolean(record.handover),
          handoverAt: record.handoverAt,
        }))

      const exitOpen = exit.filter((row) => ['pending', 'acknowledged'].includes(row.status))
      const unread = messages.filter(
        (message) => !message.seenAt && !message.acknowledgedAt
      ).length
      // Only the class teacher's own message satisfies the daily-check block;
      // admin broadcasts also live in LeaderMessage and must not count.
      const fromTeacher = messages.filter((message) => message.sender === teacher)

      res.json({
        date,
        grade,
        section,
        label: `${grade === 'PU1' ? '11' : '12'}${section}`,
        teacher,
        leader: leader?.name || null,
        cutoff: settings.busCutoff,
        stats: {
          roster: records.length,
          present: attendance.present,
          late: attendance.late,
          absent: attendance.absent,
          busLate: lateBuses.length,
          exitOpen: exitOpen.length,
          exitTotal: exit.length,
          entryPending: entry.length,
          messages: messages.length,
          unread,
          teacherMessages: fromTeacher.length,
        },
        nc: {
          count: entryDoc?.ncCount ?? null,
          updatedInNe: Boolean(entryDoc?.updatedInNe),
        },
        check: { submittedAt: entryDoc?.submittedAt || null },
        lateBuses,
        exit,
        entry,
        notes: notes.map(noteRow),
      })
    })
  )

  // The full class list, with attendance that the leader can edit for today.
  router.get(
    '/leader/register',
    api(async (req, res) => {
      await ensureToday()
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()

      const records = await DailyRecord.find({ date, grade, section })
        .sort({ rollNo: 1 })
        .select(
          '-_id rollNo name attendance busRoute busLate rider ' +
            'restrictionType restrictionReason resolutionStatus handover'
        )
        .lean()

      res.json({
        date,
        grade,
        section,
        label: `${grade === 'PU1' ? '11' : '12'}${section}`,
        today: todayIso(),
        rows: records,
      })
    })
  )

  router.post(
    '/leader/attendance/:rollNo',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = todayIso()
      const status = req.body?.status
      if (!['present', 'late', 'absent'].includes(status)) {
        throw httpError(400, 'Attendance must be present, late or absent.')
      }

      const rollNo = String(req.params.rollNo).toUpperCase()
      const record = await DailyRecord.findOne({ date, grade, section, rollNo }).lean()
      if (!record) throw httpError(404, 'That student is not in today’s register.')

      await DailyRecord.updateOne(
        { date, grade, section, rollNo },
        { $set: { attendance: status } }
      )

      const leader = await leaderName(grade, section)
      await writeAudit(
        AuditLog,
        'Attendance marked',
        `${grade}/${section}: ${rollNo} ${status} by ${leader}`
      )

      res.json({ ok: true, date, rollNo, attendance: status })
    })
  )

  // A short class trend: attendance, bus lateness, exit restrictions and NC.
  router.get(
    '/leader/trend',
    api(async (req, res) => {
      const { grade, section } = needSection(req.query)
      const days = Math.min(Math.max(Number(req.query.days) || 7, 3), 14)
      // The trend ends on the selected date, so older windows stay reachable.
      const end = req.query.date || todayIso()
      const sinceDate = new Date(`${end}T12:00:00`)
      sinceDate.setDate(sinceDate.getDate() - (days * 2 + 2))
      const since = sinceDate.toLocaleDateString('en-CA')

      const groups = await DailyRecord.aggregate([
        { $match: { grade, section, date: { $gte: since, $lte: end } } },
        {
          $group: {
            _id: '$date',
            roster: { $sum: 1 },
            present: { $sum: { $cond: [{ $eq: ['$attendance', 'present'] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ['$attendance', 'late'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$attendance', 'absent'] }, 1, 0] } },
            busLate: { $sum: { $cond: ['$busLate', 1, 0] } },
            exit: { $sum: { $cond: [{ $eq: ['$restrictionType', 'exit'] }, 1, 0] } },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: days },
      ])

      const dates = groups.map((group) => group._id)
      const ncDocs = dates.length
        ? await EntrySection.find({ grade, section, date: { $in: dates } })
            .select('date ncCount updatedInNe')
            .lean()
        : []
      const ncByDate = new Map(ncDocs.map((doc) => [doc.date, doc]))

      const rows = groups
        .map((group) => ({
          date: group._id,
          roster: group.roster,
          present: group.present,
          late: group.late,
          absent: group.absent,
          busLate: group.busLate,
          exit: group.exit,
          nc: ncByDate.get(group._id)?.ncCount ?? null,
        }))
        .reverse()

      res.json({ grade, section, days, rows })
    })
  )

  router.get(
    '/leader/notes',
    api(async (req, res) => {
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const notes = await LeaderNote.find({ date, grade, section })
        .sort({ createdAt: 1 })
        .lean()
      res.json({ date, notes: notes.map(noteRow) })
    })
  )

  router.post(
    '/leader/notes',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const kind = ['attendance', 'exit', 'general'].includes(req.body?.kind)
        ? req.body.kind
        : 'general'
      const body = String(req.body?.body || '').trim()
      if (body.length < 3) throw httpError(400, 'Write a short note for the class teacher.')
      if (body.length > 600) throw httpError(400, 'Keep the note under 600 characters.')

      const author = await leaderName(grade, section)
      const now = new Date()
      const sentAt = `${String(now.getHours()).padStart(2, '0')}:${String(
        now.getMinutes()
      ).padStart(2, '0')}`

      const note = await LeaderNote.create({
        date,
        grade,
        section,
        author,
        kind,
        body,
        sentAt,
      })

      await writeAudit(
        AuditLog,
        'Leader note sent',
        `${grade}/${section}: ${author}: ${body.slice(0, 80)}`
      )

      res.json({ ok: true, note: noteRow(note) })
    })
  )

  // ---- class teacher -----------------------------------------------------

  const teacherOf = async (grade, section) => {
    const doc = await Section.findOne({ grade, section }).lean()
    return doc?.teacher || 'Class Teacher'
  }

  const needSection = (source) => {
    const grade = source?.grade
    const section = source?.section
    if (!grade || !section) throw httpError(400, 'Teacher section is missing.')
    return { grade, section }
  }

  const nowClock = () => istClock()

  const messageStatus = (message, clock) => {
    if (!message) return null
    if (message.seenAt || message.acknowledgedAt) return 'read'
    const sent = toMinutes(message.sentAt)
    if (clock - sent > ACK_WINDOW_MINUTES) return 'overdue'
    return 'sent'
  }

  router.get(
    '/teacher/today',
    api(async (req, res) => {
      await ensureToday()
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const settings = await loadSettings(Settings)

      // The "class leader message" block is the teacher's own message. Admin
      // broadcasts also land in LeaderMessage, so they must not be mistaken for
      // the teacher's message or satisfy the close check.
      const teacher = await teacherOf(grade, section)
      const [records, entryDoc, latestMessage, busRoutes, sectionNc] = await Promise.all([
        DailyRecord.find({ date, grade, section }).lean(),
        EntrySection.findOne({ date, grade, section }).lean(),
        LeaderMessage.findOne({ date, grade, section, sender: teacher })
          .sort({ sentAt: -1 })
          .lean(),
        BusLog.find({ date }).lean(),
        SectionNc ? SectionNc.findOne({ date, grade, section }).lean() : null,
      ])

      const busByRoute = new Map(busRoutes.map((route) => [route.route, route]))
      const cutoff = toMinutes(settings.busCutoff) || toMinutes('08:20')
      const cutoffMin = cutoff

      // Lateness follows the bus arrival against the 8:20 cut-off (or the
      // transport override), not a stored per-student flag.
      const lateRoutes = new Set(
        busRoutes
          .filter((bus) => {
            if (bus.overrideLate === true) return true
            if (bus.overrideLate === false) return false
            const arrival = toMinutes(bus.arrivalTime)
            return arrival !== null && arrival > cutoffMin
          })
          .map((bus) => bus.route)
      )

      const lateBuses = records
        .filter((record) => record.rider !== false && lateRoutes.has(record.busRoute))
        .map((record) => {
          const bus = busByRoute.get(record.busRoute)
          const arrival = toMinutes(bus?.arrivalTime)
          return {
            rollNo: record.rollNo,
            name: record.name,
            route: record.busRoute,
            arrivalTime: bus?.arrivalTime || null,
            minutesLate:
              arrival === null || arrival === undefined
                ? null
                : Math.max(0, arrival - cutoffMin),
          }
        })
        .sort((a, b) => (b.minutesLate || 0) - (a.minutesLate || 0))

      const exitRecords = records.filter((record) => record.restrictionType === 'exit')
      const repeat = await DailyRecord.aggregate([
        {
          $match: {
            rollNo: { $in: exitRecords.map((record) => record.rollNo) },
            restrictionType: 'exit',
            resolutionStatus: 'resolved',
          },
        },
        { $group: { _id: '$rollNo', count: { $sum: 1 } } },
      ])
      const repeatMap = new Map(repeat.map((row) => [row._id, row.count]))

      const exit = exitRecords.map((record) => ({
        rollNo: record.rollNo,
        name: record.name,
        reason: record.restrictionReason,
        status: record.resolutionStatus,
        repeatResolutions: repeatMap.get(record.rollNo) || 0,
        untilResolved: Boolean(record.restrictionUntilResolved),
        endDate: record.restrictionEndDate,
        note: record.resolutionNote,
        approver: record.excusedApprover,
        acknowledgedBy: record.acknowledgedBy,
        acknowledgedAt: record.acknowledgedAt,
        uploadAcknowledgedBy: record.uploadAcknowledgedBy || null,
        uploadAcknowledgedAt: record.uploadAcknowledgedAt || null,
      }))

      const entry = records
        .filter((record) => record.restrictionType === 'entry' && record.resolutionStatus === 'pending')
        .map((record) => ({
          rollNo: record.rollNo,
          name: record.name,
          subjects: record.pendingSubjects?.length
            ? record.pendingSubjects
            : (record.restrictionReason || '').split(',').map((item) => item.trim()).filter(Boolean),
          handover: Boolean(record.handover),
          handoverAt: record.handoverAt,
          note: record.resolutionNote,
          uploadAcknowledgedBy: record.uploadAcknowledgedBy || null,
          uploadAcknowledgedAt: record.uploadAcknowledgedAt || null,
        }))

      const attendance = records
        .map((record) => ({
          rollNo: record.rollNo,
          name: record.name,
          attendance: record.attendance,
          ncFlag: Boolean(record.ncFlag),
          ncCount: Number(record.ncCount) || (record.ncFlag ? 1 : 0),
          ncReason: record.ncReason || null,
        }))
        .sort((a, b) => a.rollNo.localeCompare(b.rollNo))

      const attendanceSummary = {
        present: attendance.filter((row) => row.attendance === 'present').length,
        absent: attendance.filter((row) => row.attendance === 'absent').length,
        late: attendance.filter((row) => row.attendance === 'late').length,
        nc: attendance.filter((row) => row.ncFlag).length,
      }

      const adminRows = records
        .filter((record) => record.restrictionType === 'exit' || record.restrictionType === 'entry')
        .map((record) => ({
          type: record.restrictionType,
          rollNo: record.rollNo,
          name: record.name,
          detail:
            record.restrictionType === 'exit'
              ? record.restrictionReason || 'Exit restriction'
              : record.pendingSubjects?.length
                ? record.pendingSubjects.join(', ')
                : record.restrictionReason || 'All subjects',
          status:
            record.restrictionType === 'entry' && record.handover
              ? 'handed over'
              : record.resolutionStatus,
          acknowledgedAt: record.uploadAcknowledgedAt || null,
          acknowledgedBy: record.uploadAcknowledgedBy || null,
        }))
        .sort((a, b) => a.rollNo.localeCompare(b.rollNo))

      const selectedNcRollNos = [
        ...new Set(
          (sectionNc?.students || [])
            .map((rollNo) => String(rollNo || '').trim().toUpperCase())
            .filter(Boolean)
        ),
      ]
      const selectedNcRoster = selectedNcRollNos.length
        ? await Student.find({ rollNo: { $in: selectedNcRollNos } }).select('rollNo name').lean()
        : []
      const recordsByRoll = new Map(records.map((record) => [record.rollNo, record]))
      const rosterByRoll = new Map(selectedNcRoster.map((student) => [student.rollNo, student]))
      const ncStudentMap = new Map(
        attendance.filter((row) => row.ncFlag).map((row) => [row.rollNo, row])
      )
      for (const rollNo of selectedNcRollNos) {
        const record = recordsByRoll.get(rollNo)
        const student = rosterByRoll.get(rollNo)
        const current = ncStudentMap.get(rollNo)
        ncStudentMap.set(rollNo, {
          rollNo,
          name: current?.name || record?.name || student?.name || rollNo,
          ncCount: Math.max(Number(current?.ncCount) || Number(record?.ncCount) || 0, 1),
          ncReason: current?.ncReason || record?.ncReason || 'Coordinator CC NC',
        })
      }
      const ncStudents = [...ncStudentMap.values()].sort((a, b) => a.rollNo.localeCompare(b.rollNo))

      const clock = clockNow()

      res.json({
        date,
        grade,
        section,
        label: `${grade === 'PU1' ? '11' : '12'}${section}`,
        teacher,
        cutoff: settings.busCutoff,
        lateBuses,
        exit,
        entry,
        nc: {
          count: entryDoc?.ncCount ?? null,
          updatedInNe: Boolean(entryDoc?.updatedInNe),
          students: ncStudents,
        },
        attendance: { rows: attendance, summary: attendanceSummary },
        adminData: {
          rows: adminRows,
          rowCount: adminRows.length,
          announcedAt: entryDoc?.adminAnnouncedAt || null,
          announcedBy: entryDoc?.adminAnnouncedBy || null,
          announcedCount: entryDoc?.adminAnnouncedCount || 0,
          acknowledgedAt: entryDoc?.adminAcknowledgedAt || null,
          acknowledgedBy: entryDoc?.adminAcknowledgedBy || null,
          acknowledgedCount: entryDoc?.adminAcknowledgedCount || 0,
        },
        check: { submittedAt: entryDoc?.submittedAt || null },
        message: latestMessage
          ? {
              title: latestMessage.title,
              type: latestMessage.type,
              sentAt: latestMessage.sentAt,
              sentAtIst: istClock(latestMessage.createdAt),
              seenAt: latestMessage.seenAt,
              acknowledgedAt: latestMessage.acknowledgedAt,
              status: messageStatus(latestMessage, clock),
            }
          : null,
      })
    })
  )

  // Notes the class leader sent up to this teacher.
  router.get(
    '/teacher/notes',
    api(async (req, res) => {
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const notes = await LeaderNote.find({ date, grade, section })
        .sort({ createdAt: 1 })
        .lean()
      res.json({
        date,
        unread: notes.filter((note) => !note.readAt).length,
        notes: notes.map(noteRow),
      })
    })
  )

  router.post(
    '/teacher/notes/:id/read',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw httpError(400, 'Unknown note.')

      const note = await LeaderNote.findOne({ _id: req.params.id, grade, section })
      if (!note) throw httpError(404, 'That note is not in this section.')
      if (!note.readAt) {
        note.readAt = nowClock()
        note.readBy = await teacherOf(grade, section)
        await note.save()
      }
      res.json({ ok: true, readAt: note.readAt, readBy: note.readBy })
    })
  )

  // Admin / coordinator broadcasts addressed to this section's class teacher.
  const noticeRow = (notice) => ({
    id: String(notice._id),
    title: notice.title,
    body: notice.body,
    type: notice.type,
    typeLabel: MESSAGE_TYPES[notice.type] || notice.type,
    target: notice.target,
    sender: notice.sender || 'Admin / Coordinator',
    sentAt: notice.sentAt,
    sentAtIst: istClock(notice.createdAt),
    readAt: notice.readAt || null,
    readBy: notice.readBy || null,
  })

  router.get(
    '/teacher/notices',
    api(async (req, res) => {
      const { grade, section } = needSection(req.query)
      const date = req.query.date || todayIso()
      const notices = await TeacherNotice.find({ date, grade, section })
        .sort({ createdAt: -1 })
        .lean()
      res.json({
        date,
        unread: notices.filter((notice) => !notice.readAt).length,
        notices: notices.map(noticeRow),
      })
    })
  )

  router.post(
    '/teacher/notices/:id/read',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw httpError(400, 'Unknown message.')

      const notice = await TeacherNotice.findOne({ _id: req.params.id, grade, section })
      if (!notice) throw httpError(404, 'That message is not addressed to this section.')
      if (!notice.readAt) {
        notice.readAt = nowClock()
        notice.readBy = await teacherOf(grade, section)
        await notice.save()
      }
      res.json({ ok: true, readAt: notice.readAt, readBy: notice.readBy })
    })
  )

  const findTeacherRecord = async (req, extra = {}) => {
    const { grade, section, date } = req.body || {}
    needSection(req.body || {})
    const day = date || todayIso()
    const rollNo = String(req.params.rollNo).toUpperCase()
    const record = await DailyRecord.findOne({ date: day, grade, section, rollNo, ...extra }).lean()
    if (!record) throw httpError(404, 'That student has no matching record for today.')
    return { record, day, rollNo, grade, section }
  }

  router.post(
    '/teacher/exit/:rollNo/acknowledge',
    api(async (req, res) => {
      const { record, day, rollNo, grade, section } = await findTeacherRecord(req, {
        restrictionType: 'exit',
      })
      if (record.resolutionStatus === 'resolved') {
        throw httpError(400, 'This exit restriction is already resolved for today.')
      }
      const teacher = await teacherOf(grade, section)
      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'exit' },
        {
          $set: {
            resolutionStatus: 'acknowledged',
            acknowledgedBy: teacher,
            acknowledgedAt: nowClock(),
          },
        }
      )
      await writeAudit(AuditLog, 'Exit acknowledged', `${rollNo} by ${teacher} (${section})`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/exit/:rollNo/absent',
    api(async (req, res) => {
      const { record, day, rollNo } = await findTeacherRecord(req, { restrictionType: 'exit' })
      if (record.resolutionStatus === 'resolved') {
        throw httpError(400, 'This exit restriction is already resolved for today.')
      }
      const reason = String(req.body?.reason || '').trim()
      if (!reason) throw httpError(400, 'Give a reason for marking the student absent.')

      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'exit' },
        { $set: { resolutionStatus: 'absent', resolutionNote: reason, resolvedOn: null } }
      )
      await writeAudit(AuditLog, 'Exit marked absent', `${rollNo}: ${reason}`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/exit/:rollNo/excuse',
    api(async (req, res) => {
      const { record, day, rollNo } = await findTeacherRecord(req, { restrictionType: 'exit' })
      if (record.resolutionStatus === 'resolved') {
        throw httpError(400, 'This exit restriction is already resolved for today.')
      }
      const approver = String(req.body?.approver || '').trim()
      if (!approver) throw httpError(400, 'Who approved the excuse?')

      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'exit' },
        {
          $set: {
            resolutionStatus: 'excused',
            excusedApprover: approver,
            restrictionEndDate: req.body?.endDate || null,
            resolutionNote: `Excused by ${approver}`,
            resolvedOn: null,
          },
        }
      )
      await writeAudit(AuditLog, 'Exit excused', `${rollNo}: ${approver}`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/exit/:rollNo/resolve',
    api(async (req, res) => {
      const { record, day, rollNo } = await findTeacherRecord(req, { restrictionType: 'exit' })
      if (record.resolutionStatus !== 'acknowledged') {
        throw httpError(400, 'Acknowledge the restriction before resolving it.')
      }
      const note = String(req.body?.note || '').trim()
      if (!note) throw httpError(400, 'A short resolution note is required.')

      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'exit' },
        { $set: { resolutionStatus: 'resolved', resolvedOn: day, resolutionNote: note } }
      )
      await writeAudit(AuditLog, 'Exit resolved', `${rollNo}: ${note}`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/entry/:rollNo/submitted',
    api(async (req, res) => {
      const { record, day, rollNo } = await findTeacherRecord(req, { restrictionType: 'entry' })
      if (record.resolutionStatus !== 'pending') {
        throw httpError(400, 'This entry restriction is already closed.')
      }

      const cleared = Array.isArray(req.body?.cleared) ? req.body.cleared : []
      const current = record.pendingSubjects?.length
        ? record.pendingSubjects
        : (record.restrictionReason || '').split(',').map((item) => item.trim()).filter(Boolean)
      const remaining = current.filter((subject) => !cleared.includes(subject))

      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'entry' },
        {
          $set: {
            pendingSubjects: remaining,
            restrictionReason: remaining.join(', ') || record.restrictionReason,
            resolutionStatus: remaining.length === 0 ? 'resolved' : 'pending',
            resolvedOn: remaining.length === 0 ? day : null,
            resolutionNote: remaining.length === 0 ? 'Submitted: all subjects cleared' : null,
          },
        }
      )
      await writeAudit(
        AuditLog,
        'Entry submitted',
        `${rollNo}: cleared ${cleared.join(', ') || 'none'}; ${remaining.length} subject(s) left`
      )
      res.json({ ok: true, remaining })
    })
  )

  router.post(
    '/teacher/entry/:rollNo/absent',
    api(async (req, res) => {
      const { day, rollNo } = await findTeacherRecord(req, { restrictionType: 'entry' })
      const note = String(req.body?.note || '').trim()
      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'entry' },
        {
          $set: {
            resolutionStatus: 'absent',
            resolutionNote: note || 'Student absent',
            resolvedOn: null,
          },
        }
      )
      await writeAudit(AuditLog, 'Entry marked absent', `${rollNo}${note ? `: ${note}` : ''}`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/entry/:rollNo/handover',
    api(async (req, res) => {
      const { day, rollNo } = await findTeacherRecord(req, { restrictionType: 'entry' })
      const note = String(req.body?.note || '').trim()
      await DailyRecord.updateOne(
        { date: day, rollNo, restrictionType: 'entry' },
        {
          $set: {
            handover: true,
            handoverAt: nowClock(),
            resolutionStatus: 'pending',
            resolutionNote: note || 'Handed over to administration',
          },
        }
      )
      await writeAudit(AuditLog, 'Handed over to admin', `${rollNo}${note ? `: ${note}` : ''}`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/nc',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const count = Number(req.body?.count)
      if (!Number.isFinite(count) || count < 0 || count > 999) {
        throw httpError(400, 'Enter an NC count between 0 and 999.')
      }

      await EntrySection.findOneAndUpdate(
        { date, grade, section },
        { $set: { ncCount: Math.round(count), updatedInNe: Boolean(req.body?.updatedInNe) } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      await writeAudit(AuditLog, 'NC updated', `${grade}/${section}: ${Math.round(count)} NC`)
      res.json({ ok: true })
    })
  )

  router.post(
    '/teacher/check/close',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const teacher = await teacherOf(grade, section)

      const [entryDoc, message] = await Promise.all([
        EntrySection.findOne({ date, grade, section }).lean(),
        LeaderMessage.findOne({ date, grade, section, sender: teacher }).lean(),
      ])

      if (entryDoc?.ncCount === null || entryDoc?.ncCount === undefined) {
        throw httpError(400, 'Enter the daily NC count before closing.')
      }
      if (!entryDoc?.updatedInNe) {
        throw httpError(400, 'Mark the NC count as updated in NE before closing.')
      }
      if (!message) {
        throw httpError(400, 'Send the class leader message before closing.')
      }

      const doc = await EntrySection.findOneAndUpdate(
        { date, grade, section },
        { $set: { submittedAt: nowClock() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      await writeAudit(AuditLog, 'Daily check closed', `${grade}/${section} at ${doc.submittedAt}`)
      res.json({ ok: true, submittedAt: doc.submittedAt })
    })
  )

  // ---- attendance, delayed-with-NC and the admin upload ------------------

  router.post(
    '/teacher/attendance/:rollNo',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const rollNo = String(req.params.rollNo).toUpperCase()
      const status = req.body?.status
      if (!['present', 'absent', 'late'].includes(status)) {
        throw httpError(400, 'Mark the student present, absent or late.')
      }

      await ensureToday()
      const record = await DailyRecord.findOne({ date, grade, section, rollNo }).lean()
      if (!record) throw httpError(404, 'That student is not in this section today.')

      const nc = Boolean(req.body?.nc)
      const ncReason = String(req.body?.ncReason || '').trim()
      if (nc && status !== 'late') {
        throw httpError(400, 'An NC can only be attached to a delayed arrival.')
      }
      if (nc && !ncReason) throw httpError(400, 'Give a short reason for the NC.')

      const rawNcCount = Number(req.body?.ncCount)
      const ncCount =
        nc && status === 'late'
          ? Number.isFinite(rawNcCount) && rawNcCount > 0
            ? Math.min(99, Math.round(rawNcCount))
            : 1
          : 0
      const withNc = ncCount > 0
      await DailyRecord.updateOne(
        { date, rollNo },
        {
          $set: {
            attendance: status,
            ncFlag: withNc,
            ncCount,
            ncReason: withNc ? ncReason : null,
            ncAt: withNc ? nowClock() : null,
          },
        }
      )

      const teacher = await teacherOf(grade, section)
      await writeAudit(
        AuditLog,
        'Attendance marked',
        `${rollNo} ${status}${withNc ? ` with ${ncCount} NC(s): ${ncReason}` : ''} by ${teacher} (${section})`
      )
      res.json({ ok: true, rollNo, attendance: status, ncFlag: withNc, ncCount })
    })
  )

  // Keep the teacher's upload count stable after an entry check is processed.
  const adminUploadRows = async (grade, section, date) =>
    DailyRecord.countDocuments({
      date,
      grade,
      section,
      restrictionType: { $in: ['exit', 'entry'] },
    })

  router.post(
    '/teacher/admin-data/announce',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const uploaded = await adminUploadRows(grade, section, date)
      if (uploaded === 0) {
        throw httpError(400, 'The admin has not uploaded anything for this section today.')
      }

      const teacher = await teacherOf(grade, section)
      const at = nowClock()
      await EntrySection.findOneAndUpdate(
        { date, grade, section },
        {
          $set: {
            adminAnnouncedAt: at,
            adminAnnouncedBy: teacher,
            adminAnnouncedCount: uploaded,
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      )
      await writeAudit(
        AuditLog,
        'Admin upload announced',
        `${grade}/${section}: ${uploaded} row(s) by ${teacher}`
      )
      res.json({ ok: true, announcedAt: at, announcedBy: teacher })
    })
  )

  router.post(
    '/teacher/admin-data/acknowledge',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const [doc, uploaded] = await Promise.all([
        EntrySection.findOne({ date, grade, section }).lean(),
        adminUploadRows(grade, section, date),
      ])
      if (uploaded === 0) {
        throw httpError(400, 'The admin has not uploaded anything for this section today.')
      }
      if (!doc?.adminAnnouncedAt || (doc.adminAnnouncedCount || 0) !== uploaded) {
        throw httpError(400, 'Announce the latest admin upload in class before acknowledging it.')
      }

      const teacher = await teacherOf(grade, section)
      const at = nowClock()
      await EntrySection.findOneAndUpdate(
        { date, grade, section },
        {
          $set: {
            adminAcknowledgedAt: at,
            adminAcknowledgedBy: teacher,
            adminAcknowledgedCount: uploaded,
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      )
      await writeAudit(AuditLog, 'Admin upload acknowledged', `${grade}/${section} by ${teacher}`)
      res.json({ ok: true, acknowledgedAt: at, acknowledgedBy: teacher })
    })
  )

  // One uploaded row ticked off by the class teacher, student by student.
  router.post(
    '/teacher/admin-data/row/acknowledge',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const date = req.body?.date || todayIso()
      const rollNo = String(req.body?.rollNo || '')
        .trim()
        .toUpperCase()
      const type = req.body?.type === 'entry' ? 'entry' : 'exit'
      if (!rollNo) throw httpError(400, 'Choose the student to acknowledge.')

      const record = await DailyRecord.findOne({
        date,
        grade,
        section,
        rollNo,
        restrictionType: type,
      })
      if (!record) throw httpError(404, 'That uploaded row is no longer on today’s list.')

      const teacher = await teacherOf(grade, section)
      record.uploadAcknowledgedAt = nowClock()
      record.uploadAcknowledgedBy = teacher
      await record.save()

      await writeAudit(
        AuditLog,
        'Admin row acknowledged',
        `${grade}/${section}: ${rollNo} (${type}) by ${teacher}`
      )
      res.json({
        ok: true,
        rollNo,
        acknowledgedAt: record.uploadAcknowledgedAt,
        acknowledgedBy: teacher,
      })
    })
  )

  router.post(
    '/teacher/message',
    api(async (req, res) => {
      const { grade, section } = needSection(req.body || {})
      const type = req.body?.type
      if (!['update', 'authorized-exit'].includes(type)) {
        throw httpError(400, 'Choose Update or Authorized Exit.')
      }

      const date = req.body?.date || todayIso()
      const message = await LeaderMessage.create({
        date,
        grade,
        section,
        title: MESSAGE_TYPES[type],
        type,
        target: 'Class Leader',
        fromRole: 'teacher',
        sender: await teacherOf(grade, section),
        body:
          type === 'authorized-exit'
            ? 'Authorized exit approval sent to the class leader. Collect the gate pass from the class teacher.'
            : 'Update from your class teacher.',
        sentAt: nowClock(),
        seenAt: null,
        acknowledgedAt: null,
      })
      await writeAudit(AuditLog, 'Class leader message', `${grade}/${section}: ${MESSAGE_TYPES[type]}`)
      res.status(201).json({ ok: true, sentAt: message.sentAt })
    })
  )

  // ---- transport in-charge -----------------------------------------------

  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

  const routeCutoffFor = (settings, route) =>
    settings.routeCutoffs?.[route] || settings.busCutoff || '08:20'

  // Students on a route absorb that route's late status, unless they were
  // unticked as absent riders.
  const applyRouteLate = async (date, route, late) => {
    await DailyRecord.updateMany(
      { date, busRoute: route, rider: { $ne: false } },
      { $set: { busLate: Boolean(late) } }
    )
  }

  const transportDay = async (date) => {
    const settings = await loadSettings(Settings)
    const [logs, records] = await Promise.all([
      BusLog.find({ date }).sort({ route: 1 }).lean(),
      DailyRecord.find({ date, busRoute: { $ne: null } })
        .select('rollNo name grade section busRoute busLate rider attendance')
        .lean(),
    ])

    const roster = new Map()
    for (const record of records) {
      if (!roster.has(record.busRoute)) roster.set(record.busRoute, [])
      roster.get(record.busRoute).push(record)
    }

    const routes = logs.map((log) => {
      const cutoff = routeCutoffFor(settings, log.route)
      const cutoffMin = toMinutes(cutoff)
      const arrivalMin = toMinutes(log.arrivalTime)
      const overridden = log.overrideLate === true || log.overrideLate === false
      const late = overridden ? log.overrideLate : arrivalMin !== null && arrivalMin > cutoffMin
      const status = overridden ? (late ? 'late' : 'on-time') : arrivalMin === null ? 'not-arrived' : late ? 'late' : 'on-time'

      const students = (roster.get(log.route) || [])
        .slice()
        .sort((a, b) => a.rollNo.localeCompare(b.rollNo))
        .map((student) => ({
          rollNo: student.rollNo,
          name: student.name,
          section: `${student.grade === 'PU1' ? '11' : '12'}${student.section}`,
          rider: student.rider !== false,
          // Late comes from the route arrival against the live cut-off, so a
          // student is never flagged from an outdated stored value.
          busLate: Boolean(late) && student.rider !== false,
        }))

      return {
        route: log.route,
        scheduledTime: log.scheduledTime || null,
        arrivalTime: log.arrivalTime || null,
        cutoff,
        status,
        late: Boolean(late),
        minutesLate: arrivalMin === null ? null : Math.max(0, arrivalMin - cutoffMin),
        override:
          overridden
            ? { late, reason: log.overrideReason, at: log.overrideAt }
            : null,
        students,
        riders: students.filter((student) => student.rider).length,
      }
    })
      .sort((a, b) => byRoute(a.route, b.route))

    return {
      date,
      cutoffs: { default: settings.busCutoff, overrides: settings.routeCutoffs || {} },
      summary: {
        notArrived: routes.filter((route) => route.status === 'not-arrived').length,
        onTime: routes.filter((route) => route.status === 'on-time').length,
        late: routes.filter((route) => route.status === 'late').length,
      },
      routes,
    }
  }

  router.get(
    '/transport/today',
    api(async (req, res) => {
      await ensureToday()
      res.json(await transportDay(req.query.date || todayIso()))
    })
  )

  // A bus route changed on the admin desk has to reach the transport log and
  // the day's rows straight away, or the new route has no arrival row and the
  // teacher, leader and gate screens never show those students as late.
  const syncRouteLogs = async (day, routes) => {
    const wanted = [...new Set((routes || []).filter(Boolean).map((route) => String(route).toUpperCase()))]
    if (wanted.length === 0) return

    const existing = await BusLog.find({ date: day, route: { $in: wanted } }).lean()
    const logged = new Set(existing.map((log) => log.route))
    const missing = wanted.filter((route) => !logged.has(route))
    if (missing.length) {
      await BusLog.bulkWrite(
        missing.map((route) => ({
          updateOne: {
            filter: { date: day, route },
            update: {
              $setOnInsert: {
                date: day,
                route,
                arrivalTime: null,
                late: false,
                affectedStudents: 0,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      )
    }

    const settings = await loadSettings(Settings)
    const cutoff = toMinutes(settings.busCutoff) || toMinutes('08:20')
    const logs = await BusLog.find({ date: day, route: { $in: wanted } }).lean()
    await Promise.all(
      logs.map((log) => {
        const late =
          typeof log.overrideLate === 'boolean'
            ? log.overrideLate
            : Boolean(log.arrivalTime && toMinutes(log.arrivalTime) > cutoff)
        return DailyRecord.updateMany(
          { date: day, busRoute: log.route, rider: { $ne: false } },
          { $set: { busLate: late } }
        )
      })
    )
  }

  const logArrival = async (route, date, time) => {
    const settings = await loadSettings(Settings)
    const cutoff = routeCutoffFor(settings, route)
    const late = toMinutes(time) > toMinutes(cutoff)

    const log = await BusLog.findOneAndUpdate(
      { date, route },
      { $set: { arrivalTime: time, late, markedAt: nowClock() } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    await applyRouteLate(date, route, late)
    return { log, late, cutoff }
  }

  router.post(
    '/transport/routes/:route/arrive',
    api(async (req, res) => {
      const route = String(req.params.route).toUpperCase()
      const date = req.body?.date || todayIso()
      const time = req.body?.time || nowClock()
      if (!TIME_PATTERN.test(time)) throw httpError(400, 'Use a time like 09:05.')

      const { late, cutoff } = await logArrival(route, date, time)
      await writeAudit(AuditLog, 'Bus arrival logged', `${route} at ${time}: ${late ? 'late' : 'on time'} (cut-off ${cutoff})`)
      res.json({ ok: true, arrivalTime: time, late, cutoff })
    })
  )

  router.post(
    '/transport/routes/:route/time',
    api(async (req, res) => {
      const route = String(req.params.route).toUpperCase()
      const date = req.body?.date || todayIso()
      const time = String(req.body?.time || '')
      if (!TIME_PATTERN.test(time)) throw httpError(400, 'Use a time like 09:05.')

      const existing = await BusLog.findOne({ date, route }).lean()
      if (!existing?.arrivalTime) {
        throw httpError(400, 'Log the arrival first, then edit the time.')
      }

      const { late } = await logArrival(route, date, time)
      await writeAudit(AuditLog, 'Arrival time edited', `${route} ${existing.arrivalTime} → ${time}`)
      res.json({ ok: true, arrivalTime: time, late })
    })
  )

  router.post(
    '/transport/routes/:route/override',
    api(async (req, res) => {
      const route = String(req.params.route).toUpperCase()
      const date = req.body?.date || todayIso()
      const reason = String(req.body?.reason || '').trim()
      if (!reason) throw httpError(400, 'A reason is required for a manual status override.')
      if (typeof req.body?.late !== 'boolean') throw httpError(400, 'Choose Late or On time.')

      const late = req.body.late
      await BusLog.findOneAndUpdate(
        { date, route },
        { $set: { overrideLate: late, overrideReason: reason, overrideAt: nowClock() } },
        { upsert: true, setDefaultsOnInsert: true }
      )
      await applyRouteLate(date, route, late)
      await writeAudit(
        AuditLog,
        'Route status overridden',
        `${route} → ${late ? 'Late' : 'On time'}: ${reason}`
      )
      res.json({ ok: true, late })
    })
  )

  router.post(
    '/transport/routes/:route/students/:rollNo',
    api(async (req, res) => {
      const route = String(req.params.route).toUpperCase()
      const rollNo = String(req.params.rollNo).toUpperCase()
      const date = req.body?.date || todayIso()
      const riding = Boolean(req.body?.riding)

      const record = await DailyRecord.findOne({ date, rollNo, busRoute: route })
      if (!record) throw httpError(404, 'That student is not on this route today.')

      const log = await BusLog.findOne({ date, route }).lean()
      // A manual override wins over the computed lateness.
      const effectiveLate =
        log?.overrideLate === true || log?.overrideLate === false
          ? log.overrideLate
          : Boolean(log?.late)

      record.rider = riding
      record.busLate = riding ? effectiveLate : false
      await record.save()

      res.json({ ok: true, rider: record.rider, busLate: record.busLate })
    })
  )

  // ---- module tabs -------------------------------------------------------

  router.get(
    '/handovers',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()
      const rows = await DailyRecord.find({ date, handover: true })
        .sort({ handoverAt: 1, rollNo: 1 })
        .select('-_id rollNo name grade section restrictionReason handoverAt handoverOutcome resolutionStatus')
        .lean()
      res.json({ date, nowMinutes: clockNow(), rows })
    })
  )

  router.post(
    '/handovers/:rollNo/outcome',
    api(async (req, res) => {
      const { outcome, date } = req.body || {}
      const chosen = HANDOVER_OUTCOMES[outcome]
      if (!chosen) throw httpError(400, 'Unknown outcome.')

      const day = date || todayIso()
      const rollNo = String(req.params.rollNo).toUpperCase()
      const record = await DailyRecord.findOneAndUpdate(
        { date: day, rollNo },
        {
          $set: {
            handover: false,
            handoverOutcome: outcome,
            resolutionStatus: chosen.status,
            resolutionNote: chosen.label,
            resolvedOn: chosen.status === 'resolved' ? day : null,
          },
        },
        { new: true }
      ).lean()

      if (!record) throw httpError(404, 'That hand-over entry no longer exists.')
      await writeAudit(AuditLog, 'Hand-over outcome', `${rollNo}: ${chosen.label}`)
      res.json({ date: day, record })
    })
  )

  router.get(
    '/restrictions/exit',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()
      const filter = { date, restrictionType: 'exit' }
      if (req.query.status && req.query.status !== 'ALL') {
        filter.resolutionStatus = req.query.status
      }

      const rows = await DailyRecord.find(filter)
        .sort({ section: 1, rollNo: 1 })
        .limit(400)
        .select(
          '-_id rollNo name grade section restrictionReason resolutionStatus ' +
            'restrictionEndDate restrictionUntilResolved resolutionNote excusedApprover'
        )
        .lean()

      const repeat = await DailyRecord.aggregate([
        {
          $match: {
            rollNo: { $in: rows.map((row) => row.rollNo) },
            restrictionType: 'exit',
            resolutionStatus: 'resolved',
          },
        },
        { $group: { _id: '$rollNo', count: { $sum: 1 } } },
      ])
      const repeatMap = new Map(repeat.map((row) => [row._id, row.count]))

      res.json({
        date,
        rows: rows.map((row) => ({
          ...row,
          repeatResolutions: repeatMap.get(row.rollNo) || 0,
        })),
      })
    })
  )

  router.post(
    '/restrictions/exit/:rollNo/resolve',
    api(async (req, res) => {
      const { note, date } = req.body || {}
      if (!note || !String(note).trim()) {
        throw httpError(400, 'A resolution note is required.')
      }

      const day = date || todayIso()
      const rollNo = String(req.params.rollNo).toUpperCase()
      const current = await DailyRecord.findOne({
        date: day,
        rollNo,
        restrictionType: 'exit',
      }).lean()
      if (!current) throw httpError(404, 'No exit restriction found for that student.')
      if (current.resolutionStatus === 'resolved') {
        throw httpError(400, 'This exit restriction is already resolved.')
      }

      const record = await DailyRecord.findOneAndUpdate(
        { date: day, rollNo, restrictionType: 'exit' },
        {
          $set: {
            resolutionStatus: 'resolved',
            resolvedOn: day,
            resolutionNote: String(note).trim(),
          },
        },
        { new: true }
      ).lean()

      if (!record) throw httpError(404, 'No exit restriction found for that student.')
      await writeAudit(AuditLog, 'Exit restriction resolved', `${rollNo}: ${String(note).trim()}`)
      res.json({ date: day, record })
    })
  )

  router.post(
    '/restrictions/exit/:rollNo/excuse',
    api(async (req, res) => {
      const { approver, endDate, date } = req.body || {}
      if (!approver || !String(approver).trim()) throw httpError(400, 'Approver is required.')
      if (!endDate) throw httpError(400, 'An end date is required.')

      const day = date || todayIso()
      const rollNo = String(req.params.rollNo).toUpperCase()
      const current = await DailyRecord.findOne({
        date: day,
        rollNo,
        restrictionType: 'exit',
      }).lean()
      if (!current) throw httpError(404, 'No exit restriction found for that student.')
      if (current.resolutionStatus === 'resolved') {
        throw httpError(400, 'This exit restriction is already resolved.')
      }

      const record = await DailyRecord.findOneAndUpdate(
        { date: day, rollNo, restrictionType: 'exit' },
        {
          $set: {
            resolutionStatus: 'excused',
            excusedApprover: String(approver).trim(),
            restrictionEndDate: endDate,
            resolutionNote: `Excused by ${String(approver).trim()}`,
            resolvedOn: null,
          },
        },
        { new: true }
      ).lean()

      if (!record) throw httpError(404, 'No exit restriction found for that student.')
      await writeAudit(
        AuditLog,
        'Exit restriction excused',
        `${rollNo}: ${String(approver).trim()} until ${endDate}`
      )
      res.json({ date: day, record })
    })
  )

  router.get(
    '/buses',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()
      // Reuse the transport view so manual overrides and rider flags agree with
      // what the transport in-charge sees.
      const day = await transportDay(date)
      const rows = day.routes.map((route) => ({
        route: route.route,
        arrivalTime: route.arrivalTime,
        status: route.status,
        studentsOnRoute: route.riders,
        lateStudents: route.late ? route.riders : 0,
        override: route.override,
      }))

      res.json({ date, summary: day.summary, rows })
    })
  )

  router.post(
    '/buses/:route/convert',
    api(async (req, res) => {
      const day = req.body?.date || todayIso()
      const route = String(req.params.route).toUpperCase()

      const bus = await BusLog.findOne({ date: day, route }).lean()
      if (!bus) throw httpError(404, 'That route has no log for this date.')

      const settings = await loadSettings(Settings)
      const cutoff = routeCutoffFor(settings, route)
      const cutoffMin = toMinutes(cutoff)
      const arrivalMin = toMinutes(bus.arrivalTime)
      const overridden = bus.overrideLate === true || bus.overrideLate === false
      const late = overridden ? bus.overrideLate : arrivalMin !== null && arrivalMin > cutoffMin
      if (!late) {
        throw httpError(400, `That route is not late against the ${cutoff} cut-off.`)
      }

      // Select by route and rider, not the stored flag, so routes that became
      // late when the cut-off moved to 08:20 can still be converted.
      const lateStudents = await DailyRecord.find({
        date: day,
        busRoute: route,
        rider: { $ne: false },
      })
        .select('rollNo restrictionType')
        .lean()
      if (lateStudents.length === 0) throw httpError(400, 'No late students on this route.')

      // A student only carries one restriction per day. Converting a route
      // must never silently wipe an entry restriction (and its pending
      // subjects), so those students are reported as skipped instead.
      const convertible = lateStudents.filter((record) => record.restrictionType !== 'entry')
      const skipped = lateStudents.length - convertible.length
      if (convertible.length === 0) {
        throw httpError(
          400,
          'Every late student on this route already has an entry restriction; nothing to convert.'
        )
      }

      const reason = settings.exitReasons.includes('Late to college')
        ? 'Late to college'
        : settings.exitReasons[0]

      await DailyRecord.updateMany(
        {
          date: day,
          busRoute: route,
          rider: { $ne: false },
          restrictionType: { $ne: 'entry' },
        },
        {
          $set: {
            restrictionType: 'exit',
            restrictionReason: reason,
            resolutionStatus: 'pending',
            restrictionUntilResolved: true,
            restrictionEndDate: null,
            resolvedOn: null,
          },
        }
      )

      await writeAudit(
        AuditLog,
        'Bus late converted',
        `${route}: ${convertible.length} exit restriction(s), ${skipped} skipped (entry), reason ${reason}`
      )
      res.json({
        date: day,
        route,
        created: convertible.length,
        skipped,
        reason,
      })
    })
  )

  router.get(
    '/settings',
    api(async (req, res) => {
      res.json(await loadSettings(Settings))
    })
  )

  router.put(
    '/settings',
    api(async (req, res) => {
      const body = req.body || {}
      const patch = { key: 'main' }

      if (Array.isArray(body.exitReasons)) {
        const reasons = body.exitReasons.map((item) => String(item).trim()).filter(Boolean)
        if (reasons.length === 0) throw httpError(400, 'Keep at least one exit reason.')
        patch.exitReasons = reasons
      }
      if (Array.isArray(body.entrySubjects)) {
        const subjects = body.entrySubjects.map((item) => String(item).trim()).filter(Boolean)
        if (subjects.length === 0) throw httpError(400, 'Keep at least one subject.')
        patch.entrySubjects = subjects
      }
      if (body.busCutoff) patch.busCutoff = String(body.busCutoff)
      if (body.routeCutoffs && typeof body.routeCutoffs === 'object') {
        patch.routeCutoffs = Object.fromEntries(
          Object.entries(body.routeCutoffs)
            .filter(([, time]) => Boolean(time))
            .map(([route, time]) => [String(route).toUpperCase(), String(time)])
        )
      }

      const doc = await Settings.findOneAndUpdate(
        { key: 'main' },
        { $set: patch },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean()

      await writeAudit(
        AuditLog,
        'Settings updated',
        `cutoff ${doc.busCutoff} · ${doc.exitReasons.length} reasons · ` +
          `${Object.keys(patch.routeCutoffs || doc.routeCutoffs || {}).length} route overrides`
      )

      res.json(await loadSettings(Settings))
    })
  )

  router.get(
    '/audit',
    api(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 40, 200)
      const rows = await AuditLog.find().sort({ at: -1 }).limit(limit).lean()
      res.json({
        rows: rows.map((row) => ({
          at: row.at,
          actor: row.actor,
          action: row.action,
          detail: row.detail,
        })),
      })
    })
  )

  router.get(
    '/records',
    api(async (req, res) => {
      await ensureToday()
      const match = scope(req.query, todayIso())
      const rows = await DailyRecord.find(match)
        .sort({ section: 1, rollNo: 1 })
        .select(
          '-_id rollNo name grade section attendance busRoute busLate ' +
            'restrictionType restrictionReason handover resolutionStatus resolvedOn'
        )
        .lean()

      res.json({ date: match.date, count: rows.length, rows })
    })
  )

  router.get(
    '/students/search',
    api(async (req, res) => {
      const query = String(req.query.q || '').trim()
      if (query.length < 2) {
        res.json({ students: [] })
        return
      }

      const rx = new RegExp(escapeRegex(query), 'i')
      const students = await Student.find({ $or: [{ rollNo: rx }, { name: rx }] })
        .limit(8)
        .select('rollNo name grade section busRoute')
        .lean()

      const rollNos = students.map((student) => student.rollNo)
      const activeSince = isoDaysAgo(ACTIVE_WINDOW_DAYS)
      const stats = await DailyRecord.aggregate([
        { $match: { rollNo: { $in: rollNos } } },
        {
          $group: {
            _id: '$rollNo',
            busLateCount: { $sum: { $cond: ['$busLate', 1, 0] } },
            repeatResolutions: {
              $sum: { $cond: [{ $eq: ['$resolutionStatus', 'resolved'] }, 1, 0] },
            },
            lastDate: { $max: '$date' },
            pending: {
              $push: {
                $cond: [
                  {
                    $and: [
                      {
                        $in: [
                          '$resolutionStatus',
                          ['pending', 'acknowledged', 'absent', 'excused'],
                        ],
                      },
                      { $ne: ['$restrictionType', null] },
                      { $gte: ['$date', activeSince] },
                    ],
                  },
                  {
                    type: '$restrictionType',
                    reason: '$restrictionReason',
                    status: '$resolutionStatus',
                    date: '$date',
                  },
                  null,
                ],
              },
            },
          },
        },
        {
          $project: {
            busLateCount: 1,
            repeatResolutions: 1,
            lastDate: 1,
            activeRestrictions: { $setDifference: [{ $setUnion: ['$pending'] }, [null]] },
          },
        },
      ])

      const byRoll = new Map(stats.map((row) => [row._id, row]))
      res.json({
        students: students.map((student) => {
          const stat = byRoll.get(student.rollNo)
          return {
            ...student,
            busLateCount: stat?.busLateCount || 0,
            repeatResolutions: stat?.repeatResolutions || 0,
            activeRestrictions: stat?.activeRestrictions || [],
            lastDate: stat?.lastDate || null,
          }
        }),
      })
    })
  )

  router.get(
    '/students/:rollNo',
    api(async (req, res) => {
      const rollNo = String(req.params.rollNo).toUpperCase()
      const student = await Student.findOne({ rollNo }).lean()
      if (!student) {
        res.status(404).json({ error: `No student with roll number ${rollNo}` })
        return
      }

      const [activeRestrictions, repeatResolutions, busLateHistory, recent] = await Promise.all([
        DailyRecord.find({
          rollNo,
          resolutionStatus: { $in: ['pending', 'acknowledged', 'absent', 'excused'] },
          date: { $gte: isoDaysAgo(ACTIVE_WINDOW_DAYS) },
        })
          .sort({ date: -1 })
          .select('-_id date restrictionType restrictionReason resolutionStatus')
          .lean(),
        DailyRecord.countDocuments({ rollNo, resolutionStatus: 'resolved' }),
        DailyRecord.find({ rollNo, busLate: true })
          .sort({ date: -1 })
          .limit(8)
          .select('-_id date busRoute')
          .lean(),
        DailyRecord.find({ rollNo })
          .sort({ date: -1 })
          .limit(7)
          .select('-_id date attendance restrictionReason resolutionStatus')
          .lean(),
      ])

      res.json({ student, activeRestrictions, repeatResolutions, busLateHistory, recent })
    })
  )

  // ---- gate & security ----------------------------------------------------

  router.get(
    '/gate/today',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()

      const [
        exitRestricted,
        authMessages,
        sentHomeRecords,
        excusedExits,
        gateLogs,
        busLogs,
      ] = await Promise.all([
        DailyRecord.find({
          date,
          restrictionType: 'exit',
          resolutionStatus: { $in: ['pending', 'acknowledged'] },
        })
          .sort({ grade: 1, section: 1, rollNo: 1 })
          .select('rollNo name grade section restrictionReason resolutionStatus restrictionEndDate restrictionUntilResolved gateExitTime')
          .lean(),
        LeaderMessage.find({
          date,
          type: 'authorized-exit',
        })
          .sort({ sentAt: -1 })
          .lean(),
        DailyRecord.find({
          date,
          handover: true,
          handoverOutcome: 'sent-home',
        })
          .sort({ grade: 1, section: 1, rollNo: 1 })
          .select('rollNo name grade section handoverAt resolutionNote gateExitTime')
          .lean(),
        DailyRecord.find({
          date,
          restrictionType: 'exit',
          resolutionStatus: 'excused',
        })
          .sort({ grade: 1, section: 1, rollNo: 1 })
          .select('rollNo name grade section excusedApprover restrictionReason resolutionNote gateExitTime')
          .lean(),
        GateLog ? GateLog.find({ date }).sort({ createdAt: -1 }).limit(100).lean() : [],
        BusLog.find({ date })
          .lean()
          .then((rows) => rows.sort((a, b) => byRoute(a.route, b.route))),
      ])

      // The gate shows the same live lateness as transport, based on the 8:20
      // cut-off rather than the last stored flag.
      const settings = await loadSettings(Settings)
      const cutoffMin = toMinutes(settings.busCutoff)
      const busRiders = await DailyRecord.find({ date, busRoute: { $ne: null } })
        .select('rollNo name grade section busRoute rider')
        .lean()
      const buses = busLogs.map((bus) => {
        const arrival = toMinutes(bus.arrivalTime)
        const overridden = bus.overrideLate === true || bus.overrideLate === false
        const late = overridden
          ? bus.overrideLate
          : arrival !== null && arrival > cutoffMin
        const students = busRiders
          .filter((record) => record.busRoute === bus.route && record.rider !== false)
          .sort((a, b) => a.rollNo.localeCompare(b.rollNo))
          .map((record) => ({
            rollNo: record.rollNo,
            name: record.name,
            classLabel: `${record.grade === 'PU1' ? '11' : '12'}${record.section}`,
          }))
        return {
          ...bus,
          late,
          students,
          affectedStudents: students.length,
          scheduledTime: bus.scheduledTime || settings.busCutoff,
        }
      })

      const passesMap = new Map()

      for (const msg of authMessages) {
        for (const st of msg.students || []) {
          if (!st.rollNo) continue
          const key = st.rollNo.toUpperCase()
          if (!passesMap.has(key)) {
            passesMap.set(key, {
              id: `msg-${msg._id}-${st.rollNo}`,
              rollNo: st.rollNo,
              name: st.name,
              grade: msg.grade,
              section: msg.section,
              classLabel: `${msg.grade === 'PU1' ? '11' : '12'}${msg.section}`,
              exitTime: msg.exitTime || msg.sentAt,
              approvedBy: msg.sender || 'Class Teacher',
              reason: msg.body || 'Authorized early exit',
              source: 'authorized-exit',
              gateExitTime: null,
              exited: false,
            })
          }
        }
      }

      for (const rec of sentHomeRecords) {
        const key = rec.rollNo.toUpperCase()
        if (!passesMap.has(key)) {
          passesMap.set(key, {
            id: `handover-${rec._id}`,
            rollNo: rec.rollNo,
            name: rec.name,
            grade: rec.grade,
            section: rec.section,
            classLabel: `${rec.grade === 'PU1' ? '11' : '12'}${rec.section}`,
            exitTime: rec.handoverAt || 'Desk Clear',
            approvedBy: 'Admin Desk',
            reason: rec.resolutionNote || 'Sent home by administration',
            source: 'handover-sent-home',
            gateExitTime: rec.gateExitTime || null,
            exited: Boolean(rec.gateExitTime),
          })
        }
      }

      for (const rec of excusedExits) {
        const key = rec.rollNo.toUpperCase()
        if (!passesMap.has(key)) {
          passesMap.set(key, {
            id: `excused-${rec._id}`,
            rollNo: rec.rollNo,
            name: rec.name,
            grade: rec.grade,
            section: rec.section,
            classLabel: `${rec.grade === 'PU1' ? '11' : '12'}${rec.section}`,
            exitTime: 'Excused',
            approvedBy: rec.excusedApprover || 'Coordinator',
            reason: rec.resolutionNote || `Excused: ${rec.restrictionReason}`,
            source: 'excused',
            gateExitTime: rec.gateExitTime || null,
            exited: Boolean(rec.gateExitTime),
          })
        }
      }

      const exitedRollNos = new Set()
      for (const log of gateLogs) {
        if (log.type === 'exit' && log.rollNo) {
          exitedRollNos.add(log.rollNo.toUpperCase())
        }
      }

      const passList = Array.from(passesMap.values()).map((p) => {
        const hasExited = p.exited || exitedRollNos.has(p.rollNo.toUpperCase())
        return {
          ...p,
          exited: hasExited,
        }
      })

      const restrictionsList = exitRestricted.map((r) => ({
        ...r,
        classLabel: `${r.grade === 'PU1' ? '11' : '12'}${r.section}`,
      }))

      const summary = {
        activeRestrictions: exitRestricted.length,
        authorizedPasses: passList.length,
        exitedCount:
          passList.filter((p) => p.exited).length +
          gateLogs.filter(
            (l) => l.type === 'exit' && !passesMap.has(l.rollNo?.toUpperCase())
          ).length,
        blockedAttempts: gateLogs.filter((l) => l.type === 'blocked_attempt').length,
        totalLogs: gateLogs.length,
        buses: {
          total: buses.length,
          arrived: buses.filter((b) => b.arrivalTime !== null).length,
          late: buses.filter((b) => b.late).length,
        },
      }

      res.json({
        date,
        summary,
        passes: passList,
        restrictions: restrictionsList,
        logs: gateLogs,
        buses,
      })
    })
  )

  router.get(
    '/gate/check/:rollNo',
    api(async (req, res) => {
      await ensureToday()
      const rollNo = String(req.params.rollNo || '').trim().toUpperCase()
      const date = req.query.date || todayIso()

      const student = await Student.findOne({ rollNo }).lean()
      if (!student) {
        res.status(404).json({ error: `Student with roll number "${rollNo}" not found on roster.` })
        return
      }

      const [dailyRecord, authMessage, gateLogs] = await Promise.all([
        DailyRecord.findOne({ date, rollNo }).lean(),
        LeaderMessage.findOne({
          date,
          type: 'authorized-exit',
          'students.rollNo': rollNo,
        }).lean(),
        GateLog ? GateLog.find({ rollNo }).sort({ createdAt: -1 }).limit(8).lean() : [],
      ])

      const isExitRestricted =
        dailyRecord?.restrictionType === 'exit' &&
        ['pending', 'acknowledged'].includes(dailyRecord.resolutionStatus)

      const isHandoverSentHome =
        dailyRecord?.handover === true && dailyRecord.handoverOutcome === 'sent-home'

      const isExcusedExit =
        dailyRecord?.restrictionType === 'exit' &&
        dailyRecord.resolutionStatus === 'excused'

      const hasAuthorizedPass = Boolean(authMessage) || isHandoverSentHome || isExcusedExit

      let status = 'regular'
      let reason = null
      let approvedBy = null
      let exitTime = null
      let details = 'Regular student profile. No early exit pass recorded for today.'

      if (isExitRestricted) {
        status = 'blocked'
        reason = dailyRecord.restrictionReason
        approvedBy = null
        details = `BLOCKED: Active exit restriction (${dailyRecord.restrictionReason}). Do not permit student to leave campus.`
      } else if (hasAuthorizedPass) {
        status = 'authorized'
        if (authMessage) {
          reason = authMessage.body || 'Authorized Early Exit'
          approvedBy = authMessage.sender || 'Class Teacher'
          exitTime = authMessage.exitTime || authMessage.sentAt
          details = 'Authorized gate pass verified by teacher/coordinator.'
        } else if (isHandoverSentHome) {
          reason = dailyRecord.resolutionNote || 'Sent home by administration'
          approvedBy = 'Admin Desk'
          exitTime = dailyRecord.handoverAt || 'Desk Clear'
          details = 'Student cleared to be sent home by administration.'
        } else if (isExcusedExit) {
          reason = dailyRecord.resolutionNote || `Excused: ${dailyRecord.restrictionReason}`
          approvedBy = dailyRecord.excusedApprover || 'Coordinator'
          exitTime = 'Excused'
          details = 'Exit restriction was formally excused by coordinator.'
        }
      }

      const hasExited =
        Boolean(dailyRecord?.gateExitTime) ||
        gateLogs.some((l) => l.date === date && l.type === 'exit')

      res.json({
        ok: true,
        student: {
          ...student,
          classLabel: `${student.grade === 'PU1' ? '11' : '12'}${student.section}`,
        },
        dailyRecord: dailyRecord || null,
        clearance: {
          status,
          isBlocked: status === 'blocked',
          isAuthorized: status === 'authorized',
          isExited: hasExited,
          exitedAt: dailyRecord?.gateExitTime || null,
          reason,
          approvedBy,
          exitTime,
          details,
        },
        recentLogs: gateLogs,
      })
    })
  )

  router.post(
    '/gate/log',
    api(async (req, res) => {
      const { rollNo, type = 'exit', status = 'authorized', passDetails = '', remarks = '' } =
        req.body || {}

      if (!rollNo) throw httpError(400, 'Student roll number is required.')
      const normalizedRoll = String(rollNo).trim().toUpperCase()

      const student = await Student.findOne({ rollNo: normalizedRoll }).lean()
      if (!student) throw httpError(404, `Student with roll number "${normalizedRoll}" not found.`)

      const day = req.body?.date || todayIso()
      const time = nowClock()

      let log = null
      if (GateLog) {
        log = await GateLog.create({
          date: day,
          time,
          timestamp: new Date(),
          rollNo: student.rollNo,
          name: student.name,
          grade: student.grade,
          section: student.section,
          busRoute: student.busRoute || null,
          type: ['exit', 'entry', 'blocked_attempt'].includes(type) ? type : 'exit',
          status: ['authorized', 'blocked', 'regular', 'late_entry', 'handover'].includes(status)
            ? status
            : 'authorized',
          passDetails: passDetails ? String(passDetails).slice(0, 300) : null,
          remarks: remarks ? String(remarks).slice(0, 300) : null,
          loggedBy: req.user?.email || 'Gate Security',
        })
      }

      if (type === 'exit') {
        await DailyRecord.updateOne(
          { date: day, rollNo: student.rollNo },
          { $set: { gateExitTime: time, gateVerifiedBy: req.user?.email || 'Gate Security' } }
        )
      }

      const auditAction =
        type === 'blocked_attempt'
          ? 'Gate exit blocked'
          : type === 'entry'
          ? 'Gate entry logged'
          : 'Gate exit verified'

      await writeAudit(
        AuditLog,
        auditAction,
        `${student.rollNo} (${student.name}, ${student.grade}/${student.section}): ${status} at ${time}${
          remarks ? ` [${remarks}]` : ''
        }`
      )

      res.status(201).json({ ok: true, log, time })
    })
  )

  router.get(
    '/gate/logs',
    api(async (req, res) => {
      const date = req.query.date || todayIso()
      const limit = Math.min(Number(req.query.limit || 100), 200)
      const logs = GateLog
        ? await GateLog.find({ date }).sort({ createdAt: -1 }).limit(limit).lean()
        : []
      res.json({ date, logs })
    })
  )

  // ---- daily notes & in-app data sheet ------------------------------------

  router.get(
    '/notes',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()

      const filter = { date }
      if (req.query.category && req.query.category !== 'ALL') {
        filter.category = req.query.category
      }
      if (req.query.status && req.query.status !== 'ALL') {
        filter.status = req.query.status
      }
      if (req.query.grade && req.query.grade !== 'ALL') {
        filter.grade = req.query.grade
      }
      if (req.query.section && req.query.section !== 'ALL') {
        filter.section = req.query.section
      }
      if (req.query.q) {
        const rx = new RegExp(escapeRegex(req.query.q.trim()), 'i')
        filter.$or = [{ rollNo: rx }, { name: rx }, { content: rx }]
      }

      const [notes, allDateNotes] = await Promise.all([
        DailyNote ? DailyNote.find(filter).sort({ createdAt: -1 }).limit(150).lean() : [],
        DailyNote ? DailyNote.find({ date }).select('category status').lean() : [],
      ])

      const summary = {
        total: allDateNotes.length,
        active: allDateNotes.filter((n) => n.status === 'active').length,
        applied: allDateNotes.filter((n) => n.status === 'applied').length,
        exitRestrictions: allDateNotes.filter((n) => n.category === 'exit_restriction').length,
        entryRestrictions: allDateNotes.filter((n) => n.category === 'entry_restriction').length,
        incidents: allDateNotes.filter((n) =>
          ['discipline', 'general', 'medical', 'parent_call', 'late_arrival'].includes(n.category)
        ).length,
      }

      res.json({ date, notes, summary })
    })
  )

  router.post(
    '/notes',
    api(async (req, res) => {
      const { rollNo, content, category = 'general', date } = req.body || {}
      if (!content || !String(content).trim()) {
        throw httpError(400, 'Note description or details are required.')
      }

      const day = date || todayIso()
      const time = nowClock()
      let student = null

      if (rollNo && String(rollNo).trim()) {
        const normRoll = String(rollNo).trim().toUpperCase()
        student = await Student.findOne({ rollNo: normRoll }).lean()
      }

      const note = DailyNote
        ? await DailyNote.create({
            date: day,
            time,
            rollNo: student?.rollNo || (rollNo ? String(rollNo).trim().toUpperCase() : null),
            name: student?.name || null,
            grade: student?.grade || null,
            section: student?.section || null,
            category: [
              'exit_restriction',
              'entry_restriction',
              'late_arrival',
              'discipline',
              'medical',
              'parent_call',
              'general',
            ].includes(category)
              ? category
              : 'general',
            content: String(content).trim(),
            status: 'active',
            author: req.user?.name || req.user?.email || 'Coordinator',
          })
        : null

      await writeAudit(
        AuditLog,
        'Daily note recorded',
        `${student ? `${student.rollNo} (${student.name})` : 'General'}: ${category}: ${String(content).slice(0, 60)}`
      )

      res.status(201).json({ ok: true, note })
    })
  )

  router.put(
    '/notes/:id',
    api(async (req, res) => {
      const { content, status, category } = req.body || {}
      const patch = {}
      if (content !== undefined) patch.content = String(content).trim()
      if (status !== undefined) patch.status = status
      if (category !== undefined) patch.category = category

      const note = await DailyNote.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).lean()
      if (!note) throw httpError(404, 'Note not found.')

      res.json({ ok: true, note })
    })
  )

  router.delete(
    '/notes/:id',
    api(async (req, res) => {
      const note = await DailyNote.findByIdAndDelete(req.params.id).lean()
      if (!note) throw httpError(404, 'Note not found.')
      res.json({ ok: true, deleted: true })
    })
  )

  router.post(
    '/notes/:id/apply',
    api(async (req, res) => {
      const note = await DailyNote.findById(req.params.id)
      if (!note) throw httpError(404, 'Note not found.')
      if (!note.rollNo) throw httpError(400, 'This note is not attached to a student roll number.')

      const student = await Student.findOne({ rollNo: note.rollNo }).lean()
      if (!student) throw httpError(404, 'Student not found on master roster.')

      const { applyType = 'exit', reason, subjects = [], untilResolved = true, endDate = null } =
        req.body || {}

      const day = note.date || todayIso()

      if (applyType === 'exit') {
        const effectiveReason = reason || note.content
        await DailyRecord.findOneAndUpdate(
          { date: day, rollNo: student.rollNo },
          {
            $set: {
              restrictionType: 'exit',
              restrictionReason: effectiveReason,
              resolutionStatus: 'pending',
              restrictionEndDate: untilResolved ? null : endDate,
              restrictionUntilResolved: Boolean(untilResolved),
              pendingSubjects: [],
              handover: false,
              resolvedOn: null,
            },
            $setOnInsert: {
              date: day,
              student: student._id,
              rollNo: student.rollNo,
              name: student.name,
              grade: student.grade,
              section: student.section,
              attendance: 'present',
              busRoute: student.busRoute,
              busLate: false,
            },
          },
          { upsert: true }
        )

        note.status = 'applied'
        note.appliedAs = 'exit_restriction'
        await note.save()

        await writeAudit(
          AuditLog,
          'Note applied as exit restriction',
          `${student.rollNo}: ${effectiveReason}`
        )
      } else if (applyType === 'entry') {
        let picked = Array.isArray(subjects) && subjects.length ? subjects : [note.content]
        await DailyRecord.findOneAndUpdate(
          { date: day, rollNo: student.rollNo },
          {
            $set: {
              restrictionType: 'entry',
              restrictionReason: picked.join(', '),
              pendingSubjects: picked,
              resolutionStatus: 'pending',
              restrictionEndDate: null,
              restrictionUntilResolved: false,
              handover: false,
              resolvedOn: null,
            },
            $setOnInsert: {
              date: day,
              student: student._id,
              rollNo: student.rollNo,
              name: student.name,
              grade: student.grade,
              section: student.section,
              attendance: 'present',
              busRoute: student.busRoute,
              busLate: false,
            },
          },
          { upsert: true }
        )

        note.status = 'applied'
        note.appliedAs = 'entry_restriction'
        await note.save()

        await writeAudit(
          AuditLog,
          'Note applied as entry restriction',
          `${student.rollNo}: ${picked.join(', ')}`
        )
      }

      res.json({ ok: true, note })
    })
  )

  // ---- admin data entry: the workbook's daily sheets ----------------------

  const EXIT_SHEET_STATUSES = ['pending', 'acknowledged', 'absent', 'excused', 'resolved']

  const insertDefaults = (day, student) => ({
    date: day,
    student: student._id,
    rollNo: student.rollNo,
    name: student.name,
    grade: student.grade,
    section: student.section,
    attendance: 'present',
    busRoute: student.busRoute,
    busLate: false,
  })

  router.get(
    '/datasheet/:date',
    api(async (req, res) => {
      await ensureToday()
      const date = req.params.date || todayIso()

      const [records, nc] = await Promise.all([
        DailyRecord.find({ date, restrictionType: { $in: ['exit', 'entry'] } })
          .sort({ section: 1, rollNo: 1 })
          .select(
            '-_id rollNo name grade section restrictionType restrictionReason ' +
              'restrictionUntilResolved restrictionEndDate pendingSubjects resolutionStatus resolvedOn'
          )
          .lean(),
        SectionNc
          ? SectionNc.find({ date }).select('-_id grade section count students updatedInNe').lean()
          : [],
      ])

      res.json({
        date,
        exit: records
          .filter((row) => row.restrictionType === 'exit')
          .map((row) => ({
            ...row,
            classLabel: classLabelOf(row.grade, row.section),
            status: row.resolutionStatus,
          })),
        entry: records
          .filter((row) => row.restrictionType === 'entry')
          .map((row) => ({
            ...row,
            classLabel: classLabelOf(row.grade, row.section),
            subjects: (row.pendingSubjects || []).join(', '),
          })),
        nc,
      })
    })
  )

  router.get(
    '/datasheet/:date/nc/:grade/:section/students',
    api(async (req, res) => {
      const grade = ['PU1', 'PU2'].includes(req.params.grade) ? req.params.grade : null
      const section = String(req.params.section || '').trim().toUpperCase()
      if (!grade || !section) throw httpError(400, 'Choose a valid grade and section.')

      const students = await Student.find({ grade, section })
        .sort({ rollNo: 1 })
        .select('rollNo name grade section')
        .lean()

      res.json({ students })
    })
  )

  router.post(
    '/datasheet/entry',
    api(async (req, res) => {
      const { sheet, rows = [], removed = [], date } = req.body || {}
      if (sheet !== 'exit' && sheet !== 'entry') {
        throw httpError(400, 'Choose the exit or entry restriction sheet.')
      }
      if (!Array.isArray(rows) || !Array.isArray(removed)) {
        throw httpError(400, 'Rows must be a list.')
      }

      const day = date || todayIso()
      const author = req.user?.name || req.user?.email || 'Coordinator'
      const removedRolls = removed
        .map((roll) => String(roll || '').trim().toUpperCase())
        .filter(Boolean)
      const rollNos = [
        ...rows.map((row) => String(row.rollNo || '').trim().toUpperCase()),
        ...removedRolls,
      ].filter(Boolean)

      if (rollNos.length === 0) {
        throw httpError(400, 'Add at least one roll number to the sheet.')
      }

      const students = await Student.find({ rollNo: { $in: rollNos } }).lean()
      const studentMap = new Map(students.map((student) => [student.rollNo, student]))
      const errors = []
      let saved = 0

      // A row the coordinator deleted from the sheet is cleared from the
      // register for that day only; other days keep their history.
      for (const rollNo of removedRolls) {
        if (!studentMap.has(rollNo)) continue
        await DailyRecord.updateOne(
          { date: day, rollNo, restrictionType: sheet },
          {
            $set: {
              restrictionType: null,
              restrictionReason: null,
              restrictionEndDate: null,
              restrictionUntilResolved: false,
              pendingSubjects: [],
              resolutionStatus: 'none',
              resolvedOn: null,
            },
          }
        )
        saved += 1
      }

      for (const row of rows) {
        const rollNo = String(row.rollNo || '').trim().toUpperCase()
        if (!rollNo) continue

        const student = studentMap.get(rollNo)
        if (!student) {
          errors.push({ rollNo, error: 'Student not found on master roster' })
          continue
        }

        if (sheet === 'exit') {
          const status = EXIT_SHEET_STATUSES.includes(row.status) ? row.status : 'pending'
          const reason = String(row.reason || '').trim() || 'Noted by coordinator'
          const resolved = status === 'resolved'
          await DailyRecord.findOneAndUpdate(
            { date: day, rollNo },
            {
              $set: {
                restrictionType: 'exit',
                restrictionReason: reason,
                restrictionUntilResolved: !resolved,
                restrictionEndDate: null,
                pendingSubjects: [],
                resolutionStatus: status,
                resolvedOn: resolved ? day : null,
                // A fresh upload has to be acknowledged again.
                uploadAcknowledgedAt: null,
                uploadAcknowledgedBy: null,
              },
              $setOnInsert: insertDefaults(day, student),
            },
            { upsert: true }
          )
        } else {
          const subjects = String(row.subjects || '')
            .split(/[,;/+]+/)
            .map((item) => item.trim())
            .filter(Boolean)
          await DailyRecord.findOneAndUpdate(
            { date: day, rollNo },
            {
              $set: {
                restrictionType: 'entry',
                restrictionReason: subjects.length ? subjects.join(', ') : 'All Subjects',
                pendingSubjects: subjects.length ? subjects : ['All Subjects'],
                restrictionUntilResolved: false,
                restrictionEndDate: null,
                resolutionStatus: 'pending',
                resolvedOn: null,
                uploadAcknowledgedAt: null,
                uploadAcknowledgedBy: null,
              },
              $setOnInsert: insertDefaults(day, student),
            },
            { upsert: true }
          )
        }
        saved += 1
      }

      // A student who is already on yesterday's sheet is worth flagging: the
      // coordinator may be repeating a row that was never cleared.
      const savedRolls = [
        ...new Set(
          rows
            .map((row) => String(row.rollNo || '').trim().toUpperCase())
            .filter((rollNo) => rollNo && studentMap.has(rollNo))
        ),
      ]
      let repeats = []
      if (savedRolls.length) {
        const yesterday = previousIso(day)
        const previous = yesterday
          ? await DailyRecord.find({
              date: yesterday,
              rollNo: { $in: savedRolls },
              restrictionType: sheet,
            })
              .select('rollNo name grade section restrictionReason pendingSubjects')
              .lean()
          : []
        repeats = previous.map((row) => ({
          rollNo: row.rollNo,
          name: row.name,
          classLabel: classLabelOf(row.grade, row.section),
          reason:
            sheet === 'exit'
              ? row.restrictionReason || ''
              : (row.pendingSubjects || []).join(', '),
          date: yesterday,
        }))
      }

      await writeAudit(
        AuditLog,
        `Data entry: ${sheet} restriction sheet`,
        `${saved} row(s) saved for ${day} by ${author}`
      )

      res.json({ ok: true, saved, errors, repeats })
    })
  )

  router.post(
    '/datasheet/nc',
    api(async (req, res) => {
      if (!SectionNc) throw httpError(503, 'The NC sheet is unavailable.')
      const { date, rows = [] } = req.body || {}
      if (!Array.isArray(rows)) throw httpError(400, 'Rows must be a list.')

      const day = date || todayIso()
      const author = req.user?.name || req.user?.email || 'Coordinator'
      let saved = 0

      for (const row of rows) {
        const grade = row.grade === 'PU2' ? 'PU2' : row.grade === 'PU1' ? 'PU1' : null
        const section = String(row.section || '').trim().toUpperCase()
        if (!grade || !section) continue

        const rawStudents = Array.isArray(row.students)
          ? row.students
          : String(row.students || '')
              .split(/[\s,;]+/)
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)

        const studentList = [...new Set(rawStudents)]
        const count = Math.max(studentList.length, Math.floor(Number(row.count) || 0))

        const previousSection = await SectionNc.findOne({ date: day, grade, section })
          .select('students')
          .lean()
        const selectedStudents = new Set(studentList)
        const removedStudents = (previousSection?.students || []).filter(
          (rollNo) => !selectedStudents.has(rollNo)
        )
        if (removedStudents.length) {
          await DailyRecord.updateMany(
            {
              date: day,
              grade,
              section,
              rollNo: { $in: removedStudents },
              ncReason: 'Coordinator CC NC',
              ncCount: { $lte: 1 },
            },
            { $set: { ncFlag: false, ncCount: 0, ncReason: null, ncAt: null } }
          )
        }

        await SectionNc.findOneAndUpdate(
          { date: day, grade, section },
          { $set: { count, students: studentList, updatedInNe: Boolean(row.updatedInNe), author } },
          { upsert: true, setDefaultsOnInsert: true }
        )

        // Also mark these students' DailyRecords with ncFlag so they appear across register and review
        if (studentList.length > 0) {
          for (const roll of studentList) {
            await DailyRecord.updateOne(
              { date: day, grade, section, rollNo: roll },
              {
                $set: {
                  ncFlag: true,
                  ncReason: 'Coordinator CC NC',
                },
                $max: { ncCount: 1 },
              }
            )
          }
        }

        saved += 1
      }

      await writeAudit(AuditLog, 'Data entry: CC NC sheet', `${saved} section(s) saved for ${day}`)
      res.json({ ok: true, saved })
    })
  )

  // ---- super admin: final approval of the acknowledged upload --------------

  router.get(
    '/superadmin/today',
    api(async (req, res) => {
      await ensureToday()
      const date = req.query.date || todayIso()

      const [records, groups, docs, sections, sectionNcs] = await Promise.all([
        DailyRecord.find({ date })
          .select(
            'grade section rollNo name restrictionType restrictionReason pendingSubjects ' +
              'resolutionStatus handover attendance ncFlag ncCount ncReason'
          )
          .lean(),
        Student.aggregate([
          { $group: { _id: { grade: '$grade', section: '$section' } } },
          { $sort: { '_id.section': 1 } },
        ]),
        EntrySection.find({ date }).lean(),
        Section.find({}).select('grade section teacher').lean(),
        SectionNc ? SectionNc.find({ date }).lean() : [],
      ])

      const teacherBySection = new Map(
        sections.map((item) => [`${item.grade}:${item.section}`, item.teacher])
      )

      const bySection = new Map()
      for (const doc of docs) bySection.set(`${doc.grade}:${doc.section}`, doc)

      const ncBySection = new Map()
      for (const snc of sectionNcs) ncBySection.set(`${snc.grade}:${snc.section}`, snc)

      const sectionRows = groups.map((group) => {
        const { grade, section } = group._id
        const label = classLabelOf(grade, section)
        const mine = records.filter((row) => row.grade === grade && row.section === section)
        const doc = bySection.get(`${grade}:${section}`)

        const exit = mine.filter((row) => row.restrictionType === 'exit')
        const entry = mine.filter((row) => row.restrictionType === 'entry')
        const adminRows = [
          ...exit.map((row) => {
            const parsedCount = parseNcCountFromDetail(row.restrictionReason)
            const isNc = Boolean(row.ncFlag) || parsedCount > 0
            const count = Number(row.ncCount) || (row.ncFlag ? 1 : parsedCount || 0)
            return {
              type: 'exit',
              rollNo: row.rollNo,
              name: row.name,
              detail: row.restrictionReason || 'Exit restriction',
              status: row.resolutionStatus,
              ncFlag: isNc,
              ncCount: count,
              ncReason: row.ncReason || (parsedCount > 0 ? row.restrictionReason : null),
            }
          }),
          ...entry.map((row) => {
            const parsedCount = parseNcCountFromDetail(row.restrictionReason)
            const isNc = Boolean(row.ncFlag) || parsedCount > 0
            const count = Number(row.ncCount) || (row.ncFlag ? 1 : parsedCount || 0)
            return {
              type: 'entry',
              rollNo: row.rollNo,
              name: row.name,
              detail: (row.pendingSubjects || []).join(', ') || row.restrictionReason || 'All subjects',
              status: row.handover ? 'handed over' : row.resolutionStatus,
              ncFlag: isNc,
              ncCount: count,
              ncReason: row.ncReason || (parsedCount > 0 ? row.restrictionReason : null),
            }
          }),
        ].sort((a, b) => a.rollNo.localeCompare(b.rollNo))

        const uploaded = adminRows.length
        const acknowledged = Boolean(doc?.adminAcknowledgedAt) && (doc?.adminAcknowledgedCount || 0) === uploaded

        // Collect ncStudents from attendance ncFlag as well as coordinator rows mentioning NCs
        const ncStudentMap = new Map()
        for (const row of mine) {
          if (row.ncFlag) {
            ncStudentMap.set(row.rollNo, {
              rollNo: row.rollNo,
              name: row.name,
              reason: row.ncReason || 'Delayed arrival',
              count: Number(row.ncCount) || 1,
            })
          }
        }
        for (const item of adminRows) {
          if (item.ncFlag && item.ncCount > 0 && !ncStudentMap.has(item.rollNo)) {
            ncStudentMap.set(item.rollNo, {
              rollNo: item.rollNo,
              name: item.name,
              reason: item.ncReason || item.detail || 'Crossed 3 NCs',
              count: item.ncCount,
            })
          }
        }
        const snc = ncBySection.get(`${grade}:${section}`)
        if (snc?.students?.length) {
          for (const roll of snc.students) {
            if (!ncStudentMap.has(roll)) {
              const rec = mine.find((r) => r.rollNo === roll)
              ncStudentMap.set(roll, {
                rollNo: roll,
                name: rec?.name || roll,
                reason: 'CC NC Digital entry',
                count: 1,
              })
            }
          }
        }
        const ncStudents = [...ncStudentMap.values()]

        const effectiveNcCount = doc?.ncCount ?? snc?.count ?? null
        const effectiveUpdatedInNe = Boolean(doc?.updatedInNe || snc?.updatedInNe)

        return {
          grade,
          section,
          label,
          teacher: teacherBySection.get(`${grade}:${section}`) || null,
          adminRows,
          rowCount: uploaded,
          teacherAcknowledged: acknowledged,
          acknowledgedAt: doc?.adminAcknowledgedAt || null,
          acknowledgedBy: doc?.adminAcknowledgedBy || null,
          ncCount: effectiveNcCount,
          updatedInNe: effectiveUpdatedInNe,
          ncStudents,
          attendance: {
            present: mine.filter((row) => row.attendance === 'present').length,
            absent: mine.filter((row) => row.attendance === 'absent').length,
            late: mine.filter((row) => row.attendance === 'late').length,
          },
          finalStatus: doc?.finalStatus || 'pending',
          finalAt: doc?.finalAt || null,
          finalBy: doc?.finalBy || null,
          finalNote: doc?.finalNote || null,
          ncDeducted: doc?.ncDeducted || 0,
          ncReducedRollNos: doc?.ncReducedRollNos || [],
          ready: uploaded > 0 && acknowledged,
        }
      })

      // Work first: sections the teacher has acknowledged but nobody approved yet.
      sectionRows.sort((a, b) => {
        const weight = (row) =>
          row.finalStatus === 'approved' ? 2 : row.ready ? 0 : 1
        return weight(a) - weight(b) || a.label.localeCompare(b.label)
      })

      res.json({
        date,
        sections: sectionRows,
        summary: {
          total: sectionRows.length,
          withUploads: sectionRows.filter((row) => row.rowCount > 0).length,
          awaitingTeacher: sectionRows.filter((row) => row.rowCount > 0 && !row.teacherAcknowledged).length,
          ready: sectionRows.filter((row) => row.ready && row.finalStatus !== 'approved').length,
          approved: sectionRows.filter((row) => row.finalStatus === 'approved').length,
          ncDeducted: sectionRows.reduce((sum, row) => sum + (row.ncDeducted || 0), 0),
        },
      })
    })
  )

  router.post(
    '/superadmin/approve',
    api(async (req, res) => {
      const grade = req.body?.grade === 'PU2' ? 'PU2' : req.body?.grade === 'PU1' ? 'PU1' : null
      const section = String(req.body?.section || '').trim().toUpperCase()
      if (!grade || !section) throw httpError(400, 'Pick the section to approve.')
      const date = req.body?.date || todayIso()

      const doc = await EntrySection.findOne({ date, grade, section }).lean()
      if (!doc?.adminAcknowledgedAt) {
        throw httpError(400, 'The class teacher has not acknowledged the upload yet.')
      }
      if (doc.finalStatus === 'approved') {
        throw httpError(400, 'This section is already approved for today.')
      }

      const uploaded = await DailyRecord.countDocuments({
        date,
        grade,
        section,
        restrictionType: { $in: ['exit', 'entry'] },
      })
      if (uploaded === 0) throw httpError(400, 'Nothing was uploaded for this section today.')
      if ((doc.adminAcknowledgedCount || 0) !== uploaded) {
        throw httpError(400, 'The class teacher must acknowledge the latest upload before approval.')
      }

      // The super admin can forgive NCs student by student. A student may
      // carry more than one, so each entry names the student and the amount.
      const ncCount = doc.ncCount ?? null
      const legacyRollNos = Array.isArray(req.body?.reduceRollNos) ? req.body.reduceRollNos : []
      const rawReductions = Array.isArray(req.body?.reduceNcs)
        ? req.body.reduceNcs
        : legacyRollNos.map((rollNo) => ({ rollNo, count: 1 }))

      const byRollNo = new Map()
      for (const entry of rawReductions) {
        const rollNo = String(entry?.rollNo || entry || '').trim().toUpperCase()
        const count = Math.floor(Number(entry?.count ?? 1))
        if (!rollNo || !Number.isFinite(count) || count < 1) continue
        byRollNo.set(rollNo, (byRollNo.get(rollNo) || 0) + count)
      }
      const reductions = [...byRollNo.entries()].map(([rollNo, count]) => ({ rollNo, count }))
      const reducedRollNos = reductions.map((item) => item.rollNo)
      let reduceCount = 0

      if (reductions.length) {
        const flagged = await DailyRecord.find({
          date,
          grade,
          section,
          rollNo: { $in: reducedRollNos },
        })
          .select('rollNo ncFlag ncCount restrictionReason')
          .lean()
        const flaggedByRoll = new Map(
          flagged.map((row) => {
            const parsed = parseNcCountFromDetail(row.restrictionReason)
            const count = Number(row.ncCount) || (row.ncFlag ? 1 : parsed || 0)
            return [row.rollNo, { record: row, count }]
          })
        )
        const missing = reducedRollNos.filter((rollNo) => {
          const entry = flaggedByRoll.get(rollNo)
          return !entry || entry.count < 1
        })
        if (missing.length) {
          throw httpError(400, `These students have no NC today: ${missing.join(', ')}.`)
        }
        for (const { rollNo, count } of reductions) {
          const entry = flaggedByRoll.get(rollNo)
          const available = entry?.count || 0
          if (count > available) {
            throw httpError(
              400,
              `${rollNo} has only ${available} NC(s), so ${count} cannot be reduced.`
            )
          }
        }
        reduceCount = reductions.reduce((sum, item) => sum + item.count, 0)
        if (ncCount !== null && reduceCount > ncCount) {
          throw httpError(
            400,
            `Only ${ncCount} NC(s) are recorded, so ${reduceCount} cannot be reduced.`
          )
        }

        for (const { rollNo, count } of reductions) {
          const entry = flaggedByRoll.get(rollNo)
          const available = entry?.count || 1
          const remaining = available - count
          const update = remaining > 0
            ? { $set: { ncCount: remaining, ncFlag: true } }
            : { $set: { ncFlag: false, ncCount: 0, ncReason: null, ncAt: null } }
          
          // If the restriction reason itself was "Crossed 3 NCs", also clear or resolve the restriction if fully reduced
          if (remaining === 0 && entry?.record?.restrictionType === 'exit' && /nc/i.test(entry?.record?.restrictionReason || '')) {
            update.$set.resolutionStatus = 'resolved'
            update.$set.resolvedOn = date
            update.$set.resolutionNote = 'NCs reduced and cleared by Super Admin'
          }

          await DailyRecord.updateOne({ date, grade, section, rollNo }, update)
        }
      }

      const at = nowClock()
      const by = req.user?.email || 'Super Admin'
      const patch = {
        finalStatus: 'approved',
        finalAt: at,
        finalBy: by,
        finalNote: String(req.body?.note || '').trim() || null,
        ncDeducted: reduceCount,
        ncDeductedAt: reduceCount ? at : null,
        ncReducedRollNos: reducedRollNos,
      }
      if (reduceCount && ncCount !== null) {
        patch.ncCount = Math.max(0, ncCount - reduceCount)
      }

      await EntrySection.findOneAndUpdate(
        { date, grade, section },
        { $set: patch },
        { upsert: true, setDefaultsOnInsert: true }
      )

      await writeAudit(
        AuditLog,
        'Final approval',
        `${grade}/${section} approved for ${date}` +
          (reduceCount
            ? `: ${reduceCount} NC(s) reduced (${reductions
                .map((item) => (item.count > 1 ? `${item.rollNo} x${item.count}` : item.rollNo))
                .join(', ')})`
            : '')
      )

      res.json({
        ok: true,
        finalStatus: 'approved',
        finalAt: at,
        ncCount: patch.ncCount ?? ncCount,
        ncDeducted: reduceCount,
        ncReduced: reduceCount,
        ncReducedRollNos: reducedRollNos,
      })
    })
  )

  return router
}
