import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import log from 'electron-log/main.js';
import {
  HealthResponseSchema,
  SiteTimeReportSchema,
  type WsMessage,
} from '@steam-client/shared';
import { addSiteTime, getBalance } from './ledger';

export interface ServerDeps {
  port: number;
  token: string;
  version: string;
}

let httpServer: HttpServer | null = null;
let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();

function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header('authorization') || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export function startServer(deps: ServerDeps): void {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // CORS for browser extension only. Requests without Origin (curl, native
  // apps, other desktop processes) get no CORS response — they still need
  // Bearer auth, but a browser page on another origin cannot read the reply.
  app.use((req, res, next) => {
    const origin = req.header('origin') || '';
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const auth = requireToken(deps.token);

  app.get('/health', (_req, res) => {
    const body = HealthResponseSchema.parse({ ok: true, version: deps.version });
    res.json(body);
  });

  /**
   * Extension heartbeat: "user spent N seconds on `domain`".
   * Main increments a local site_times counter. A separate flusher sends
   * the total to the API POST /metrics/sites.
   */
  app.post('/site-time', auth, (req, res) => {
    const parsed = SiteTimeReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    try {
      addSiteTime(parsed.data.domain, parsed.data.seconds);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  httpServer = createServer(app);

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // Defence-in-depth: WS handshake must come from the browser extension,
    // not from any random page whose origin doesn't match. Token alone is
    // not enough — if it ever leaks through logs/Referer, a rogue page
    // could otherwise open a sub-socket.
    const origin = (req.headers.origin as string | undefined) || '';
    const originOk =
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://');
    if (!originOk) {
      ws.close(1008, 'forbidden_origin');
      return;
    }

    const url = new URL(req.url || '', 'http://localhost');
    const t = url.searchParams.get('token');
    if (t !== deps.token) {
      ws.close(1008, 'unauthorized');
      return;
    }
    log.info('[ws] client connected');
    wsClients.add(ws);
    try {
      ws.send(JSON.stringify({ type: 'balance', seconds: getBalance() } satisfies WsMessage));
    } catch {}
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  httpServer.listen(deps.port, '127.0.0.1', () => {
    log.info(`[server] listening on http://127.0.0.1:${deps.port}`);
  });
}

export function pushWs(msg: WsMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}

export function stopServer(): void {
  for (const ws of wsClients) {
    try {
      ws.close();
    } catch {}
  }
  wsClients.clear();
  wss?.close();
  httpServer?.close();
}
