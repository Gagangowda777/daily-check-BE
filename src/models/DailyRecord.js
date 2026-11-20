import mongoose from 'mongoose'

// Grade, section and roll number are denormalised onto each day's row so the
// dashboard is a single indexed read instead of a join across the roster.
const dailyRecordSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    rollNo: { type: String, required: true, index: true },
    name: { type: String, required: true },
    grade: { type: String, required: true, enum: ['PU1', 'PU2'] },
    section: { type: String, required: true },

    attendance: {
      type: String,
      required: true,
      enum: ['present', 'late', 'absent'],
      default: 'present',
    },
    busRoute: { type: String, default: null },
    busLate: { type: Boolean, default: false },
    // A delayed arrival the class teacher marked with an NC. A student can
    // carry more than one NC in a day, so ncCount holds how many.
    ncFlag: { type: Boolean, default: false },
    ncCount: { type: Number, default: 0, min: 0 },
    ncReason: { type: String, default: null },
    ncAt: { type: String, default: null },
    // Cleared when the transport desk unticks a student who is not riding.
    rider: { type: Boolean, default: true },

    restrictionType: { type: String, enum: ['exit', 'entry', null], default: null },
    restrictionReason: { type: String, default: null },
    // Exit restrictions run to a date or stay until they are resolved.
    restrictionEndDate: { type: String, default: null },
    restrictionUntilResolved: { type: Boolean, default: false },
    // Entry restrictions list the subjects whose NOC is still pending.
    pendingSubjects: { type: [String], default: [] },
    // Sent to administration and waiting on an outcome.
    handover: { type: Boolean, default: false },
    handoverAt: { type: String, default: null }, // HH:MM it reached the desk
    handoverOutcome: { type: String, default: null }, // cleared | sent-home | parent-called
    resolutionNote: { type: String, default: null },
    excusedApprover: { type: String, default: null },
    // Who acknowledged the restriction, and when.
    acknowledgedBy: { type: String, default: null },
    acknowledgedAt: { type: String, default: null },
    // The class teacher ticking this uploaded row off student by student on the
    // Admin data screen, separately from the whole-upload acknowledgement.
    uploadAcknowledgedBy: { type: String, default: null },
    uploadAcknowledgedAt: { type: String, default: null },
    resolutionStatus: {
      type: String,
      required: true,
      enum: ['none', 'pending', 'acknowledged', 'absent', 'excused', 'resolved'],
      default: 'none',
    },
    resolvedOn: { type: String, default: null },
    gateExitTime: { type: String, default: null },
    gateVerifiedBy: { type: String, default: null },
  },
  { timestamps: true }
)

dailyRecordSchema.index({ date: 1, grade: 1, section: 1 })
dailyRecordSchema.index({ date: 1, student: 1 }, { unique: true })
dailyRecordSchema.index({ rollNo: 1, date: -1 })
dailyRecordSchema.index({ resolutionStatus: 1 })

export default mongoose.model('DailyRecord', dailyRecordSchema)
