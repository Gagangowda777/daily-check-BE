import fs from 'node:fs'
import mongoose from 'mongoose'
import 'dotenv/config'
import { connectDb } from './src/db.js'
import Student from './src/models/Student.js'
import DailyRecord from './src/models/DailyRecord.js'
import BusLog from './src/models/BusLog.js'
import EntrySection from './src/models/EntrySection.js'
import LeaderMessage from './src/models/LeaderMessage.js'
import Section from './src/models/Section.js'
import Settings from './src/models/Settings.js'
import AuditLog from './src/models/AuditLog.js'
import {
  DEFAULT_BUS_CUTOFF,
  DEFAULT_ENTRY_SUBJECTS,
  DEFAULT_EXIT_REASONS,
} from './src/defaults.js'

const roster = JSON.parse(
  fs.readFileSync(new URL('./src/data/roster.json', import.meta.url), 'utf8')
)

const EXIT_REASONS = DEFAULT_EXIT_REASONS
const ENTRY_SUBJECTS = DEFAULT_ENTRY_SUBJECTS.filter(
  (subject) => subject !== 'All Subjects'
)

// One to three subjects per student, occasionally the whole set.
function pickSubjects(rand) {
  if (rand() < 0.12) return ['All Subjects']
  const pool = [...ENTRY_SUBJECTS]
  const count = 1 + Math.floor(rand() * 3)
  const picked = []
  for (let index = 0; index < count; index += 1) {
    picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  return picked
}

const ENTRY_REASONS = [
  'NOC pending',
  'Subject NOC (BS, KAN, STATS)',
  'Uniform check',
  'Late arrival note',
]
const MESSAGE_TYPES = {
  update: 'Update',
  announcement: 'Announcement',
  'authorized-exit': 'Authorized Exit',
  broadcast: 'Broadcast',
}

const MESSAGE_BODIES = {
  update: [
    'Study hour moves to 4:30 pm today. Bring both notebooks.',
    'Unit test portion is chapters 4 and 5 — revise the worked examples.',
    'Lab session starts at 8:15 am tomorrow, report straight to the physics lab.',
  ],
  announcement: [
    'Parent-teacher meeting this Saturday at 10:00 am. Please inform your parents.',
    'Uniform inspection during second period. Blazers are compulsory.',
    'The library stays open till 6:00 pm for the rest of this week.',
  ],
  'authorized-exit': [
    'Authorized exit approved. Collect the gate pass from the class teacher before leaving.',
    'Exit approved by the coordinator. Report back by 6:00 pm the same day.',
  ],
  broadcast: [
    'Bus timings change from Monday — check the notice board for your route.',
    'Half day on Friday, classes end at 12:40 pm.',
    'Sports trials after school today. Meet at the ground by 4:00 pm.',
  ],
}

const MESSAGE_SENDERS = ['Admin / Coordinator', 'Transport In-charge', 'Vice Principal']
const TEACHERS = [
  'Anitha Rao', 'Bhavesh Kulkarni', 'Chaitra Shetty', 'Dinesh Prasad',
  'Ekta Menon', 'Farhan Qureshi', 'Girija Nair', 'Harini Deshpande',
  'Ishwar Bhat', 'Jyothi Kamath', 'Kiran Salian', 'Latha Shenoy',
  'Mahesh Patil', 'Nandini Kulkarni', 'Omprakash Reddy', 'Pallavi Hegde',
  'Raghavendra Joshi', 'Shalini Pai', 'Tejas Acharya', 'Uma Chidanand',
  'Varun Nayak', 'Vidya Shenoy', 'Yashaswini Rao', 'Zainab Khan',
  'Aparna Varma', 'Deepak Shanbhag', 'Gayathri Iyer', 'Hemanth Kulkarni',
  'Indira Baliga', 'Jeevan Lobo', 'Kavitha Mallya', 'Lokesh Poojary',
  'Mamatha Rai', 'Naveen Kamath', 'Pooja Shetty', 'Ramesh Acharya',
  'Sangeetha Bhat', 'Suresh Pai', 'Triveni Nayak', 'Vasanthi Rao',
]

const DAYS = 30
const ROUTES = 27

// Deterministic pseudo-randomness keeps re-seeds identical day over day.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const isoDate = (date) => date.toLocaleDateString('en-CA')
const pick = (list, value) => list[Math.floor(value * list.length) % list.length]
const toClock = (minutes) => {
  const wrapped = Math.max(0, Math.min(minutes, 24 * 60 - 1))
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

const students = roster.map((row) => {
  const rand = mulberry32(hash(row.rollNo))
  const usesBus = rand() > 0.32
  const routeNumber = 1 + Math.floor(rand() * ROUTES)
  return {
    rollNo: row.rollNo,
    name: row.name,
    // Batch 26 joined in 2026 (PU1 / Grade 11), batch 25 is PU2 (Grade 12).
    grade: row.batch === '26' ? 'PU1' : 'PU2',
    section: row.section,
    busRoute: usesBus ? `R${routeNumber}` : null,
  }
})

const teacherFor = (grade, section) =>
  TEACHERS[
    Math.floor(mulberry32(hash(`teacher:${grade}:${section}`))() * TEACHERS.length) %
      TEACHERS.length
  ]

const sections = []
const seen = new Set()
for (const student of students) {
  const key = `${student.grade}${student.section}`
  if (seen.has(key)) continue
  seen.add(key)
  sections.push({ grade: student.grade, section: student.section })
}

const routeCounts = {}
for (const student of students) {
  if (!student.busRoute) continue
  routeCounts[student.busRoute] = (routeCounts[student.busRoute] || 0) + 1
}

function buildDays(count) {
  const days = []
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  while (days.length < count) {
    if (cursor.getDay() !== 0) days.push(isoDate(cursor)) // school runs Mon–Sat
    cursor.setDate(cursor.getDate() - 1)
  }
  return days.reverse()
}

// Shared by the bus log and the per-student busLate flag so a student is only
// marked bus-late when their route actually ran late that day.
function busState(date, route) {
  const index = Number(route.slice(1)) - 1
  const rand = mulberry32(hash(`${date}:bus:${route}`))
  const scheduled = 7 * 60 + 55 + index * 2 // 07:55 … 08:47
  const missing = rand() < 0.05
  const delay = Math.floor(rand() * 26)

  return {
    arrivalTime: missing ? null : toClock(scheduled + delay),
    scheduledTime: toClock(scheduled),
    // A bus that never arrived counts as late for the day's tally.
    late: missing || delay > 15,
    affectedStudents: routeCounts[route] || 0,
  }
}

// Every section needs a couple of students waiting on an entry check (and one
// open exit restriction) so the class-teacher screen always has real work.
function ensureSectionCoverage(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.grade}:${row.section}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  for (const group of groups.values()) {
    const pendingEntry = group.filter(
      (row) => row.restrictionType === 'entry' && row.resolutionStatus === 'pending'
    )
    const openExit = group.filter(
      (row) => row.restrictionType === 'exit' && row.resolutionStatus !== 'resolved'
    )
    const spare = group.filter((row) => !row.restrictionType && row.attendance !== 'absent')
    let cursor = 0

    const claim = () => (cursor < spare.length ? spare[cursor++] : null)

    while (pendingEntry.length < 2) {
      const row = claim()
      if (!row) break
      row.restrictionType = 'entry'
      const subjects = pickSubjects(mulberry32(hash(`entry:${row.grade}${row.section}:${cursor}`)))
      row.restrictionReason = subjects.join(', ')
      row.pendingSubjects = subjects
      row.resolutionStatus = 'pending'
      row.resolvedOn = null
      row.handover = false
      row.handoverAt = null
      row.acknowledgedBy = null
      row.acknowledgedAt = null
      pendingEntry.push(row)
    }

    while (openExit.length < 1) {
      const row = claim()
      if (!row) break
      row.restrictionType = 'exit'
      row.restrictionReason = pick(EXIT_REASONS, cursor / 5)
      row.resolutionStatus = 'pending'
      row.resolvedOn = null
      openExit.push(row)
    }
  }
}

function buildBusLogs(date) {
  return Array.from({ length: ROUTES }, (_, index) => {
    const route = `R${index + 1}`
    return { date, route, ...busState(date, route) }
  })
}

function buildEntrySections(date, { isToday = false } = {}) {
  return sections.map(({ grade, section }) => {
    const rand = mulberry32(hash(`${date}:entry:${grade}${section}`))
    // Today starts open so each class teacher has a check to complete.
    const missing = isToday || rand() < 0.07
    return {
      date,
      grade,
      section,
      submittedAt: missing ? null : toClock(8 * 60 + 40 + Math.floor(rand() * 40)),
      ncCount: missing ? null : Math.floor(rand() * 7),
      updatedInNe: !missing && rand() < 0.7,
    }
  })
}

function buildMessages(date) {
  const messages = []
  for (const { grade, section } of sections) {
    const rand = mulberry32(hash(`${date}:msg:${grade}${section}`))
    const pool = students
      .filter((student) => student.grade === grade && student.section === section)
      .sort((a, b) => a.rollNo.localeCompare(b.rollNo))
    const leaderName = pool[0]?.name || 'Class Leader'
    const teacher = teacherFor(grade, section)
    const count = 2 + Math.floor(rand() * 3) // 2 – 4 messages per section per day

    for (let index = 0; index < count; index += 1) {
      const type = pick(['update', 'announcement', 'authorized-exit', 'broadcast'], rand())
      const sent = 8 * 60 + Math.floor(rand() * 150) // 08:00 … 10:30
      const acknowledged = rand() < 0.45
      const seen = acknowledged || rand() < 0.35
      const leaving =
        type === 'authorized-exit' && pool.length
          ? [pick(pool, rand()), pick(pool, rand())]
              .filter(Boolean)
              .filter((student, i, list) => list.findIndex((s) => s.rollNo === student.rollNo) === i)
          : []

      messages.push({
        date,
        grade,
        section,
        title: MESSAGE_TYPES[type],
        type,
        target: 'Class Leader',
        sender:
          type === 'update' || type === 'authorized-exit' ? teacher : pick(MESSAGE_SENDERS, rand()),
        body: MESSAGE_BODIES[type][index % MESSAGE_BODIES[type].length],
        students: leaving.map((student) => ({ rollNo: student.rollNo, name: student.name })),
        exitTime:
          type === 'authorized-exit' ? toClock(sent + 20 + Math.floor(rand() * 40)) : null,
        sentAt: toClock(sent),
        seenAt: seen ? toClock(sent + 1 + Math.floor(rand() * 8)) : null,
        acknowledgedAt: acknowledged ? toClock(sent + 4 + Math.floor(rand() * 45)) : null,
        acknowledgedBy: acknowledged ? leaderName : null,
      })
    }
  }
  return messages
}

async function main() {
  await connectDb()
  console.log('[seed] connected')

  await Promise.all([
    Student.deleteMany({}),
    DailyRecord.deleteMany({}),
    BusLog.deleteMany({}),
    EntrySection.deleteMany({}),
    LeaderMessage.deleteMany({}),
    Section.deleteMany({}),
    Settings.deleteMany({}),
    AuditLog.deleteMany({}),
  ])
  console.log('[seed] cleared old data')

  const inserted = await Student.insertMany(students, { ordered: false })
  console.log(`[seed] inserted ${inserted.length} students in ${sections.length} sections`)

  await Section.insertMany(
    sections.map(({ grade, section }) => ({
      grade,
      section,
      teacher: teacherFor(grade, section),
    })),
    { ordered: false }
  )
  console.log(`[seed] inserted ${sections.length} sections with class teachers`)

  await Settings.create({
    key: 'main',
    exitReasons: [...DEFAULT_EXIT_REASONS],
    entrySubjects: [...DEFAULT_ENTRY_SUBJECTS],
    busCutoff: DEFAULT_BUS_CUTOFF,
    routeCutoffs: {},
  })
  console.log('[seed] settings created')

  const ids = new Map(inserted.map((doc) => [doc.rollNo, doc._id]))
  const days = buildDays(DAYS)
  let total = 0

  for (const date of days) {
    const batch = []
    for (const student of students) {
      const rand = mulberry32(hash(`${student.rollNo}:${date}`))
      const roll = rand()

      const attendance = roll < 0.03 ? 'absent' : roll < 0.085 ? 'late' : 'present'
      const bus = student.busRoute ? busState(date, student.busRoute) : null
      // Absent students are not riding, so they never pick up the route's lateness.
      const rider = attendance !== 'absent'
      const busLate = Boolean(bus?.late) && rider && rand() < 0.5

      let restrictionType = null
      let restrictionReason = null
      let pendingSubjects = []
      let resolutionStatus = 'none'
      let resolvedOn = null
      let handover = false
      let handoverAt = null
      let acknowledgedBy = null
      let acknowledgedAt = null

      if (rand() < 0.055) {
        const isExit = rand() < 0.6
        restrictionType = isExit ? 'exit' : 'entry'
        if (isExit) {
          restrictionReason = pick(EXIT_REASONS, rand())
        } else {
          pendingSubjects = pickSubjects(rand)
          restrictionReason = pendingSubjects.join(', ')
        }

        const statusRoll = rand()
        resolutionStatus =
          statusRoll < 0.3
            ? 'pending'
            : statusRoll < 0.55
              ? 'acknowledged'
              : statusRoll < 0.68
                ? 'absent'
                : statusRoll < 0.8
                  ? 'excused'
                  : 'resolved'

        if (resolutionStatus === 'resolved') resolvedOn = date
        if (resolutionStatus === 'acknowledged') {
          acknowledgedBy = teacherFor(student.grade, student.section)
          acknowledgedAt = toClock(9 * 60 + Math.floor(rand() * 180))
        }
        if (!isExit) {
          handover = rand() < 0.45
          // Oldest hand-overs first: the desk logs them through the morning.
          handoverAt = handover ? toClock(9 * 60 + Math.floor(rand() * 180)) : null
        }
      }

      batch.push({
        date,
        student: ids.get(student.rollNo),
        rollNo: student.rollNo,
        name: student.name,
        grade: student.grade,
        section: student.section,
        attendance,
        busRoute: student.busRoute,
        busLate,
        rider,
        restrictionType,
        restrictionReason,
        pendingSubjects,
        handover,
        handoverAt,
        acknowledgedBy,
        acknowledgedAt,
        resolutionStatus,
        resolvedOn,
      })
    }

    ensureSectionCoverage(batch)

    for (let i = 0; i < batch.length; i += 4000) {
      await DailyRecord.insertMany(batch.slice(i, i + 4000), { ordered: false })
    }

    await BusLog.insertMany(buildBusLogs(date), { ordered: false })
    await EntrySection.insertMany(buildEntrySections(date, { isToday: date === days.at(-1) }), {
      ordered: false,
    })

    const messages = buildMessages(date)
    if (messages.length) await LeaderMessage.insertMany(messages, { ordered: false })

    total += batch.length
    console.log(`[seed] ${date} → ${batch.length} rows, ${messages.length} messages`)
  }

  const byGrade = await Student.aggregate([
    { $group: { _id: '$grade', students: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])
  console.log('[seed] roster by grade:', JSON.stringify(byGrade))
  console.log(`[seed] ${total} daily rows across ${days.length} days`)
  await AuditLog.insertMany(
    days.slice(-6).map((day, index) => ({
      at: new Date(`${day}T${String(8 + index).padStart(2, '0')}:15:00`),
      actor: 'Admin / Coordinator',
      action: index % 2 === 0 ? 'Settings updated' : 'Message sent',
      detail:
        index % 2 === 0
          ? 'cutoff 08:20 · 8 reasons · no route overrides'
          : 'Update → PU1 (17 section(s))',
    }))
  )

  console.log(`[seed] done — ${days.at(-1)} is today`)

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error('[seed] failed:', error.message)
  await mongoose.disconnect()
  process.exit(1)
})
