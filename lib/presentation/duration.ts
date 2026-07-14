export function formatToolDuration(durationMs: number): string {
  const safeDurationMs = normalizeDurationMs(durationMs);
  if (safeDurationMs < 1000) return `${Math.round(safeDurationMs)}ms`;

  const seconds = safeDurationMs / 1000;
  const secondsText = seconds.toFixed(1).replace(/\.0$/, "");
  return `${secondsText}s`;
}

function normalizeDurationMs(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}
