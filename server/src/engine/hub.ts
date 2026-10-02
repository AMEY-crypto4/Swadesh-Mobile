import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, type AuthCtx } from '../middleware/auth.js';

export type Msg = { type: string; [k: string]: unknown };

interface Client {
  ws: WebSocket;
  auth?: AuthCtx;
  alive: boolean;
  connectedAt: number;
}

export interface HubHandlers {
  /** Full state for a freshly authenticated socket (also used for client resync requests). */
  snapshot(auth: AuthCtx): unknown;
  /** Called when a user's first socket connects / last socket closes. */
  presence(auth: AuthCtx, online: boolean): void;
  /** False when the identity no longer exists (e.g. a guest seat that was reclaimed). */
  valid(auth: AuthCtx): boolean;
}

export interface TenantWsStats {
  since: number;
  framesOut: number;
  bytesOut: number;
  framesIn: number;
  byType: Record<string, number>;
  /** Rolling per-second buckets for the last 30 s (frames out). */
  recent: number[];
  recentAt: number;
}

/**
 * Raw-WebSocket fan-out, strictly partitioned by tenant.
 * Protocol: connect -> {type:'auth', token} within 5s -> {type:'ready'} + {type:'snapshot'} ->
 * deltas carry a per-tenant monotonically increasing `seq`; a client that sees a gap sends {type:'resync'}.
 * Each broadcast is serialised once and the same string is written to every socket (cost is O(sockets), not O(sockets x JSON)).
 */
class Hub {
  private wss?: WebSocketServer;
  private clients = new Set<Client>();
  private handlers?: HubHandlers;
  private stats = new Map<number, TenantWsStats>();

  attach(server: Server, handlers: HubHandlers) {
    this.handlers = handlers;
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    setInterval(() => {
      for (const c of this.clients) {
        if (c.auth) this.sendRaw(c, JSON.stringify({ type: 'hb', t: Date.now() }), 'hb'); // app-level heartbeat so the UI can tell "quiet" from "dead"
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
      }
    }, 20_000).unref();
  }

  private tenantStats(companyId: number): TenantWsStats {
    let s = this.stats.get(companyId);
    if (!s) { s = { since: Date.now(), framesOut: 0, bytesOut: 0, framesIn: 0, byType: {}, recent: new Array(30).fill(0), recentAt: Math.floor(Date.now() / 1000) }; this.stats.set(companyId, s); }
    return s;
  }

  private count(companyId: number, type: string, bytes: number) {
    const s = this.tenantStats(companyId);
    s.framesOut++; s.bytesOut += bytes; s.byType[type] = (s.byType[type] ?? 0) + 1;
    const sec = Math.floor(Date.now() / 1000);
    while (s.recentAt < sec) { s.recent.shift(); s.recent.push(0); s.recentAt++; }
    s.recent[s.recent.length - 1]++;
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, alive: true, connectedAt: Date.now() };
    this.clients.add(client);
    const authTimer = setTimeout(() => !client.auth && ws.close(4401, 'auth timeout'), 5000);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw) => {
      let msg: { type?: string; token?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (client.auth) this.tenantStats(client.auth.companyId).framesIn++;
      if (msg.type === 'auth' && !client.auth) {
        try {
          client.auth = verifyToken(String(msg.token));
        } catch {
          return ws.close(4401, 'invalid token');
        }
        if (!this.handlers!.valid(client.auth)) return ws.close(4401, 'session ended');
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

  private sendRaw(c: Client, raw: string, type: string) {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount > 1_000_000) return c.ws.terminate(); // slow consumer: drop; it will reconnect + resync
    c.ws.send(raw);
    if (c.auth) this.count(c.auth.companyId, type, raw.length);
  }

  private send(c: Client, msg: Msg) {
    this.sendRaw(c, JSON.stringify(msg), msg.type);
  }

  /** To supervisors/admins of exactly one tenant. */
  broadcast(companyId: number, msg: Msg) {
    let raw: string | undefined;
    for (const c of this.clients) {
      if (c.auth && c.auth.companyId === companyId && c.auth.role !== 'agent') this.sendRaw(c, (raw ??= JSON.stringify(msg)), msg.type);
    }
  }

  sendToUser(companyId: number, userId: number, msg: Msg) {
    let raw: string | undefined;
    for (const c of this.clients) {
      if (c.auth && c.auth.companyId === companyId && c.auth.userId === userId) this.sendRaw(c, (raw ??= JSON.stringify(msg)), msg.type);
    }
  }

  isOnline(companyId: number, userId: number) {
    for (const c of this.clients) if (c.auth?.companyId === companyId && c.auth.userId === userId) return true;
    return false;
  }

  /** Who is connected right now, for this tenant only. */
  sessions(companyId: number) {
    const by = new Map<number, { userId: number; name: string; role: string; since: number; sockets: number }>();
    for (const c of this.clients) {
      if (c.auth?.companyId !== companyId) continue;
      const e = by.get(c.auth.userId);
      if (e) { e.sockets++; e.since = Math.min(e.since, c.connectedAt); }
      else by.set(c.auth.userId, { userId: c.auth.userId, name: c.auth.name, role: c.auth.role, since: c.connectedAt, sockets: 1 });
    }
    return [...by.values()].sort((a, b) => a.since - b.since);
  }

  tenantSnapshot(companyId: number) {
    const s = this.tenantStats(companyId);
    const sec = Math.floor(Date.now() / 1000);
    while (s.recentAt < sec) { s.recent.shift(); s.recent.push(0); s.recentAt++; }
    return { ...s, recent: [...s.recent], connections: [...this.clients].filter((c) => c.auth?.companyId === companyId).length };
  }

  totalConnections() { return this.clients.size; }

  close() {
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
  }
}

export const hub = new Hub();
