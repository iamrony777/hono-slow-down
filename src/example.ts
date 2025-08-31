import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { queueMiddleware } from 'hono-slow-down'
import { requestId } from 'hono/request-id'
const app = new Hono()

app.use('*', logger())
app.use('*', requestId({
  headerName: 'X-Request-ID'
}))

const queueMiddlewareInstance = queueMiddleware({
  queueLimit: 0,
  concurrency: 250,
  timeout: 5000,
  exclude: ['/slow'],
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
})

// Configure queue middleware with concurrent processing
// Set to 0 for unlimited queue
app.use('*', queueMiddlewareInstance)

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

// Example endpoint that simulates slow processing
app.get('/slow', async (c) => {
  // Simulate slow processing
  await new Promise(resolve => setTimeout(resolve, 4000))
  return c.json({ message: 'Slow endpoint processed', timestamp: new Date().toISOString() })
})

// Example endpoint to test queue behavior
app.get('/test-queue', async (c) => {
  const delay = Math.random() * 4000 + 1000 // Random delay between 1-4 seconds
  await new Promise(resolve => setTimeout(resolve, delay))
  return c.json({
    message: 'Request processed after queue',
    processedAt: new Date().toISOString(),
    delay: Math.round(delay)
  })
})

export default {
  port: 3000,
  fetch: app.fetch,
  idleTimeout: 255
}
