import crypto from 'node:crypto'

// One signer for every image the API stores in Cloudinary: the day snapshots
// taken before the 30-day purge, and the photos posted on the announcement
// screens.

export const cloudinaryConfig = () => {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || 'odppaola').trim()
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '312712547887488').trim()
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || 'QdUXPz0M7szMhfxdDh9C3ajG64o').trim()
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null
}

const EXTENSION = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
}

export async function uploadImage(
  buffer,
  { folder, publicId, mime = 'image/jpeg', overwrite = false } = {}
) {
  const config = cloudinaryConfig()
  if (!config) {
    const missing = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
      .filter((key) => !String(process.env[key] || '').trim())
      .join(', ')
    throw new Error(`Cloudinary credentials are not configured (missing: ${missing}).`)
  }

  const id = publicId || crypto.randomUUID()
  const timestamp = Math.round(Date.now() / 1000)

  // Cloudinary signs every parameter except file, api_key and signature, in
  // alphabetical order.
  const params = { folder, public_id: id, timestamp }
  if (overwrite) params.overwrite = true
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  const signature = crypto.createHash('sha1').update(`${toSign}${config.apiSecret}`).digest('hex')

  const form = new FormData()
  form.append(
    'file',
    new Blob([buffer], { type: mime }),
    `${id}.${EXTENSION[mime] || 'jpg'}`
  )
  form.append('api_key', config.apiKey)
  form.append('timestamp', String(timestamp))
  form.append('folder', folder)
  form.append('public_id', id)
  if (overwrite) form.append('overwrite', 'true')
  form.append('signature', signature)

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    { method: 'POST', body: form }
  )
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error?.message || `Cloudinary rejected the upload (${response.status})`)
  }

  return { url: payload.secure_url, publicId: payload.public_id, bytes: buffer.length }
}
