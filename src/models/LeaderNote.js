import mongoose from 'mongoose'

// A short note the class leader sends up to the class teacher (attendance
// issue, exit follow-up, general remark). The teacher sees it on their
// overview and marks it read.
const leaderNoteSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    author: { type: String, required: true }, // class leader's name
    kind: {
      type: String,
      required: true,
      enum: ['attendance', 'exit', 'general'],
      default: 'general',
    },
    body: { type: String, required: true, trim: true, maxlength: 600 },
    sentAt: { type: String, required: true }, // HH:MM
    readAt: { type: String, default: null }, // HH:MM, null = unread
    readBy: { type: String, default: null },
  },
  { timestamps: true }
)

leaderNoteSchema.index({ date: 1, grade: 1, section: 1 })

export default mongoose.model('LeaderNote', leaderNoteSchema)
