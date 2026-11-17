import mongoose from 'mongoose'

// Read-only trail of every status change and override.
const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: () => new Date(), index: true },
    actor: { type: String, default: 'Admin / Coordinator' },
    action: { type: String, required: true },
    detail: { type: String, default: '' },
  },
  { timestamps: true }
)

export default mongoose.model('AuditLog', auditLogSchema)
