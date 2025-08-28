# Hono Slow Down

This is a middleware for Hono that allows you to slow down your API responses.

## Installation

```sh
bun add hono-slow-down
```

## Usage

```typescript
import { Hono } from 'hono'
import { queueMiddleware } from 'hono-slow-down'

const app = new Hono()

app.use('*', queueMiddleware({
  queueLimit: 100, // Max 100 requests waiting, set to 0 for unlimited
  concurrency: 5, // Process up to 5 requests concurrently
  timeout: 10000, // 10 second timeout, set to 0 for no timeout
}))
 
```

See [example.ts](./src/example.ts) for a complete example.