import mongoose from 'mongoose'

const dailyNoteSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:MM
    rollNo: { type: String, default: null, index: true },
    name: { type: String, default: null },
    grade: { type: String, default: null },
    section: { type: String, default: null },
    category: {
      type: String,
      required: true,
      enum: [
        'exit_restriction',
        'entry_restriction',
        'late_arrival',
        'discipline',
        'medical',
        'parent_call',
        'general',
      ],
      default: 'general',
    },
    content: { type: String, required: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ['active', 'applied', 'resolved', 'archived'],
      default: 'active',
    },
    author: { type: String, default: 'Coordinator' },
    appliedAs: { type: String, default: null },
  },
  { timestamps: true }
)

dailyNoteSchema.index({ date: 1, createdAt: -1 })
dailyNoteSchema.index({ rollNo: 1, date: -1 })

export default mongoose.model('DailyNote', dailyNoteSchema)
