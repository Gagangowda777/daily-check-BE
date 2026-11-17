import mongoose from 'mongoose'

// Direct messages between dashboards: a class teacher can message the class
// leader, the admin or every desk; a class leader can message the class
// teacher; transport and gate receive admin broadcasts here. Section-scoped
// messages carry grade + section so only that section's inbox sees them.
const inboxMessageSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    fromRole: {
      type: String,
      required: true,
      enum: ['admin', 'teacher', 'leader', 'transport', 'gate'],
    },
    fromName: { type: String, required: true },
    fromEmail: { type: String, default: null },
    fromContext: { type: String, default: null }, // e.g. "11A · Class Teacher"
    toRole: {
      type: String,
      required: true,
      enum: ['ADMIN', 'TEACHER', 'TRANSPORT', 'GATE', 'ALL'],
      index: true,
    },
    grade: { type: String, default: null }, // only for TEACHER / LEADER targets
    section: { type: String, default: null },
    sentAt: { type: String, required: true }, // HH:MM in IST
    readAt: { type: String, default: null }, // HH:MM, null = unread
    readBy: { type: String, default: null },
  },
  { timestamps: true }
)

inboxMessageSchema.index({ date: 1, toRole: 1 })
inboxMessageSchema.index({ date: 1, toRole: 1, grade: 1, section: 1 })

export default mongoose.model('InboxMessage', inboxMessageSchema)
