import { isSchoolDay, todayIso } from './defaults.js'

// A running app has to roll the day forward by itself: the seed only creates
// history. `ensureDay` materialises today's DailyRecord rows (and empty bus
// logs) from the roster the first time a screen asks for today, then memoises
// the result for the rest of the process lifetime.
const inFlight = new Map()

export function ensureDay({ Student, DailyRecord, BusLog }, date = todayIso()) {
  // Past dates come from history/seed; never invent attendance for them.
  if (date !== todayIso() || !isSchoolDay(date)) return Promise.resolve()

  const pending = inFlight.get(date)
  if (pending) return pending

  const run = materialize({ Student, DailyRecord, BusLog }, date).catch((error) => {
    // Let the next request retry instead of caching a failure for the day.
    inFlight.delete(date)
    throw error
  })

  inFlight.set(date, run)
  return run
}

async function materialize({ Student, DailyRecord, BusLog }, date) {
  const students = await Student.find()
    .select('_id rollNo name grade section busRoute')
    .lean()
  if (students.length === 0) return

  const [logs, existing] = await Promise.all([
    BusLog.find({ date }).select('route late overrideLate').lean(),
    DailyRecord.find({ date }).select('student').lean(),
  ])

  const seen = new Set(existing.map((record) => String(record.student)))
  const missing = students.filter((student) => !seen.has(String(student._id)))

  if (missing.length > 0) {
    await safeBulkWrite(
      DailyRecord,
      missing.map((student) => ({
        updateOne: {
          filter: { date, student: student._id },
          update: {
            $setOnInsert: {
              date,
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
          upsert: true,
        },
      }))
    )
  }

  // Routes with riders need a log row so the transport desk sees them as
  // "not arrived" instead of having the whole route disappear.
  const perRoute = new Map()
  for (const student of students) {
    if (!student.busRoute) continue
    perRoute.set(student.busRoute, (perRoute.get(student.busRoute) || 0) + 1)
  }

  const loggedRoutes = new Set(logs.map((log) => log.route))
  const newRoutes = [...perRoute.keys()].filter((route) => !loggedRoutes.has(route))

  if (newRoutes.length > 0) {
    await safeBulkWrite(
      BusLog,
      newRoutes.map((route) => ({
        updateOne: {
          filter: { date, route },
          update: {
            $setOnInsert: {
              date,
              route,
              arrivalTime: null,
              scheduledTime: null,
              late: false,
              affectedStudents: perRoute.get(route) || 0,
            },
          },
          upsert: true,
        },
      }))
    )
  }

  // A restart mid-morning should not lose lateness that was already logged.
  const effective = new Map(
    logs.map((log) => [
      log.route,
      typeof log.overrideLate === 'boolean' ? log.overrideLate : Boolean(log.late),
    ])
  )

  await Promise.all(
    [...effective.entries()]
      .filter(([route]) => perRoute.has(route))
      .map(([route, late]) =>
        DailyRecord.updateMany(
          { date, busRoute: route, rider: { $ne: false } },
          { $set: { busLate: late } }
        )
      )
  )
}

async function safeBulkWrite(Model, operations) {
  try {
    await Model.bulkWrite(operations, { ordered: false })
  } catch (error) {
    // Another process may have created the same rows first; that is fine.
    const duplicateOnly =
      error?.code === 11000 ||
      (Array.isArray(error?.writeErrors) &&
        error.writeErrors.every((entry) => entry?.code === 11000))
    if (!duplicateOnly) throw error
  }
}
