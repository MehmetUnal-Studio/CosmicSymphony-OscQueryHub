import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import osc from 'osc';
import { Bonjour } from 'bonjour-service';

// ============ AYARLAR ============
const PORT = parseInt(process.env.PORT || '9100', 10);
const DEVICE_NAME = process.env.DEVICE_NAME || 'WebInstrument';
const DEVICE_TYPE = 'web-instrument';

// ============ PARAMETRELER ============
// Bu cihazın OSCQuery namespace'i. Hub, GET / ile burayı okuyacak.
const PARAMS = [
  { path: '/x', type: 'f', value: 0.5, range: [0, 1], description: 'XY pad — X ekseni' },
  { path: '/y', type: 'f', value: 0.5, range: [0, 1], description: 'XY pad — Y ekseni' },
];

const paramByPath = new Map(PARAMS.map(p => [p.path, p]));
const values = new Map(PARAMS.map(p => [p.path, p.value]));

// ============ NAMESPACE TREE ============
function buildTree() {
  const root = {
    FULL_PATH: '/',
    DESCRIPTION: `${DEVICE_NAME} (${DEVICE_TYPE})`,
    ACCESS: 0,
    CONTENTS: {}
  };
  for (const p of PARAMS) {
    const parts = p.path.split('/').filter(s => s.length > 0);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const fp = '/' + parts.slice(0, i + 1).join('/');
      if (!node.CONTENTS) node.CONTENTS = {};
      if (!node.CONTENTS[parts[i]]) {
        node.CONTENTS[parts[i]] = { FULL_PATH: fp, ACCESS: 0 };
      }
      node = node.CONTENTS[parts[i]];
      if (isLast) {
        node.TYPE = p.type;
        node.VALUE = [values.get(p.path)];
        node.ACCESS = 3;
        node.DESCRIPTION = p.description;
        if (p.range) {
          node.RANGE = [{ MIN: p.range[0], MAX: p.range[1] }];
        }
      }
    }
  }
  return root;
}

// ============ HTTP ============
const app = express();
app.use((_req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.json());
app.use('/ui', express.static('public'));

// OSCQuery: GET /  → namespace; GET /?HOST_INFO → metadata
app.get('/', (req, res) => {
  if ('HOST_INFO' in req.query) {
    return res.json({
      NAME: DEVICE_NAME,
      OSC_TRANSPORT: 'TCP',
      EXTENSIONS: {
        ACCESS: true,
        VALUE: true,
        DESCRIPTION: true,
        TYPE: true,
        RANGE: true,
        LISTEN: true,
        OSC_STREAMING: true
      }
    });
  }
  res.json(buildTree());
});

// Browser bilgi endpoint'i: bu cihazın IP'si, manifest örneği
app.get('/_info', (_req, res) => {
  res.json({
    name: DEVICE_NAME,
    type: DEVICE_TYPE,
    port: PORT,
    addresses: getLocalIPs(),
    params: PARAMS,
    values: Object.fromEntries(values),
  });
});

// OSCQuery: spesifik path sorgulanabilir (/x, /slider1 vs.)
app.get(/^\/(.+)/, (req, res) => {
  const path = '/' + req.params[0];
  if (path === '/_info' || path.startsWith('/ui')) return res.status(404).end();
  const tree = buildTree();
  const parts = path.split('/').filter(s => s.length > 0);
  let node = tree;
  for (const part of parts) {
    if (node.CONTENTS && node.CONTENTS[part]) node = node.CONTENTS[part];
    else return res.status(404).json({ error: 'Not found' });
  }
  res.json(node);
});

// ============ WS ============
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Her bağlantı için: dinlenen path'ler ve "browser mu?" işareti
const wsState = new Map();

function sendOscBinary(ws, path, value) {
  const param = paramByPath.get(path);
  const t = param ? param.type
                  : (typeof value === 'number'
                      ? (Number.isInteger(value) ? 'i' : 'f')
                      : 's');
  const args = [{ type: t, value }];
  try {
    const buf = osc.writePacket({ address: path, args }, { metadata: true });
    ws.send(buf, { binary: true });
  } catch (e) {
    console.error('  ⚠  OSC encode hatası:', e.message);
  }
}

function setValue(path, value, source) {
  if (!values.has(path)) return false;
  const param = paramByPath.get(path);
  let v = value;
  if (param.type === 'i') v = Math.round(Number(v));
  else if (param.type === 'f') v = Number(v);
  values.set(path, v);

  // Hub gibi LISTEN'lı bağlantılara OSC binary push
  for (const [ws, st] of wsState.entries()) {
    if (st.isBrowser) continue;
    if (!st.listening.has(path)) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    sendOscBinary(ws, path, v);
  }

  // Tarayıcı bağlantılarına JSON broadcast (UI senkron kalsın)
  const json = JSON.stringify({ type: 'VALUE', path, value: v, source });
  for (const [ws, st] of wsState.entries()) {
    if (!st.isBrowser) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
  return true;
}

function broadcastClientCount() {
  const browsers = [...wsState.values()].filter(s => s.isBrowser).length;
  const subs = [...wsState.values()].filter(s => !s.isBrowser).length;
  const json = JSON.stringify({ type: 'CLIENTS', browsers, subscribers: subs });
  for (const [ws, st] of wsState.entries()) {
    if (st.isBrowser && ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  wsState.set(ws, { isBrowser: false, listening: new Set(), ip });
  console.log(`  🔌 WS bağlantı: ${ip}`);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;  // bizden gelen değil
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const st = wsState.get(ws);
    if (!st) return;

    // OSCQuery komutları (Hub tarafı)
    if (msg.COMMAND === 'LISTEN' && typeof msg.DATA === 'string') {
      st.listening.add(msg.DATA);
      console.log(`  👂 LISTEN ${msg.DATA}  (${ip})`);
      // İlk bağlantıda mevcut değeri bir kez yolla — abonelik anında "ben buradayım"
      const cur = values.get(msg.DATA);
      if (cur !== undefined) sendOscBinary(ws, msg.DATA, cur);
      return;
    }
    if (msg.COMMAND === 'IGNORE' && typeof msg.DATA === 'string') {
      st.listening.delete(msg.DATA);
      return;
    }

    // Tarayıcı tarafı
    if (msg.type === 'HELLO_BROWSER') {
      st.isBrowser = true;
      ws.send(JSON.stringify({
        type: 'STATE',
        device: { name: DEVICE_NAME, type: DEVICE_TYPE, port: PORT, addresses: getLocalIPs() },
        params: PARAMS,
        values: Object.fromEntries(values),
      }));
      broadcastClientCount();
      return;
    }
    if (msg.type === 'SET' && typeof msg.path === 'string') {
      setValue(msg.path, msg.value, 'browser');
      return;
    }
  });

  ws.on('close', () => {
    wsState.delete(ws);
    broadcastClientCount();
    console.log(`  ❌ WS koptu: ${ip}`);
  });
});

// ============ BAŞLATMA ============
function getLocalIPs() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({ iface: name, address: iface.address });
      }
    }
  }
  return out;
}

server.listen(PORT, () => {
  const ips = getLocalIPs();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${DEVICE_NAME}  (OSCQuery cihazı)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Tarayıcı UI:    http://localhost:${PORT}/ui/`);
  console.log(`  OSCQuery JSON:  http://localhost:${PORT}/`);
  console.log(`  Bu makinenin IP adresleri:`);
  for (const ip of ips) console.log(`     ${ip.iface}  →  ${ip.address}`);
  console.log('');
  console.log(`  HUB MANIFESTİ İÇİN ÖRNEK:`);
  console.log(`  ─────────────────────────────`);
  console.log(JSON.stringify({
    id: 99,
    name: DEVICE_NAME,
    type: DEVICE_TYPE,
    host: ips[0]?.address || '127.0.0.1',
    oscQueryPort: PORT,
    enabled: true,
    description: 'Tarayıcı tabanlı test enstrümanı'
  }, null, 2));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  publishBonjour();
});

// ============ BONJOUR DUYURUSU ============
const bonjour = new Bonjour();
function publishBonjour() {
  bonjour.publish({ name: DEVICE_NAME, type: 'oscjson', protocol: 'tcp', port: PORT });
  console.log(`  📡 Bonjour: _oscjson._tcp · ${DEVICE_NAME} · port ${PORT}`);
}

process.on('SIGINT', () => {
  console.log('\nKapatılıyor...');
  bonjour.unpublishAll(() => {
    bonjour.destroy();
    server.close();
    for (const ws of wsState.keys()) ws.close();
    process.exit(0);
  });
});
