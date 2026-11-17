import mongoose from 'mongoose'

const gateLogSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:MM
    timestamp: { type: Date, required: true, default: () => new Date(), index: true },
    rollNo: { type: String, required: true, index: true },
    name: { type: String, required: true },
    grade: { type: String, required: true },
    section: { type: String, required: true },
    busRoute: { type: String, default: null },
    type: {
      type: String,
      required: true,
      enum: ['exit', 'entry', 'blocked_attempt'],
      default: 'exit',
    },
    status: {
      type: String,
      required: true,
      enum: ['authorized', 'blocked', 'regular', 'late_entry', 'handover'],
      default: 'authorized',
    },
    passDetails: { type: String, default: null },
    remarks: { type: String, default: null },
    loggedBy: { type: String, default: 'Gate Security' },
  },
  { timestamps: true }
)

gateLogSchema.index({ date: 1, createdAt: -1 })
gateLogSchema.index({ rollNo: 1, date: -1 })

export default mongoose.model('GateLog', gateLogSchema)
