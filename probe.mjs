import './src/env.js'
import mongoose from 'mongoose'

const uri = process.env.MONGODB_URI
console.log('uri host:', uri ? uri.replace(/\/\/[^@]*@/, '//***@') : '(missing)')

try {
  await mongoose.connect(uri, { dbName: 'dailycheck', serverSelectionTimeoutMS: 12000 })
  const ping = await mongoose.connection.db.admin().ping()
  console.log('PING:', JSON.stringify(ping))
  const cols = await mongoose.connection.db.listCollections().toArray()
  console.log('collections:', cols.map((c) => c.name).join(', ') || '(none)')
  await mongoose.disconnect()
  process.exit(0)
} catch (error) {
  console.log('CONNECT_FAILED:', error.message)
  process.exit(1)
}
