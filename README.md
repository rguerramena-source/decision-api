# decision-api
API de toma de decisiones de reintento de cobro

# Decision API (Smart Retry)

Serverless decision engine for smart retry logic. POST /api/decide with JSON:
{
  "loans": [...],
  "txs": [...],
  "config": { optional overrides }
}
Protected by header: x-api-key.

