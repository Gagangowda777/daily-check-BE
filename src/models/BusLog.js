import mongoose from 'mongoose'

const busLogSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    route: { type: String, required: true }, // R1 … R27
    arrivalTime: { type: String, default: null }, // HH:MM, null = not arrived
    scheduledTime: { type: String, default: null }, // HH:MM route timetable
    late: { type: Boolean, default: false },
    affectedStudents: { type: Number, default: 0 },
    markedAt: { type: String, default: null }, // HH:MM when the desk logged it
    // Manual override of the computed Late status; always carries a reason.
    overrideLate: { type: Boolean, default: null },
    overrideReason: { type: String, default: null },
    overrideAt: { type: String, default: null },
  },
  { timestamps: true }
)

busLogSchema.index({ date: 1, route: 1 }, { unique: true })

export default mongoose.model('BusLog', busLogSchema)
