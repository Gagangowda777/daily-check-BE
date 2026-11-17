import crypto from 'node:crypto'
import express from 'express'
import { ROLE_LABELS, todayIso } from './defaults.js'

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000 // one school shift
const ROLES = Object.keys(ROLE_LABELS)
const SECTION_ROLES = ['teacher', 'leader']

const httpError = (status, message) => Object.assign(new Error(message), { status })

// An env secret keeps tokens valid across restarts. The dev fallback keeps
// `npm run dev` working out of the box, but production must set AUTH_SECRET.
const secret = () => process.env.AUTH_SECRET || 'daily-check-dev-only-secret'

const sign = (payload) =>
  crypto.createHmac('sha256', secret()).update(payload).digest('base64url')

export function issueToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + TOKEN_TTL_MS })
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null

  const expected = sign(payload)
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length) return null
  if (!crypto.timingSafeEqual(given, wanted)) return null

  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (!data?.exp || data.exp < Date.now()) return null
  if (!ROLES.includes(data.role)) return null
  return data
}

async function sectionSummary(Student) {
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
  return { grades, total, today: todayIso() }
}

export function buildAuthRouter({ Student, Section }) {
  const router = express.Router()

  // Public: the sign-in screen needs the section list before it has a token.
  router.get('/sections', async (req, res, next) => {
    try {
      res.json(await sectionSummary(Student))
    } catch (error) {
      next(error)
    }
  })

  router.post('/login', async (req, res, next) => {
    try {
      const { role, email, password, grade, section } = req.body || {}

      if (!ROLES.includes(role)) throw httpError(400, 'Choose a valid sign-in type.')
      if (!String(email || '').trim()) throw httpError(400, 'Enter your email address.')
      if (!password) throw httpError(400, 'Enter your password.')

      const demoPassword = process.env.DEMO_PASSWORD || 'demo1234'
      if (String(password) !== demoPassword) {
        throw httpError(401, 'Incorrect email or password.')
      }

      const user = {
        role,
        label: ROLE_LABELS[role],
        email: String(email).trim(),
        grade: null,
        section: null,
        sectionLabel: null,
        name: null,
      }

      if (SECTION_ROLES.includes(role)) {
        const wantedGrade = grade === 'PU2' ? 'PU2' : grade === 'PU1' ? 'PU1' : null
        const wantedSection = String(section || '').trim().toUpperCase()
        if (!wantedGrade || !/^[A-Z]{1,2}$/.test(wantedSection)) {
          throw httpError(400, 'Pick the section you are assigned to.')
        }

        if (role === 'teacher') {
          const doc = await Section.findOne({
            grade: wantedGrade,
            section: wantedSection,
          }).lean()
          if (!doc) throw httpError(404, 'That section has no class teacher on record.')
          user.name = doc.teacher
        } else {
          const leader = await Student.findOne({
            grade: wantedGrade,
            section: wantedSection,
          })
            .sort({ rollNo: 1 })
            .lean()
          if (!leader) throw httpError(404, 'That section is not on the roster.')
          user.name = leader.name
        }

        user.grade = wantedGrade
        user.section = wantedSection
        user.sectionLabel = `${wantedGrade === 'PU1' ? '11' : '12'}${wantedSection}`
      }

      res.json({ token: issueToken(user), user })
    } catch (error) {
      next(error)
    }
  })

  return router
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const user = verifyToken(token)
  if (!user) {
    res.status(401).json({ error: 'Your session is missing or has expired. Sign in again.' })
    return
  }
  req.user = user
  next()
}

// Role boundaries. Admins see everything; every other role is confined to the
// screens it actually uses.
export function authorize(req, res, next) {
  const role = req.user?.role
  if (role === 'admin') {
    next()
    return
  }

  const path = req.path
  const allowed =
    (role === 'teacher' && path.startsWith('/teacher/')) ||
    (role === 'transport' && path.startsWith('/transport/')) ||
    (role === 'leader' &&
      (path.startsWith('/leader/') ||
        path === '/inbox' ||
        /^\/inbox\/[0-9a-f]{24}\/acknowledge$/i.test(path))) ||
    (role === 'gate' &&
      (path.startsWith('/gate/') ||
        path === '/students/search' ||
        /^\/students\/[A-Za-z0-9_-]+$/.test(path)))

  if (!allowed) {
    res.status(403).json({ error: 'Your role does not have access to that.' })
    return
  }
  next()
}

// Teachers and leaders can only ever act on their own section, regardless of
// what the browser sends.
export function scopeToUser(req, res, next) {
  const { role, grade, section } = req.user || {}
  if (role === 'teacher' || role === 'leader') {
    if (req.query && typeof req.query === 'object') {
      req.query.grade = grade
      req.query.section = section
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.grade = grade
      req.body.section = section
    }
  }
  next()
}
