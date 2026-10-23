/**
 * pi-ai / Anthropic SDK failure text mapped onto the harness LLM error codes.
 *
 * The harness retry policy keys off these codes, so this mapping is the only
 * thing that lets `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` retries work for
 * this route. Codes not in the seam vocabulary are deliberately avoided.
 *
 * @module dsh-llm-claude/errors
 */

/** Classify one provider failure message into a stable harness error code. */
export function classifyProviderError(message) {
  const text = typeof message === 'string' ? message : String(message ?? '')
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/quota|balance|insufficient|usage limit|超过额度|余额/i.test(text)) return 'QUOTA'
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/context (?:length|window)|prompt is too long|too many tokens|maximum context/i.test(text)) {
    return 'CONTEXT_WINDOW_EXCEEDED'
  }
  if (/\b413\b|request_too_large|payload too large|request body too large/i.test(text)) {
    return 'INVALID_REQUEST'
  }
  if (/\b400\b|invalid.?request|invalid_request_error/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b|overloaded|api_error/i.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/stream ended (?:before|without)|premature close|other side closed/i.test(text)) return 'TRANSPORT'
  if (/ECONN[A-Z]+|network|connection|socket|fetch failed|terminated/i.test(text)) return 'TRANSPORT'
  return 'PROVIDER_ERROR'
}
