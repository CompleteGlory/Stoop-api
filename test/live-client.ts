import WebSocket from 'ws';

type Frame = { t: string; d: any };

/** A tiny test client for the /live socket that queues what the server sends. */
export class LiveClient {
  readonly inbox: Frame[] = [];
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString('utf8')) as Frame;
      const waiter = this.waiters.find((w) => w.match(frame));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else {
        this.inbox.push(frame);
      }
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  static connect(port: number, accessToken: string, options: WebSocket.ClientOptions = {}): Promise<LiveClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        ...options,
      });
      const client = new LiveClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  /** Connects and waits for the `hello` frame, which is returned too. */
  static async connectReady(port: number, accessToken: string, options: WebSocket.ClientOptions = {}) {
    const client = await LiveClient.connect(port, accessToken, options);
    const hello = await client.next('hello');
    return { client, hello: hello.d };
  }

  send(t: string, d?: unknown) {
    this.ws.send(JSON.stringify({ t, d }));
  }

  /** Resolves with the first frame of type `t` (matching `where`), consuming it. */
  next(t: string, where: (d: any) => boolean = () => true, timeoutMs = 2000): Promise<Frame> {
    const match = (f: Frame) => f.t === t && where(f.d);
    const queued = this.inbox.findIndex(match);
    if (queued >= 0) return Promise.resolve(this.inbox.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timed out waiting for "${t}"; inbox: ${JSON.stringify(this.inbox)}`));
        }
      }, timeoutMs);
    });
  }

  /** Asserts that nothing of type `t` arrives within `ms`. */
  async expectNone(t: string, where: (d: any) => boolean = () => true, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    const found = this.inbox.filter((f) => f.t === t && where(f.d));
    expect(found).toEqual([]);
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    return this.closed;
  }
}

export const here = { lat: 30.0444, lng: 31.2357, accuracy: 12, heading: 90 };
