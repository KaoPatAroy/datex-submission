/** Positive, capped backoff between revision attempts; never busy-retry on zero jitter. */
export function waitForRevisionRetry(attempt: number): Promise<void> {
  const minimum = Math.min(250, 25 * 2 ** attempt);
  const delay = Math.min(250, minimum + Math.floor(Math.random() * minimum));
  return new Promise(resolve => setTimeout(resolve, delay));
}
