import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import { connectDb, isConnected } from './src/db.js'
import Student from './src/models/Student.js'
import DailyRecord from './src/models/DailyRecord.js'
import BusLog from './src/models/BusLog.js'
import EntrySection from './src/models/EntrySection.js'
import LeaderMessage from './src/models/LeaderMessage.js'
import LeaderNote from './src/models/LeaderNote.js'
import TeacherNotice from './src/models/TeacherNotice.js'
import Section from './src/models/Section.js'
import Settings from './src/models/Settings.js'
import AuditLog from './src/models/AuditLog.js'
import GateLog from './src/models/GateLog.js'
import DailyNote from './src/models/DailyNote.js'
import InboxMessage from './src/models/InboxMessage.js'
import { buildRecordsRouter } from './src/routes.js'
import {
  buildAuthRouter,
  authorize,
  requireAuth,
  scopeToUser,
} from './src/auth.js'
import { ensureDay } from './src/day.js'
import { todayIso } from './src/defaults.js'

const app = express()

// The SPA talks to the API through the Vite proxy in development, so only the
// dev/preview origins are allowed by default. Set CORS_ORIGINS to add others.
const origins = (
  process.env.CORS_ORIGINS ||
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// Entries are literal origins, but `*` is allowed inside one so Vercel preview
// URLs (every deployment gets a new subdomain) can be covered in one rule:
//   https://*.vercel.app
const escapePart = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const originPatterns = origins.map(
  (rule) => new RegExp(`^${rule.split('*').map(escapePart).join('[^.]+')}$`)
)

const originAllowed = (origin) => originPatterns.some((pattern) => pattern.test(origin))

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: curl, health checks, same-origin server calls.
      if (!origin) {
        callback(null, true)
        return
      }
      callback(null, originAllowed(origin))
    },
  })
)
app.use(express.json({ limit: '1mb' }))

// Hosts like Render inject a real PORT. The desktop runner injects PORT=0,
// which must not win, and the local .env uses API_PORT.
const injected = Number(process.env.PORT)
const PORT =
  Number.isFinite(injected) && injected > 0 ? injected : Number(process.env.API_PORT) || 4000

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: isConnected() ? 'connected' : 'disconnected' })
})

// Every data route needs the database, so fail clearly instead of hanging.
// Sign-in is behind the same guard because it reads the roster.
app.use('/api', (req, res, next) => {
  if (!isConnected()) {
    res.status(503).json({ error: 'Database not connected yet. Check the API log.' })
    return
  }
  next()
})

app.use('/api/auth', buildAuthRouter({ Student, Section }))

// Everything below requires a signed session, then a role and section check.
app.use('/api', requireAuth)
app.use('/api', authorize)
app.use('/api', scopeToUser)

app.use(
  '/api',
  buildRecordsRouter({
    Student,
    DailyRecord,
    BusLog,
    EntrySection,
    LeaderMessage,
    LeaderNote,
    TeacherNotice,
    Section,
    Settings,
    AuditLog,
    GateLog,
    DailyNote,
    InboxMessage,
  })
)

app.use((error, req, res, next) => {
  const status = error.status || 500
  if (status >= 500) console.error('[api]', error.message)
  res.status(status).json({ error: error.message || 'Unexpected server error' })
})

async function start() {
  try {
    await connectDb()
    console.log('[api] connected to MongoDB Atlas')
  } catch (error) {
    console.error('[api] MongoDB connection failed:', error.message)
  }

  if (isConnected()) {
    const students = await Student.estimatedDocumentCount()
    if (students === 0) {
      console.warn('[api] roster is empty — run `npm run seed`')
    } else {
      // Roll the day forward in the background so the first screen is ready.
      ensureDay({ Student, DailyRecord, BusLog }, todayIso()).catch((error) =>
        console.error('[api] could not prepare today:', error.message)
      )
    }
  }

  app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`))
}

start()

process.on('SIGINT', async () => {
  await mongoose.disconnect()
  process.exit(0)
})
