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
  },
  { timestamps: true }
)

entrySectionSchema.index({ date: 1, grade: 1, section: 1 }, { unique: true })

export default mongoose.model('EntrySection', entrySectionSchema)
