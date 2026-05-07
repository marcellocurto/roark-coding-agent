const nonTransientAgentErrorPatterns = [
  /quota[_\s]+exhausted/i,
  /quota[_\s]+(?:limit|exceeded|will[_\s]+reset)/i,
  /invalid[_\s]+api[_\s]+key/i,
  /api[_\s]+key.*invalid/i,
  /authentication[_\s]+failed/i,
  /unauthorized/i,
  /forbidden/i,
  /model[_\s]+not[_\s]+found/i,
  /invalid\s+--model/i,
  /git\s+working\s+tree\s+has\s+changes/i,
  /output[-_\s]?contract/i,
  /failed[_\s]+output[_\s]+contract/i,
];

const transientAgentConnectionErrorPatterns = [
  /websocket[_\s]+closed/i,
  /connection[_\s]+ended/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /socket[_\s]+hang[_\s]+up/i,
  /fetch[_\s]+failed/i,
  /network[_\s]+error/i,
  /connection[_\s]+reset/i,
  /connection[_\s]+closed/i,
  /gateway[_\s]+timeout/i,
  /service[_\s]+unavailable/i,
  /temporarily[_\s]+unavailable/i,
];

export function isTransientAgentConnectionError(error: unknown): boolean {
  const message = formatError(error);
  if (!message) return false;
  if (nonTransientAgentErrorPatterns.some((pattern) => pattern.test(message))) return false;
  return transientAgentConnectionErrorPatterns.some((pattern) => pattern.test(message));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
