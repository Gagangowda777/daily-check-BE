import mongoose from 'mongoose'

// One row per section with its assigned class teacher (CC).
const sectionSchema = new mongoose.Schema(
  {
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    teacher: { type: String, required: true },
  },
  { timestamps: true }
)

sectionSchema.index({ grade: 1, section: 1 }, { unique: true })

export default mongoose.model('Section', sectionSchema)
