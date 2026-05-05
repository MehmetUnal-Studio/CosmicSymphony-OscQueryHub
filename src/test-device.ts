import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ AYARLAR ============
const PORT = parseInt(process.env.PORT || '9200', 10);
const NAME = process.env.NAME || 'TestPad';
const DESCRIPTION = 'XY pad + 2 slider test cihazı';

// ============ DURUM ============
interface ParamSpec {
  type: 'f';
  range: { MIN: number; MAX: number };
  description: string;
  value: number;
}

const params: Record<string, ParamSpec> = {
  '/xy/x':    { type: 'f', range: { MIN: 0, MAX: 1 }, description: 'XY pad - X ekseni', value: 0.5 },
  '/xy/y':    { type: 'f', range: { MIN: 0, MAX: 1 }, description: 'XY pad - Y ekseni', value: 0.5 },
  '/slider1': { type: 'f', range: { MIN: 0, MAX: 1 }, description: 'Slider 1',           value: 0   },
  '/slider2': { type: 'f', range: { MIN: 0, MAX: 1 }, description: 'Slider 2',           value: 0   },
};

// ============ NAMESPACE TREE ============
function buildTree(): any {
  const root: any = { FULL_PATH: '/', DESCRIPTION: NAME, CONTENTS: {} };
  for (const [path, spec] of Object.entries(params)) {
    const parts = path.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      const fullPath = '/' + parts.slice(0, i + 1).join('/');
      if (!cur.CONTENTS) cur.CONTENTS = {};
      if (!cur.CONTENTS[part]) cur.CONTENTS[part] = { FULL_PATH: fullPath };
      if (isLeaf) {
        cur.CONTENTS[part].TYPE = spec.type;
        cur.CONTENTS[part].VALUE = [spec.value];
        cur.CONTENTS[part].ACCESS = 3;
        cur.CONTENTS[part].RANGE = [spec.range];
        cur.CONTENTS[part].DESCRIPTION = spec.description;
      }
      cur = cur.CONTENTS[part];
    }
  }
  return root;
}

// ============ OSC BINARY ENCODE ============
function oscPad(buf: Buffer): Buffer {
  const padded = Math.ceil(buf.length / 4) * 4;
  const out = Buffer.alloc(padded);
  buf.copy(out);
  return out;
}
function encodeOscString(s: string): Buffer {
  return oscPad(Buffer.from(s + '\0', 'utf8'));
}
function buildOscFloatMessage(address: string, value: number): Buffer {
  const addr = encodeOscString(address);
  const tag  = encodeOscString(',f');
  const val  = Buffer.alloc(4);
  val.writeFloatBE(value, 0);
  return Buffer.concat([addr, tag, val]);
}

// ============ HTTP + WS SERVER ============
const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => {
  if ('HOST_INFO' in req.query) {
    return res.json({
      NAME,
      OSC_PORT: PORT,
      OSC_TRANSPORT: 'TCP',
      EXTENSIONS: { ACCESS: true, VALUE: true, DESCRIPTION: true, TYPE: true, RANGE: true, OSC_STREAMING: true },
    });
  }
  res.json(buildTree());
});

app.use('/ui', express.static(join(__dirname, '..', 'web')));

app.get(/^\/(.+)/, (req, res) => {
  const path = '/' + req.params[0];
  const spec = params[path];
  if (spec) {
    return res.json({
      FULL_PATH: path,
      TYPE: spec.type,
      VALUE: [spec.value],
      ACCESS: 3,
      RANGE: [spec.range],
      DESCRIPTION: spec.description,
    });
  }
  const tree = buildTree();
  const parts = path.split('/').filter(Boolean);
  let cur: any = tree;
  for (const part of parts) {
    if (cur.CONTENTS && cur.CONTENTS[part]) cur = cur.CONTENTS[part];
    else return res.status(404).json({ error: 'Not found' });
  }
  res.json(cur);
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

const wsClients = new Set<WebSocket>();
const listenPaths = new WeakMap<WebSocket, Set<string>>();

function broadcastOsc(path: string, value: number) {
  const packet = buildOscFloatMessage(path, value);
  for (const ws of wsClients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const listens = listenPaths.get(ws);
    if (listens && listens.size > 0 && !listens.has(path)) continue;
    ws.send(packet, { binary: true });
  }
}

function setParam(path: string, value: number, except?: WebSocket) {
  const spec = params[path];
  if (!spec) return;
  const clamped = Math.max(spec.range.MIN, Math.min(spec.range.MAX, value));
  spec.value = clamped;

  // OSC binary → hub ve diğer dinleyiciler
  broadcastOsc(path, clamped);

  // JSON UI güncellemesi → bütün UI'lar
  const uiMsg = JSON.stringify({ type: 'UI_UPDATE', path, value: clamped });
  for (const ws of wsClients) {
    if (ws === except) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(uiMsg);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`  🔌 WS bağlantı: ${ip}`);
  wsClients.add(ws);
  listenPaths.set(ws, new Set());

  // UI için mevcut değerleri gönder
  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    values: Object.fromEntries(Object.entries(params).map(([p, s]) => [p, s.value])),
  }));

  ws.on('message', (raw) => {
    const text = raw.toString('utf8');
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    // OSCQuery LISTEN/IGNORE
    if (msg.COMMAND === 'LISTEN' && typeof msg.DATA === 'string') {
      listenPaths.get(ws)!.add(msg.DATA);
      return;
    }
    if (msg.COMMAND === 'IGNORE' && typeof msg.DATA === 'string') {
      listenPaths.get(ws)!.delete(msg.DATA);
      return;
    }

    // UI'dan SET
    if (msg.type === 'SET' && typeof msg.path === 'string' && typeof msg.value === 'number') {
      setParam(msg.path, msg.value, ws);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

// ============ START ============
server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Test Cihaz: ${NAME}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  OSCQuery HTTP:  http://localhost:${PORT}/`);
  console.log(`  WebSocket:      ws://localhost:${PORT}`);
  console.log(`  Web arayüz:    http://localhost:${PORT}/ui/test-device.html`);
  console.log(`  Param sayısı:  ${Object.keys(params).length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const bonjour = new Bonjour();
  const svc = bonjour.publish({ name: NAME, type: 'oscjson', protocol: 'tcp', port: PORT });
  svc.on('up', () => console.log(`  Bonjour duyuruldu: _oscjson._tcp ${PORT}`));

  process.on('SIGINT', () => {
    console.log('\nKapatılıyor...');
    bonjour.unpublishAll(() => {
      bonjour.destroy();
      server.close();
      process.exit(0);
    });
  });
});
