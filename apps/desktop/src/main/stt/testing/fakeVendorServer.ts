import type { IncomingHttpHeaders } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { rawDataToString } from '../websocket';

/**
 * Test-only: a local websocket server standing in for a speech-to-text vendor. It records what
 * the adapter sent and, above all, whether every socket the adapter opened was closed again.
 * Vendors bill open sessions, so `openSockets()` is the leak detector the suites assert on.
 */

export interface FakeVendorConnection {
  readonly socket: WebSocket;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly texts: string[];
  /** Byte length of each binary frame, in order. */
  readonly binaryFrames: number[];
  closed: boolean;
}

export interface FakeVendorScript {
  onConnect?(connection: FakeVendorConnection): void;
  onText?(connection: FakeVendorConnection, text: string): void;
  onBinary?(connection: FakeVendorConnection, frame: number): void;
}

export class FakeVendorServer {
  readonly connections: FakeVendorConnection[] = [];
  /**
   * Every websocket handshake the adapter attempted, refused ones too (`connections` holds only the
   * accepted ones). One per open: a core that retried a refused connect itself would open a billed
   * session the open budget never saw (house rule 9).
   */
  handshakes = 0;
  /** Refuse the handshake with this HTTP status instead of upgrading. */
  rejectWith: number | null = null;
  script: FakeVendorScript = {};

  private constructor(
    private readonly server: WebSocketServer,
    readonly baseUrl: string,
  ) {
    server.on('connection', (socket: WebSocket, request) => {
      const connection: FakeVendorConnection = {
        socket,
        url: request.url ?? '',
        headers: request.headers,
        texts: [],
        binaryFrames: [],
        closed: false,
      };
      this.connections.push(connection);
      socket.on('close', () => {
        connection.closed = true;
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          connection.binaryFrames.push(byteLength(data));
          this.script.onBinary?.(connection, connection.binaryFrames.length);
          return;
        }
        const text = rawDataToString(data);
        connection.texts.push(text);
        this.script.onText?.(connection, text);
      });
      this.script.onConnect?.(connection);
    });
  }

  static async start(): Promise<FakeVendorServer> {
    let fake: FakeVendorServer | null = null;
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (_info, done) => {
        if (fake !== null) fake.handshakes += 1;
        const status = fake?.rejectWith ?? null;
        if (status !== null) done(false, status, 'refused by the fake vendor');
        else done(true);
      },
    });
    await new Promise<void>((resolve) => {
      server.once('listening', () => {
        resolve();
      });
    });
    fake = new FakeVendorServer(server, `ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return fake;
  }

  /** Connections the adapter has not closed yet (from the server's side of the socket). */
  openSockets(): number {
    return this.connections.filter((connection) => !connection.closed).length;
  }

  last(): FakeVendorConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error('the adapter never connected to the fake vendor');
    return connection;
  }

  /** Waits for every socket to be closed; throws naming the leak if one stays open. */
  async expectNoOpenSockets(timeoutMs = 1_000): Promise<void> {
    try {
      await waitFor(() => this.openSockets() === 0, timeoutMs);
    } catch {
      throw new Error(
        `the adapter left ${this.openSockets()} vendor socket(s) open: a real vendor bills every ` +
          'second of that',
      );
    }
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/** A TCP server that accepts and never answers the websocket handshake, to test connect timeouts. */
export class SilentTcpServer {
  readonly sockets: Socket[] = [];
  private closedCount = 0;

  private constructor(
    private readonly server: Server,
    readonly baseUrl: string,
  ) {
    server.on('connection', (socket) => {
      this.sockets.push(socket);
      // Read (and ignore) the handshake request: a socket nobody reads never sees the peer's FIN,
      // so it would look open forever.
      socket.resume();
      socket.on('close', () => {
        this.closedCount += 1;
      });
    });
  }

  static async start(): Promise<SilentTcpServer> {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    return new SilentTcpServer(server, `ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }

  openSockets(): number {
    return this.sockets.length - this.closedCount;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A manual clock for metering assertions. */
export function manualClock(startMs = 0): { now: () => number; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
  };
}

function byteLength(data: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.length, 0);
  return data.byteLength;
}
