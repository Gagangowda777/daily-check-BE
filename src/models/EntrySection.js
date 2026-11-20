import mongoose from 'mongoose'

// Whether each section submitted its entry-restriction check, and when.
const entrySectionSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    submittedAt: { type: String, default: null }, // HH:MM, null = not submitted
    // Daily NC tracker entered by the class teacher.
    ncCount: { type: Number, default: null },
    updatedInNe: { type: Boolean, default: false },
    // The class teacher announced the admin's uploaded rows in class and then
    // acknowledged receiving them.
    adminAnnouncedAt: { type: String, default: null },
    adminAnnouncedBy: { type: String, default: null },
    adminAnnouncedCount: { type: Number, default: 0 },
    adminAcknowledgedAt: { type: String, default: null },
    adminAcknowledgedBy: { type: String, default: null },
    adminAcknowledgedCount: { type: Number, default: 0 },
    // Super admin's final sign-off on the acknowledged upload.
    finalStatus: {
      type: String,
      required: true,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    finalAt: { type: String, default: null },
    finalBy: { type: String, default: null },
    finalNote: { type: String, default: null },
    // NCs the super admin chose to deduct when approving this day.
    ncDeducted: { type: Number, default: 0 },
    ncDeductedAt: { type: String, default: null },
  },
  { timestamps: true }
)

entrySectionSchema.index({ date: 1, grade: 1, section: 1 }, { unique: true })

export default mongoose.model('EntrySection', entrySectionSchema)
