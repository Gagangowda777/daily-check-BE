import mongoose from 'mongoose'

const studentSchema = new mongoose.Schema(
  {
    rollNo: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    grade: { type: String, required: true, enum: ['PU1', 'PU2'], index: true },
    section: { type: String, required: true, index: true },
    busRoute: { type: String, default: null },
  },
  { timestamps: true }
)

studentSchema.index({ grade: 1, section: 1 })

export default mongoose.model('Student', studentSchema)
