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
import Section from './src/models/Section.js'
import Settings from './src/models/Settings.js'
import AuditLog from './src/models/AuditLog.js'
import GateLog from './src/models/GateLog.js'
import DailyNote from './src/models/DailyNote.js'
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

app.use(cors({ origin: origins }))
app.use(express.json({ limit: '1mb' }))

// Hosts like Render inject PORT; the local .env uses API_PORT, and the desktop
// runner injects its own PORT, so both are honoured.
const PORT = Number(process.env.PORT || process.env.API_PORT || 4000)

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
    Section,
    Settings,
    AuditLog,
    GateLog,
    DailyNote,
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
