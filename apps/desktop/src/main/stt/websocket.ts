import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { SttConnectError } from './SpeechToText';

/**
 * Websocket plumbing shared by the vendor adapters. Resolves once `socket` is open. On a socket
 * error, a non-101 handshake response or the timeout it terminates the socket and rejects with
 * SttConnectError (carrying the HTTP status when there was one).
 */
export function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error: SttConnectError | null): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpected);
      if (error) {
        // ws throws on an 'error' with no listener; keep one attached while we tear down.
        socket.on('error', () => undefined);
        socket.terminate();
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      finish(new SttConnectError(`connection timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onOpen = (): void => {
      finish(null);
    };
    const onError = (error: Error): void => {
      finish(new SttConnectError(error.message));
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }): void => {
      const status = response.statusCode ?? null;
      finish(new SttConnectError(`rejected with HTTP ${status ?? 'unknown'}`, status));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
  });
}

/** ws hands text frames over as Buffer, Buffer[] or ArrayBuffer depending on the transport. */
export function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
