import mongoose from 'mongoose'

// One row per section per day, mirroring the workbook's "3. CC NC Digital"
// sheet: the number of NCs updated in NE for that section that day.
const sectionNcSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },
    count: { type: Number, default: 0, min: 0 },
    students: { type: [String], default: [] }, // Roll numbers or list of students who got NC
    updatedInNe: { type: Boolean, default: false },
    author: { type: String, default: 'Coordinator' },
  },
  { timestamps: true }
)

sectionNcSchema.index({ date: 1, grade: 1, section: 1 }, { unique: true })

export default mongoose.model('SectionNc', sectionNcSchema)
