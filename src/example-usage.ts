import { Hono } from 'hono'
import { queueMiddleware, RequestQueue } from './queue-middleware'

const app = new Hono()

// Example 1: Basic queue with limit
app.use('/api/*', queueMiddleware({
  queueLimit: 3, // Allow max 3 requests in queue
  timeout: 5000,  // 5 second timeout
}))

// Example 2: Unlimited queue (queueLimit: 0)
const unlimitedApp = new Hono()
unlimitedApp.use('*', queueMiddleware({
  queueLimit: 0, // Unlimited queue
  timeout: 30000, // 30 second timeout
  onQueueTimeout: (c) => {
    return c.json({ 
      error: 'Request took too long to process',
      code: 'QUEUE_TIMEOUT'
    }, 408)
  }
}))

// Example 3: Advanced configuration with custom handlers
const advancedApp = new Hono()
advancedApp.use('*', queueMiddleware({
  queueLimit: 10,
  timeout: 15000,
  onQueueFull: (c) => {
    return c.json({
      error: 'Server is currently overloaded',
      message: 'Please try again in a few moments',
      retryAfter: 30
    }, 429)
  },
  onQueueTimeout: (c) => {
    return c.json({
      error: 'Your request timed out while waiting to be processed',
      code: 'PROCESSING_TIMEOUT'
    }, 408)
  }
}))

// Example 4: Queue monitoring endpoint
const monitoringApp = new Hono()
const queue = new RequestQueue({ queueLimit: 5 })

// Custom middleware using the RequestQueue directly
monitoringApp.use('/api/*', async (c, next) => {
  return await queue.enqueue(c, next)
})

// Queue status endpoint
monitoringApp.get('/queue/status', (c) => {
  return c.json({
    queueLength: queue.getQueueLength(),
    isProcessing: queue.isProcessing(),
    queuedRequests: queue.getQueuedRequests()
  })
})

// Test endpoints
app.get('/api/fast', (c) => {
  return c.json({ message: 'Fast response', timestamp: Date.now() })
})

app.get('/api/slow', async (c) => {
  await new Promise(resolve => setTimeout(resolve, 3000))
  return c.json({ message: 'Slow response', timestamp: Date.now() })
})

export { app, unlimitedApp, advancedApp, monitoringApp }
