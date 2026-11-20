import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// Load the API's .env from the backend folder, not from whatever directory the
// process happens to be started in. `node backend/server.js` from the repo root
// then behaves the same as `npm start` inside backend.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(backendRoot, '.env') })
