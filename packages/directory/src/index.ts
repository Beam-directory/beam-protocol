import { createDatabase, cleanExpiredNonces } from './db.js'
import { startServer } from './server.js'

const PORT = parseInt(process.env['PORT'] ?? '3000', 10)
const DB_PATH = process.env['DB_PATH'] ?? './beam-directory.db'

const db = createDatabase(DB_PATH)

console.log(`Using database: ${DB_PATH}`)

// Clean expired nonces every 10 minutes to keep the nonces table lean
const nonceCleanupInterval = setInterval(() => {
  try {
    cleanExpiredNonces(db)
  } catch (err) {
    console.error('Failed to clean expired nonces:', err)
  }
}, 10 * 60 * 1000)

const server = startServer(db, PORT)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\nReceived ${signal}, shutting down gracefully...`)
  clearInterval(nonceCleanupInterval)
  server.close(() => {
    try {
      db.close()
      console.log('Database closed. Goodbye.')
    } catch (err) {
      console.error('Error closing database:', err)
    }
    process.exit(0)
  })

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit.')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
