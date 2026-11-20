import mongoose from 'mongoose'

// One row per day whose Excel-fed data has been purged. The image is the
// snapshot uploaded to Cloudinary just before the rows were deleted.
const dayArchiveSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    url: { type: String, required: true },
    publicId: { type: String, default: null },
    bytes: { type: Number, default: 0 },
    rows: { type: Number, default: 0 },
    counts: {
      exit: { type: Number, default: 0 },
      entry: { type: Number, default: 0 },
      ncSections: { type: Number, default: 0 },
      busRoutes: { type: Number, default: 0 },
    },
    deletedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
)

export default mongoose.model('DayArchive', dayArchiveSchema)
