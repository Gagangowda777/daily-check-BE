import mongoose from 'mongoose'

// Admin / coordinator broadcasts addressed to a section. The matching
// LeaderMessage row feeds the class leader inbox; this row feeds the class
// teacher dashboard so the same message reaches both audiences.
const teacherNoticeSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ['update', 'announcement', 'authorized-exit', 'broadcast'],
      default: 'broadcast',
    },
    target: { type: String, default: 'Whole School' },
    sender: { type: String, default: 'Admin / Coordinator' },
    sentAt: { type: String, required: true }, // HH:MM
    readAt: { type: String, default: null }, // HH:MM, null = unread
    readBy: { type: String, default: null },
  },
  { timestamps: true }
)

teacherNoticeSchema.index({ date: 1, grade: 1, section: 1 })
teacherNoticeSchema.index({ grade: 1, section: 1, readAt: 1 })

export default mongoose.model('TeacherNotice', teacherNoticeSchema)
