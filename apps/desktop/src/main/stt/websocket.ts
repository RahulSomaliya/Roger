import type { RawData } from 'ws';

/** ws hands text frames over as Buffer, Buffer[] or ArrayBuffer depending on the transport. */
export function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
