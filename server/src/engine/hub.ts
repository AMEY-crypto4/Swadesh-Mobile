import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, type AuthCtx } from '../middleware/auth.js';

interface Client {
  ws: WebSocket;
  auth?: AuthCtx;
  alive: boolean;
}

export interface HubHandlers {
  /** Full state for a freshly authenticated socket (also used for client resync requests). */
  snapshot(auth: AuthCtx): unknown;
  /** Called when a user's first socket connects / last socket closes. */
  presence(auth: AuthCtx, online: boolean): void;
}

/**
 * Raw-WebSocket fan-out, strictly partitioned by tenant.
 * Protocol: connect -> {type:'auth', token} within 5s -> {type:'ready'} + {type:'snapshot'} ->
 * deltas carry a per-tenant monotonically increasing `seq`; a client that sees a gap sends {type:'resync'}.
 */
class Hub {
  private wss?: WebSocketServer;
  private clients = new Set<Client>();
  private handlers?: HubHandlers;

  attach(server: Server, handlers: HubHandlers) {
    this.handlers = handlers;
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    setInterval(() => {
      for (const c of this.clients) {
        if (c.auth) this.send(c, { type: 'hb', t: Date.now() }); // app-level heartbeat so the UI can tell "quiet" from "dead"
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
      }
    }, 20_000).unref();
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, alive: true };
    this.clients.add(client);
    const authTimer = setTimeout(() => !client.auth && ws.close(4401, 'auth timeout'), 5000);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw) => {
      let msg: { type?: string; token?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth' && !client.auth) {
        try {
          client.auth = verifyToken(String(msg.token));
        } catch {
          return ws.close(4401, 'invalid token');
        }
        clearTimeout(authTimer);
        const first = ![...this.clients].some((c) => c !== client && c.auth?.userId === client.auth!.userId && c.auth.companyId === client.auth!.companyId);
        this.send(client, { type: 'ready', role: client.auth.role });
        this.send(client, { type: 'snapshot', ...(this.handlers!.snapshot(client.auth) as object) });
        if (first) this.handlers!.presence(client.auth, true);
      } else if (msg.type === 'resync' && client.auth) {
        this.send(client, { type: 'snapshot', ...(this.handlers!.snapshot(client.auth) as object) });
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
      const a = client.auth;
      if (a && !this.isOnline(a.companyId, a.userId)) this.handlers!.presence(a, false);
    });
    ws.on('error', () => ws.terminate());
  }

  private send(c: Client, msg: unknown) {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount > 1_000_000) return c.ws.terminate(); // slow consumer: drop; it will reconnect + resync
    c.ws.send(JSON.stringify(msg));
  }

  /** To supervisors/admins of exactly one tenant. */
  broadcast(companyId: number, msg: unknown) {
    for (const c of this.clients) if (c.auth && c.auth.companyId === companyId && c.auth.role !== 'agent') this.send(c, msg);
  }

  sendToUser(companyId: number, userId: number, msg: unknown) {
    for (const c of this.clients) if (c.auth && c.auth.companyId === companyId && c.auth.userId === userId) this.send(c, msg);
  }

  isOnline(companyId: number, userId: number) {
    for (const c of this.clients) if (c.auth?.companyId === companyId && c.auth.userId === userId) return true;
    return false;
  }

  connectionCount(companyId: number) {
    let n = 0;
    for (const c of this.clients) if (c.auth?.companyId === companyId) n++;
    return n;
  }

  close() {
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
  }
}

export const hub = new Hub();
