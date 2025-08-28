import type { Context, Next } from 'hono'
import createDebug from 'debug'
import pLimit from 'p-limit'

const debug = {
  main: createDebug('h-queue:main'),
  enqueue: createDebug('h-queue:enqueue'),
  process: createDebug('h-queue:process'),
  timeout: createDebug('h-queue:timeout'),
  middleware: createDebug('h-queue:middleware')
}

/**
 * Represents a request waiting in the queue
 */
interface QueuedRequest {
  /** Unique identifier for the request (from X-Request-ID header) */
  id: string
  /** Unix timestamp when the request was added to the queue */
  timestamp: number
  /** The Hono context object for this request */
  context: Context
  /** The next middleware function to call */
  next: Next
}

/**
 * Configuration options for the queue middleware
 */
interface QueueMiddlewareOptions {
  /** 
   * Maximum number of requests that can wait in the queue.
   * Set to 0 for unlimited queue size.
   */
  queueLimit: number

  /** 
   * How many requests can be processed simultaneously.
   * Defaults to 1 (sequential processing).
   */
  concurrency?: number

  /** 
   * Custom handler called when the queue is full.
   * Should return a Response object (typically with status 429).
   */
  onQueueFull?: (context: Context) => Response | Promise<Response>

  /** 
   * Custom handler called when a request times out while waiting.
   * Should return a Response object (typically with status 408).
   */
  onQueueTimeout?: (context: Context) => Response | Promise<Response>

  /** 
   * How long a request can wait in the queue before timing out (in milliseconds).
   * Defaults to 30000ms (30 seconds). Set to 0 to disable timeouts.
   */
  timeout?: number

  /**
   * Array of path patterns to exclude from the queue middleware.
   * Can be exact paths or patterns with wildcards (e.g., '/api/abc', '/api/health/*').
   * Requests matching these paths will bypass the queue entirely.
   */
  exclude?: string[]
}

/**
 * Manages a queue of incoming HTTP requests with configurable concurrency and timeout handling.
 * Uses p-limit to efficiently control concurrent request processing.
 */
class RequestQueue {
  private waitingQueue: QueuedRequest[] = []
  private readonly options: QueueMiddlewareOptions
  private readonly limit: ReturnType<typeof pLimit>
  private timeoutMap = new Map<string, NodeJS.Timeout>()

  constructor(options: QueueMiddlewareOptions) {
    this.options = {
      timeout: 30000,
      concurrency: 1,
      ...options
    }

    this.limit = pLimit(this.options.concurrency!)

    debug.main('RequestQueue initialized with options: queueLimit=%d, concurrency=%d, timeout=%d',
      this.options.queueLimit, this.options.concurrency, this.options.timeout)
  }

  /**
   * Adds a request to the queue and processes it when capacity is available.
   * 
   * @param context - The Hono context for the current request
   * @param next - The next middleware in the chain
   * @returns The response after processing or an error response if rejected/timed out
   */
  async enqueue(context: Context, next: Next): Promise<Response> {
    const requestId = context.get('requestId') as string

    if (!requestId) {
      console.error(`\n[hono-slow-down] No request-id found, add this middleware before queueMiddleware:\n\nimport { requestId } from 'hono/request-id'\napp.use('*', requestId());\n`)
      throw new Error('Request ID is required for queue middleware')
    }

    debug.enqueue('Request %s attempting to join queue (waiting: %d, active: %d/%d)',
      requestId, this.waitingQueue.length, this.limit.activeCount, this.options.concurrency)

    if (this.options.queueLimit > 0 && this.waitingQueue.length >= this.options.queueLimit) {
      debug.enqueue('Request %s rejected - queue full (limit: %d)', requestId, this.options.queueLimit)
      if (this.options.onQueueFull) {
        return await this.options.onQueueFull(context)
      }
      return new Response('Queue is full', { status: 429 })
    }

    const queuedRequest: QueuedRequest = {
      id: requestId,
      timestamp: Date.now(),
      context,
      next
    }

    this.waitingQueue.push(queuedRequest)
    debug.enqueue('Request %s added to waiting queue (position: %d)', requestId, this.waitingQueue.length)

    if (this.options.timeout && this.options.timeout > 0) {
      debug.enqueue('Request %s timeout set for %dms', requestId, this.options.timeout)
      const timeoutId = setTimeout(() => {
        this.handleTimeout(requestId)
      }, this.options.timeout)
      this.timeoutMap.set(requestId, timeoutId)
    }

    try {
      const response = await this.limit(async () => {
        const index = this.waitingQueue.findIndex(req => req.id === requestId)
        if (index === -1) {
          debug.process('Request %s no longer in queue (likely timed out)', requestId)
          throw new Error('Request removed from queue')
        }

        this.waitingQueue.splice(index, 1)
        debug.process('Request %s starting processing (waiting: %d, active: %d/%d)',
          requestId, this.waitingQueue.length, this.limit.activeCount, this.options.concurrency)

        const timeoutId = this.timeoutMap.get(requestId)
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.timeoutMap.delete(requestId)
        }

        const startTime = Date.now()
        try {
          await next()

          const processingTime = Date.now() - startTime
          debug.process('Request %s completed successfully in %dms', requestId, processingTime)

          return context.res
        } catch (error) {
          const processingTime = Date.now() - startTime
          debug.process('Request %s failed after %dms: %O', requestId, processingTime, error)
          throw error
        }
      })

      return response
    } catch (error) {
      if (error instanceof Error && error.message === 'Request timed out') {
        if (this.options.onQueueTimeout) {
          return await this.options.onQueueTimeout(context)
        }
        return new Response('Request timeout', { status: 408 })
      }
      throw error
    }
  }

  /**
   * Handles request timeout by removing it from the queue and cleaning up
   */
  private handleTimeout(requestId: string): void {
    debug.timeout('Timeout triggered for request %s', requestId)

    const index = this.waitingQueue.findIndex(req => req.id === requestId)
    if (index !== -1) {
      this.waitingQueue.splice(index, 1)
      debug.timeout('Request %s removed from waiting queue due to timeout', requestId)
    }

    this.timeoutMap.delete(requestId)
  }

  /**
   * Gets the number of requests currently waiting in the queue
   * @returns The number of waiting requests
   */
  getQueueLength(): number {
    return this.waitingQueue.length
  }

  /**
   * Checks if any requests are currently being processed
   * @returns True if requests are being processed, false otherwise
   */
  isProcessing(): boolean {
    return this.limit.activeCount > 0
  }

  /**
   * Gets the number of requests actively being processed
   * @returns The number of active requests
   */
  getProcessingCount(): number {
    return this.limit.activeCount
  }

  /**
   * Gets the number of requests pending execution (queued in p-limit)
   * @returns The number of pending requests
   */
  getPendingCount(): number {
    return this.limit.pendingCount
  }

  /**
   * Gets information about all requests currently waiting in the queue
   * @returns Array of request info with ID and timestamp
   */
  getQueuedRequests(): Array<{ id: string; timestamp: number }> {
    return this.waitingQueue.map(req => ({
      id: req.id,
      timestamp: req.timestamp
    }))
  }
}

/**
 * Creates a Hono middleware that queues and rate-limits incoming requests.
 * 
 * @param options - Configuration for queue behavior
 * @returns Hono middleware function
 * 
 * @example
 * ```typescript
 * app.use('*', queueMiddleware({
 *   queueLimit: 100,     // Max 100 requests waiting
 *   concurrency: 5,      // Process 5 requests at once
 *   timeout: 10000,      // 10 second timeout
 *   onQueueFull: (c) => c.json({ error: 'Server busy' }, 429),
 *   exclude: ['/api/abc', '/api/health/*']  // Exclude specific paths
 * }))
 * ```
 */
export function queueMiddleware(options: QueueMiddlewareOptions) {
  debug.middleware('Creating queue middleware with options: %O', options)
  const queue = new RequestQueue(options)

  return async (context: Context, next: Next) => {
    const requestPath = context.req.path

    if (options.exclude && options.exclude.length > 0) {
      for (const excludePattern of options.exclude) {
        if (excludePattern === requestPath) {
          debug.middleware('Request %s excluded (exact match)', requestPath)
          return await next()
        }

        // Check for wildcard pattern match
        if (excludePattern.includes('*')) {
          const regexPattern = excludePattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
            .replace(/\*/g, '.*') // Convert * to .*
          const regex = new RegExp(`^${regexPattern}$`)

          if (regex.test(requestPath)) {
            debug.middleware('Request %s excluded (pattern match: %s)', requestPath, excludePattern)
            return await next()
          }
        }
      }
    }

    const requestId = context.get('requestId') as string

    if (!requestId) {
      console.error(`\n[hono-slow-down] No request-id found, add this middleware before queueMiddleware:\n\nimport { requestId } from 'hono/request-id'\napp.use('*', requestId());\n`)
      throw new Error('Request ID is required for queue middleware')
    }

    debug.middleware('Middleware invoked for request %s', requestId)
    return await queue.enqueue(context, next)
  }
}

export { RequestQueue, type QueueMiddlewareOptions, type QueuedRequest }