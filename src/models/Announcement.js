import mongoose from 'mongoose'

// A photo posted from an announcement screen. The image itself lives in
// Cloudinary; only the address and who posted it are kept here.
const announcementSchema = new mongoose.Schema(
  {
    caption: { type: String, default: '', trim: true },
    photoUrl: { type: String, required: true },
    photoPublicId: { type: String, required: true },
    authorRole: {
      type: String,
      required: true,
      enum: ['admin', 'superadmin', 'teacher', 'leader'],
    },
    authorName: { type: String, required: true },
    authorEmail: { type: String, default: null },
    context: { type: String, default: null }, // e.g. "11A · Class Leader"
    // Who has opened the photo, as "role:email" so one dashboard opening it
    // never marks it seen for another.
    viewedBy: { type: [String], default: [] },
  },
  { timestamps: true }
)

announcementSchema.index({ createdAt: -1 })

export default mongoose.model('Announcement', announcementSchema)
