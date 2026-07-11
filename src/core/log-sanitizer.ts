const MAX_INFO_STRING_LENGTH = 400;
const C0_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function sanitizeString(value: string, level: string): string {
  const clean = value.replace(C0_CONTROL_RE, '');
  if (level === 'debug' || level === 'trace') return clean;
  if (clean.length <= MAX_INFO_STRING_LENGTH) return clean;
  return clean.slice(0, MAX_INFO_STRING_LENGTH) + '[Truncated: ' + clean.length + ' characters total]';
}

function sanitizeValue(value: unknown, level: string): unknown {
  if (typeof value === 'string') return sanitizeString(value, level);
  if (Array.isArray(value)) return value.map(v => sanitizeValue(v, level));
  if (value instanceof Date) return new Date(value.getTime());
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v, level);
    }
    return result;
  }
  return value;
}

export function sanitizeLogPayload(payload: any, currentLevel: string): any {
  if (payload === null || payload === undefined) return payload;
  return sanitizeValue(payload, currentLevel.toLowerCase());
}
