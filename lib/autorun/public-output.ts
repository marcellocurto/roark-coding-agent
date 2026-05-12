const redactedLocalPath = "[local path redacted]";

export function redactLocalPaths(value: string): string {
  return value
    .replace(/(^|[^A-Za-z0-9_])([A-Za-z]:[\\/][^\s`"'<>\])}]*)/g, (_match, prefix: string) => `${prefix}${redactedLocalPath}`)
    .replace(/(^|[\s("'`=:\[])(\/(?!\/)[^\s`"'<>\])}]*)/g, (_match, prefix: string) => `${prefix}${redactedLocalPath}`);
}
