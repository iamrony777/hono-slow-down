import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { queueMiddleware } from './queue-middleware'
import { requestId } from 'hono/request-id'

const app = new Hono()

app.use('*', logger())
app.use('*', requestId({
  headerName: 'X-Request-ID'
}))
// Configure queue middleware with a limit of 5 concurrent requests
// Set to 0 for unlimited queue
app.use('*', queueMiddleware({
  queueLimit: 0, // Change to 0 for unlimited queue
  timeout: 0, // 10 second timeout
  onQueueFull: (c) => {
    return c.json({
      error: 'Server is busy, please try again later',
      queueFull: true
    }, 429)
  },
  onQueueTimeout: (c) => {
    return c.json({
      error: 'Request timed out while waiting in queue',
      timeout: true
    }, 408)
  }
}))

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

// Example endpoint that simulates slow processing
app.get('/slow', async (c) => {
  // Simulate slow processing
  await new Promise(resolve => setTimeout(resolve, 2000))
  return c.json({ message: 'Slow endpoint processed', timestamp: new Date().toISOString() })
})

// Example endpoint to test queue behavior
app.get('/test-queue', async (c) => {
  const delay = Math.random() * 3000 + 1000 // Random delay between 1-4 seconds
  await new Promise(resolve => setTimeout(resolve, delay))
  return c.json({
    message: 'Request processed after queue',
    processedAt: new Date().toISOString(),
    delay: Math.round(delay)
  })
})

export default app
