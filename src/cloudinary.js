import crypto from 'node:crypto'

// One signer for every image the API stores in Cloudinary: the day snapshots
// taken before the 30-day purge, and the photos posted on the announcement
// screens.

export const cloudinaryConfig = () => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
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
  if (!config) throw new Error('Cloudinary credentials are not configured.')

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
