import mongoose from 'mongoose'

let connection = null

export function isConnected() {
  return mongoose.connection.readyState === 1
}

export function connectDb() {
  if (!connection) {
    const uri = process.env.MONGODB_URI
    if (!uri) throw new Error('MONGODB_URI is missing from backend/.env')

    connection = mongoose
      .connect(uri, {
        dbName: process.env.MONGODB_DB || 'dailycheck',
        serverSelectionTimeoutMS: 12000,
      })
      .catch((error) => {
        connection = null
        throw error
      })
  }

  return connection
}
