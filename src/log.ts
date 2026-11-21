// Logs are public (ADR-001 point 4): an error is printed by its own message
// only, and never as a parser's, which quotes the input it choked on.
export function safeError(e: unknown): string {
  if (e instanceof SyntaxError) return 'invalid JSON';
  if (e instanceof Error) return e.message.slice(0, 200);
  return 'unknown error';
}
