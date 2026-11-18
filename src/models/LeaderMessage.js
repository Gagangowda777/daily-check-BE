import mongoose from 'mongoose'

// Broadcasts land in the class leader inbox. Opening the inbox is what marks
// a message read, so no acknowledge step is needed.
const leaderMessageSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    title: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['update', 'announcement', 'authorized-exit', 'broadcast'],
      default: 'broadcast',
    },
    target: { type: String, default: 'Whole School' },
    sender: { type: String, default: null }, // who sent it
    sentBy: { type: String, default: null }, // signed-in admin account email
    batchId: { type: String, default: null, index: true }, // one broadcast across sections
    body: { type: String, default: null }, // message text
    // Authorized exits name the students released and when.
    students: { type: [{ rollNo: String, name: String }], default: [] },
    exitTime: { type: String, default: null }, // HH:MM
    sentAt: { type: String, required: true }, // HH:MM
    seenAt: { type: String, default: null }, // HH:MM[:SS] when the leader opened it
    seenBy: { type: String, default: null }, // class leader who read it
    // Older rows acknowledged explicitly; kept so their history still counts
    // as read in reports.
    acknowledgedAt: { type: String, default: null }, // HH:MM[:SS]
    acknowledgedBy: { type: String, default: null },
  },
  { timestamps: true }
)

leaderMessageSchema.index({ date: 1, grade: 1, section: 1 })

export default mongoose.model('LeaderMessage', leaderMessageSchema)
