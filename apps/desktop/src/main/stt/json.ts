/**
 * Field guards for vendor JSON. A vendor message is untrusted input: parsers read every field from
 * `unknown` through these instead of casting (a cast once let a malformed Deepgram message throw a
 * TypeError mid-call).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}
