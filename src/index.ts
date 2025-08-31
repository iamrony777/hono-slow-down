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
 * Node in a doubly-linked list for O(1) removal
 */
interface QueueNode {
  id: string
  timestamp: number
  context: Context
  next: Next
  prev: QueueNode | null
  nextNode: QueueNode | null
}

/**
 * Configuration options for the queue middleware
 */
interface QueueMiddlewareOptions {
  /** 
   * Maximum total number of requests allowed in the system (waiting + processing).
   * When this limit is reached, new requests will be rejected with onQueueFull handler.
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
 * Compiled exclusion pattern for efficient matching
 */
interface CompiledPattern {
  type: 'exact' | 'regex'
  pattern: string | RegExp
}

/**
 * High-performance queue implementation using Map and doubly-linked list
 */
class RequestQueue {
  private readonly nodeMap = new Map<string, QueueNode>()
  private head: QueueNode | null = null
  private tail: QueueNode | null = null
  private queueSize = 0
  
  private readonly options: Required<Pick<QueueMiddlewareOptions, 'timeout' | 'concurrency' | 'queueLimit'>> & QueueMiddlewareOptions
  private readonly limit: ReturnType<typeof pLimit>
  private readonly timeoutMap = new Map<string, NodeJS.Timeout>()
  private readonly compiledExclusions: CompiledPattern[] = []
  
  // Track processing state to handle race conditions
  private readonly processingSet = new Set<string>()

  constructor(options: QueueMiddlewareOptions) {
    this.options = {
      timeout: 30000,
      concurrency: 1,
      ...options
    }

    this.limit = pLimit(this.options.concurrency)
    
    // Pre-compile exclusion patterns
    this.compileExclusions()

    debug.main('RequestQueue initialized with options: queueLimit=%d, concurrency=%d, timeout=%d',
      this.options.queueLimit, this.options.concurrency, this.options.timeout)
  }

  /**
   * Pre-compile exclusion patterns for efficient matching
   */
  private compileExclusions(): void {
    if (!this.options.exclude || this.options.exclude.length === 0) {
      return
    }

    for (const pattern of this.options.exclude) {
      if (pattern.includes('*')) {
        // Convert wildcard pattern to regex once
        const regexPattern = pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
          .replace(/\*/g, '.*') // Convert * to .*
        this.compiledExclusions.push({
          type: 'regex',
          pattern: new RegExp(`^${regexPattern}$`)
        })
      } else {
        // Exact match
        this.compiledExclusions.push({
          type: 'exact',
          pattern
        })
      }
    }
    
    debug.middleware('Compiled %d exclusion patterns', this.compiledExclusions.length)
  }

  /**
   * Check if a path should be excluded (optimized)
   */
  isPathExcluded(path: string): boolean {
    for (const compiled of this.compiledExclusions) {
      if (compiled.type === 'exact') {
        if (compiled.pattern === path) {
          debug.middleware('Request %s excluded (exact match)', path)
          return true
        }
      } else {
        if ((compiled.pattern as RegExp).test(path)) {
          debug.middleware('Request %s excluded (pattern match)', path)
          return true
        }
      }
    }
    return false
  }

  /**
   * Add node to the tail of the linked list - O(1)
   */
  private addToTail(node: QueueNode): void {
    node.prev = this.tail
    node.nextNode = null
    
    if (this.tail) {
      this.tail.nextNode = node
    }
    this.tail = node
    
    if (!this.head) {
      this.head = node
    }
    
    this.queueSize++
    this.nodeMap.set(node.id, node)
  }

  /**
   * Remove node from linked list - O(1)
   */
  private removeNode(node: QueueNode): void {
    if (node.prev) {
      node.prev.nextNode = node.nextNode
    } else {
      this.head = node.nextNode
    }
    
    if (node.nextNode) {
      node.nextNode.prev = node.prev
    } else {
      this.tail = node.prev
    }
    
    this.queueSize--
    this.nodeMap.delete(node.id)
  }

  /**
   * Adds a request to the queue and processes it when capacity is available.
   * Optimized with O(1) operations
   * Uses Promise.race to handle timeouts properly - returns timeout response immediately
   * without waiting for the underlying handler to complete
   */
  async enqueue(context: Context, next: Next): Promise<Response> {
    const requestId = context.get('requestId') as string

    if (!requestId) {
      console.error(`\n[hono-slow-down] No request-id found, add this middleware before queueMiddleware:\n\nimport { requestId } from 'hono/request-id'\napp.use('*', requestId());\n`)
      throw new Error('Request ID is required for queue middleware')
    }

    debug.enqueue('Request %s attempting to join queue (waiting: %d, active: %d/%d)',
      requestId, this.queueSize, this.limit.activeCount, this.options.concurrency)

    // Check if we've reached the queue limit
    // Queue limit includes both waiting requests AND currently processing requests
    const totalInSystem = this.queueSize + this.limit.activeCount + this.limit.pendingCount
    
    if (this.options.queueLimit > 0 && totalInSystem >= this.options.queueLimit) {
      debug.enqueue('Request %s rejected - queue full (total in system: %d, limit: %d)', 
        requestId, totalInSystem, this.options.queueLimit)
      if (this.options.onQueueFull) {
        return await this.options.onQueueFull(context)
      }
      return new Response('Queue is full', { status: 429 })
    }

    const node: QueueNode = {
      id: requestId,
      timestamp: Date.now(),
      context,
      next,
      prev: null,
      nextNode: null
    }

    // Add to queue with O(1) operation
    this.addToTail(node)
    const totalInSystemAfterAdd = this.queueSize + this.limit.activeCount + this.limit.pendingCount
    debug.enqueue('Request %s added to waiting queue (waiting: %d, total in system: %d)', 
      requestId, this.queueSize, totalInSystemAfterAdd)

    // Set up timeout handling with Promise.race
    let timeoutId: NodeJS.Timeout | undefined
    
    // Create timeout promise if configured
    const timeoutPromise = this.options.timeout && this.options.timeout > 0
      ? new Promise<Response>((resolve) => {
          debug.enqueue('Request %s timeout set for %dms', requestId, this.options.timeout)
          timeoutId = setTimeout(() => {
            debug.timeout('Request %s timed out after %dms', requestId, this.options.timeout)
            this.handleTimeout(requestId)
            
            // Immediately resolve with timeout response
            const timeoutResponse = this.options.onQueueTimeout 
              ? this.options.onQueueTimeout(context)
              : new Response('Request timeout', { status: 408 })
            
            // Resolve the timeout promise
            if (timeoutResponse instanceof Promise) {
              timeoutResponse.then(resolve)
            } else {
              resolve(timeoutResponse)
            }
          }, this.options.timeout)
          this.timeoutMap.set(requestId, timeoutId)
        })
      : null

    // Create the main request processing promise
    const processPromise = this.limit(async () => {
      // Check if request was already removed (e.g., by timeout)
      const currentNode = this.nodeMap.get(requestId)
      if (!currentNode) {
        debug.process('Request %s no longer in queue (likely timed out)', requestId)
        throw new Error('Request timed out')
      }

      // Mark as processing to prevent race conditions
      this.processingSet.add(requestId)
      
      // Remove from queue with O(1) operation
      this.removeNode(currentNode)
      debug.process('Request %s starting processing (waiting: %d, active: %d/%d)',
        requestId, this.queueSize, this.limit.activeCount, this.options.concurrency)

      const startTime = Date.now()
      
      try {
        await next()

        const processingTime = Date.now() - startTime
        debug.process('Request %s completed successfully in %dms', requestId, processingTime)

        // Clear timeout only on successful completion
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.timeoutMap.delete(requestId)
        }

        return context.res
      } catch (error) {
        const processingTime = Date.now() - startTime
        debug.process('Request %s failed after %dms: %O', requestId, processingTime, error)
        
        // Clear timeout on error
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.timeoutMap.delete(requestId)
        }
        
        throw error
      } finally {
        // Clean up processing state
        this.processingSet.delete(requestId)
      }
    })

    // Race between timeout and processing
    if (timeoutPromise) {
      return await Promise.race([processPromise, timeoutPromise])
    } else {
      return await processPromise
    }
  }

  /**
   * Handles request timeout by removing it from the queue and cleaning up
   * Optimized with O(1) operations
   */
  private handleTimeout(requestId: string): void {
    debug.timeout('Timeout triggered for request %s', requestId)

    // If request is being processed, the timeout flag will handle it
    if (this.processingSet.has(requestId)) {
      debug.timeout('Request %s is processing, will be terminated due to timeout', requestId)
      // The hasTimedOut flag in enqueue() will handle the termination
      return
    }

    // O(1) lookup and removal for waiting requests
    const node = this.nodeMap.get(requestId)
    if (node) {
      this.removeNode(node)
      debug.timeout('Request %s removed from waiting queue due to timeout', requestId)
    }

    this.timeoutMap.delete(requestId)
  }

  /**
   * Gets the total number of requests in the system (waiting + processing + pending)
   */
  getTotalInSystem(): number {
    return this.queueSize + this.limit.activeCount + this.limit.pendingCount
  }

  /**
   * Gets the number of requests currently waiting in the queue
   */
  getQueueLength(): number {
    return this.queueSize
  }

  /**
   * Checks if any requests are currently being processed
   */
  isProcessing(): boolean {
    return this.limit.activeCount > 0
  }

  /**
   * Gets the number of requests actively being processed
   */
  getProcessingCount(): number {
    return this.limit.activeCount
  }

  /**
   * Gets the number of requests pending execution (queued in p-limit)
   */
  getPendingCount(): number {
    return this.limit.pendingCount
  }

  /**
   * Gets information about all requests currently waiting in the queue
   * Optimized to iterate through linked list
   */
  getQueuedRequests(): Array<{ id: string; timestamp: number }> {
    const requests: Array<{ id: string; timestamp: number }> = []
    let current = this.head
    
    while (current) {
      requests.push({
        id: current.id,
        timestamp: current.timestamp
      })
      current = current.nextNode
    }
    
    return requests
  }
}

/**
 * Creates a Hono middleware that queues and rate-limits incoming requests.
 * Optimized for high-performance with O(1) operations
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
    // Check exclusions first (optimized with pre-compiled patterns)
    if (queue.isPathExcluded(context.req.path)) {
      return await next()
    }

    // Single request ID check (removed duplicate)
    const requestId = context.get('requestId') as string
    if (!requestId) {
      console.error(`\n[hono-slow-down] No request-id found, add this middleware before queueMiddleware:\n\nimport { requestId } from 'hono/request-id'\napp.use('*', requestId());\n`)
      throw new Error('Request ID is required for queue middleware')
    }

    debug.middleware('Middleware invoked for request %s', requestId)
    return await queue.enqueue(context, next)
  }
}

// Export types for compatibility
export { RequestQueue }
export type { QueueMiddlewareOptions, QueueNode as QueuedRequest }