import type { Context, Next } from 'hono'
import createDebug from 'debug'

const debug = {
  main: createDebug('h-queue:main'),
  enqueue: createDebug('h-queue:enqueue'),
  process: createDebug('h-queue:process'),
  timeout: createDebug('h-queue:timeout'),
  middleware: createDebug('h-queue:middleware')
}

interface QueuedRequest {
  id: string
  timestamp: number
  resolve: (value: any) => void
  reject: (error: any) => void
  context: Context
  next: Next
}

interface QueueMiddlewareOptions {
  queueLimit: number // 0 means unlimited
  onQueueFull?: (context: Context) => Response | Promise<Response>
  onQueueTimeout?: (context: Context) => Response | Promise<Response>
  timeout?: number // Request timeout in milliseconds (optional)
}

class RequestQueue {
  private activeQueue: QueuedRequest[] = []
  private processing = false
  private readonly options: QueueMiddlewareOptions

  constructor(options: QueueMiddlewareOptions) {
    this.options = {
      timeout: 30000, // Default 30 seconds timeout
      ...options
    }
    debug.main('RequestQueue initialized with options: queueLimit=%d, timeout=%d', 
      this.options.queueLimit, this.options.timeout)
  }

  async enqueue(context: Context, next: Next): Promise<Response> {
    const requestId = context.get('requestId') as string
    debug.enqueue('Request %s attempting to join queue (current length: %d)', requestId, this.activeQueue.length)
    
    // Check queue limit
    if (this.options.queueLimit > 0 && this.activeQueue.length >= this.options.queueLimit) {
      debug.enqueue('Request %s rejected - queue full (limit: %d)', requestId, this.options.queueLimit)
      if (this.options.onQueueFull) {
        return await this.options.onQueueFull(context)
      }
      return new Response('Queue is full', { status: 429 })
    }

    return new Promise<Response>((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        id: requestId,
        timestamp: Date.now(),
        resolve,
        reject,
        context,
        next
      }

      this.activeQueue.push(queuedRequest)
      debug.enqueue('Request %s added to queue (position: %d)', requestId, this.activeQueue.length)
      
      // Set timeout if specified
      if (this.options.timeout && this.options.timeout > 0) {
        debug.enqueue('Request %s timeout set for %dms', requestId, this.options.timeout)
        setTimeout(() => {
          this.timeoutRequest(requestId)
        }, this.options.timeout)
      }

      // Start processing if not already processing
      if (!this.processing) {
        debug.enqueue('Starting queue processing for request %s', requestId)
        this.processQueue()
      } else {
        debug.enqueue('Queue already processing, request %s will wait', requestId)
      }
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.activeQueue.length === 0) {
      debug.process('Process queue called but %s', 
        this.processing ? 'already processing' : 'queue is empty')
      return
    }

    this.processing = true
    debug.process('Starting queue processing with %d requests', this.activeQueue.length)

    while (this.activeQueue.length > 0) {
      const request = this.activeQueue.shift()
      if (!request) break

      debug.process('Processing request %s (remaining in queue: %d)', request.id, this.activeQueue.length)
      const startTime = Date.now()

      try {
        // Process the request
        await request.next()
        
        // If we get here, the request was successful
        // The response should already be set in the context
        const processingTime = Date.now() - startTime
        debug.process('Request %s completed successfully in %dms', request.id, processingTime)
        request.resolve(request.context.res)
      } catch (error) {
        // Handle any errors during request processing
        const processingTime = Date.now() - startTime
        debug.process('Request %s failed after %dms: %O', request.id, processingTime, error)
        request.reject(error)
      }
    }

    this.processing = false
    debug.process('Queue processing completed, queue is now empty')
  }

  private async timeoutRequest(requestId: string): Promise<void> {
    const requestIndex = this.activeQueue.findIndex(req => req.id === requestId)
    if (requestIndex === -1) {
      debug.timeout('Request %s timeout triggered but already processed', requestId)
      return // Request already processed
    }

    debug.timeout('Request %s timed out, removing from queue', requestId)
    const request = this.activeQueue[requestIndex]
    this.activeQueue.splice(requestIndex, 1)

    if (this.options.onQueueTimeout) {
      try {
        debug.timeout('Calling custom timeout handler for request %s', requestId)
        const response = await this.options.onQueueTimeout(request.context)
        request.resolve(response)
      } catch (error: any) {
        debug.timeout('Custom timeout handler failed for request %s: %O', requestId, error)
        request.reject(error)
      }
    } else {
      debug.timeout('Using default timeout response for request %s', requestId)
      request.resolve(new Response('Request timeout', { status: 408 }))
    }
  }

  // Public methods for monitoring
  getQueueLength(): number {
    return this.activeQueue.length
  }

  isProcessing(): boolean {
    return this.processing
  }

  getQueuedRequests(): Array<{ id: string; timestamp: number }> {
    return this.activeQueue.map(req => ({
      id: req.id,
      timestamp: req.timestamp
    }))
  }
}

// Middleware factory function
export function queueMiddleware(options: QueueMiddlewareOptions) {
  debug.middleware('Creating queue middleware with options: %O', options)
  const queue = new RequestQueue(options)

  return async (context: Context, next: Next) => {
    const requestId = context.get('requestId') as string
    debug.middleware('Middleware invoked for request %s', requestId)
    return await queue.enqueue(context, next)
  }
}

// Export the RequestQueue class for advanced usage
export { RequestQueue, type QueueMiddlewareOptions, type QueuedRequest }
