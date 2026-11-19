import mongoose from 'mongoose'

// Single settings document (key: 'main') holding the editable fixed lists and
// bus cut-off times.
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'main' },
    exitReasons: { type: [String], default: [] },
    entrySubjects: { type: [String], default: [] },
    busCutoff: { type: String, default: '08:20' },
    routeCutoffs: { type: Map, of: String, default: {} },
  },
  { timestamps: true }
)

export default mongoose.model('Settings', settingsSchema)
