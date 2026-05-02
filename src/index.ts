import osc from 'osc';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import { createServer } from 'http';
import { readdirSync, readFileSync, writeFileSync, watch } from 'fs';
import { join } from 'path';
import dgram from 'dgram';
import { OscQueryClient } from './oscquery-client.js';

// ============ AYARLAR ============
const HTTP_PORT = 5555;
const OSC_PORT = 5006;
const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 10000;
const HUB_NAME = 'OSCQuery Hub';
const MANIFESTS_DIR = './manifests';

// ============ MANIFEST TYPES ============
interface DeviceManifest {
  id: number;
  name: string;
  type: string;
  host: string;
  oscQueryPort: number;
  enabled: boolean;
  description: string;
  status?: 'configured' | 'connecting' | 'connected' | 'lost' | 'disabled' | 'error';
  lastMessageAt?: number;
  paramCount?: number;
}

const devices = new Map<number, DeviceManifest>();
const manifestFilenames = new Map<number, string>();
const oscQueryClients = new Map<number, OscQueryClient>();
const deviceMsgCount = new Map<number, number>();

let suppressWatcher = false;

// ============ MANIFEST YÜKLEYİCİ ============
function loadManifests() {
  const before = devices.size;
  const oldDevices = new Map(devices);
  devices.clear();
  manifestFilenames.clear();

  try {
    const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = readFileSync(join(MANIFESTS_DIR, file), 'utf-8');
        const manifest = JSON.parse(content) as DeviceManifest;
        manifest.status = manifest.enabled ? 'configured' : 'disabled';

        if (devices.has(manifest.id)) {
          console.log(`  ⚠  Çakışma: ID ${manifest.id} zaten var (${file})`);
          continue;
        }

        devices.set(manifest.id, manifest);
        manifestFilenames.set(manifest.id, file);
      } catch (e) {
        console.log(`  ⚠  Manifest okuma hatası (${file}):`, (e as Error).message);
      }
    }

    console.log(`  📋 Manifest yüklendi: ${devices.size} cihaz (önceki: ${before})`);

    // Reconcile clients: yeni manifestlere göre bağlantıları ayarla
    reconcileClients(oldDevices);

    broadcastToClients({
      type: 'DEVICES_RELOADED',
      devices: Array.from(devices.values())
    });
  } catch (e) {
    console.log(`  ⚠  manifests/ klasörü okunamadı:`, (e as Error).message);
  }
}

// ============ CLIENT YÖNETİMİ ============
function reconcileClients(oldDevices: Map<number, DeviceManifest>) {
  // Eski cihazlar artık yok veya değişmiş → disconnect
  for (const [id, oldDev] of oldDevices.entries()) {
    const newDev = devices.get(id);
    const shouldDisconnect = !newDev
      || !newDev.enabled
      || newDev.host !== oldDev.host
      || newDev.oscQueryPort !== oldDev.oscQueryPort;

    if (shouldDisconnect && oscQueryClients.has(id)) {
      const client = oscQueryClients.get(id)!;
      client.disconnect();
      oscQueryClients.delete(id);
      console.log(`  🔌 Disconnect: ${oldDev.name}`);
    }
  }

  // Yeni / aktif cihazlara connect
  for (const dev of devices.values()) {
    if (!dev.enabled) continue;
    if (oscQueryClients.has(dev.id)) continue;  // zaten bağlı

    connectToDevice(dev);
  }
}

function connectToDevice(dev: DeviceManifest) {
  console.log(`  🔗 Bağlanılıyor: ${dev.name} → ${dev.host}:${dev.oscQueryPort}`);
  dev.status = 'connecting';
  broadcastDeviceUpdate(dev);

  const client = new OscQueryClient(dev.host, dev.oscQueryPort, {
    onConnect: () => {
      dev.status = 'connected';
      dev.lastMessageAt = Date.now();
      const ns = client.lastNamespace;
      if (ns) {
        const count = countParams(ns);
        dev.paramCount = count;
        console.log(`  ✅ ${dev.name} bağlı (${count} parametre)`);
      }
      broadcastDeviceUpdate(dev);
    },
    onDisconnect: (reason) => {
      dev.status = 'lost';
      console.log(`  ❌ ${dev.name} koptu: ${reason}`);
      broadcastDeviceUpdate(dev);
    },
    onLog: (msg) => {
      console.log(`     [${dev.name}] ${msg}`);
    },
    onValue: (path, value) => {
      handleClientValue(dev, path, value);
    }
  });

  oscQueryClients.set(dev.id, client);
  client.connect();
}

function countParams(node: any): number {
  let count = 0;
  if (node.TYPE !== undefined) count++;
  if (node.CONTENTS) {
    for (const child of Object.values(node.CONTENTS as any)) {
      count += countParams(child);
    }
  }
  return count;
}

function handleClientValue(dev: DeviceManifest, path: string, value: any) {
  dev.lastMessageAt = Date.now();
  dev.status = 'connected';

  // Sayaç
  deviceMsgCount.set(dev.id, (deviceMsgCount.get(dev.id) || 0) + 1);

  // Namespace'e kaydet (Hub'ın kendi namespace'i altında, cihaz adıyla)
  // Örn: /Tablet2/HandR0/palm/Tx
  const hubPath = `/${dev.name}${path}`;
  const v = Array.isArray(value) ? value : [value];
  const firstVal = v[0];
  const type = typeof firstVal === 'number'
    ? (Number.isInteger(firstVal) ? 'i' : 'f')
    : (typeof firstVal === 'boolean' ? (firstVal ? 'T' : 'F') : 's');

  namespace.set(hubPath, {
    fullPath: hubPath,
    type,
    value: v,
    lastUpdate: Date.now(),
    source: `${dev.host}:${dev.oscQueryPort}`,
    deviceId: dev.id
  });

  // Tarayıcılara duyur
  broadcastToClients({
    type: 'PATH_CHANGED',
    path: hubPath,
    value: v,
    paramType: type,
    source: `${dev.host}:${dev.oscQueryPort}`,
    deviceId: dev.id,
    deviceName: dev.name,
    isNew: false,
    timestamp: Date.now()
  });

  // Ableton'a forward — eski sistem formatı
  if (dev.enabled) {
    forwardToAbleton(dev.id, path, v, type);
  }
}

function broadcastDeviceUpdate(dev: DeviceManifest) {
  broadcastToClients({ type: 'DEVICE_UPDATED', device: dev });
}

// ============ MANIFEST KAYDET ============
function saveManifest(deviceId: number, updates: Partial<DeviceManifest>): { ok: boolean; error?: string } {
  const dev = devices.get(deviceId);
  const filename = manifestFilenames.get(deviceId);

  if (!dev || !filename) {
    return { ok: false, error: `Cihaz bulunamadı: ID ${deviceId}` };
  }

  const updated: DeviceManifest = {
    id: dev.id,
    name: updates.name ?? dev.name,
    type: dev.type,
    host: updates.host ?? dev.host,
    oscQueryPort: updates.oscQueryPort ?? dev.oscQueryPort,
    enabled: updates.enabled ?? dev.enabled,
    description: updates.description ?? dev.description,
  };

  try {
    suppressWatcher = true;
    const filePath = join(MANIFESTS_DIR, filename);
    writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

    const oldDev = { ...dev };
    const newDev: DeviceManifest = { ...updated, status: updated.enabled ? 'configured' : 'disabled' };
    devices.set(deviceId, newDev);

    console.log(`  💾 Manifest kaydedildi: ${dev.name} (ID ${deviceId})`);
    if (updates.host !== undefined) console.log(`     host: ${oldDev.host} → ${updated.host}`);
    if (updates.oscQueryPort !== undefined) console.log(`     port: ${oldDev.oscQueryPort} → ${updated.oscQueryPort}`);
    if (updates.enabled !== undefined) console.log(`     enabled: ${oldDev.enabled} → ${updated.enabled}`);

    // Bağlantıları yenile
    const oldMap = new Map(devices);
    oldMap.set(deviceId, oldDev);
    reconcileClients(oldMap);

    setTimeout(() => { suppressWatcher = false; }, 500);

    broadcastToClients({ type: 'DEVICE_UPDATED', device: newDev });
    return { ok: true };
  } catch (e) {
    suppressWatcher = false;
    return { ok: false, error: (e as Error).message };
  }
}

// ============ NAMESPACE STORAGE ============
interface Parameter {
  fullPath: string;
  type: string;
  value: any;
  lastUpdate: number;
  source: string;
  deviceId?: number;
}

const namespace = new Map<string, Parameter>();

interface OscSubscriber { address: string; port: number; registeredAt: number; }
const oscSubscribers = new Map<string, OscSubscriber>();
function subscriberKey(addr: string, port: number) { return `${addr}:${port}`; }

const wsClients = new Set<WebSocket>();
function broadcastToClients(data: any) {
  const message = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function oscTypeToQueryType(oscType: string): string {
  const map: Record<string, string> = { 'f': 'f', 'i': 'i', 's': 's', 'T': 'T', 'F': 'F', 'd': 'd' };
  return map[oscType] || 's';
}

// ============ ABLETON FORWARDER ============
// dgram ile manuel OSC encode — slash olmadan adres gönderebilmek için
const abletonSocket = dgram.createSocket('udp4');

function oscPad(buf: Buffer): Buffer {
  const padded = Math.ceil(buf.length / 4) * 4;
  const out = Buffer.alloc(padded);
  buf.copy(out);
  return out;
}

function encodeOscString(s: string): Buffer {
  return oscPad(Buffer.from(s + '\0', 'utf8'));
}

function buildOscMessage(address: string, path: string, value: number, isInt: boolean): Buffer {
  const addrBuf  = encodeOscString(address);
  const typeBuf  = encodeOscString(isInt ? ',si' : ',sf');
  const pathBuf  = encodeOscString(path);
  const valBuf   = Buffer.alloc(4);
  if (isInt) valBuf.writeInt32BE(Math.round(value), 0);
  else       valBuf.writeFloatBE(value, 0);
  return Buffer.concat([addrBuf, typeBuf, pathBuf, valBuf]);
}

let ableton_msgs_sent = 0;
function forwardToAbleton(deviceId: number, paramName: string, value: any, type: string) {
  const address = `device${deviceId}`;
  const vals = Array.isArray(value) ? value : [value];
  const v = vals[0];
  const isInt = type === 'i' && Number.isInteger(v);
  const packet = buildOscMessage(address, paramName, typeof v === 'number' ? v : 0, isInt);
  abletonSocket.send(packet, ABLETON_PORT, ABLETON_HOST);
  ableton_msgs_sent++;
}

function broadcastToOsc(path: string, value: any, type: string, exceptSource?: string) {
  const args = (Array.isArray(value) ? value : [value]).map((v) => {
    let oscType = type;
    if (typeof v === 'number') oscType = Number.isInteger(v) && type === 'i' ? 'i' : 'f';
    return { type: oscType, value: v };
  });
  for (const sub of oscSubscribers.values()) {
    const subKey = subscriberKey(sub.address, sub.port);
    if (exceptSource && subKey === exceptSource) continue;
    udpPort.send({ address: path, args }, sub.address, sub.port);
  }
}

// ============ OSC DİNLEYİCİ ============
const udpPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: OSC_PORT,
  metadata: true
});

udpPort.on('ready', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${HUB_NAME} — Aşama 8 (OSCQuery Client)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  OSC dinleniyor:    UDP port ${OSC_PORT}`);
  console.log(`  Ableton'a forward: UDP ${ABLETON_HOST}:${ABLETON_PORT}`);
  console.log(`  HTTP server:       http://localhost:${HTTP_PORT}`);
  console.log(`  Web arayüz:        http://localhost:${HTTP_PORT}/ui/`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  loadManifests();

  try {
    watch(MANIFESTS_DIR, { persistent: false }, () => {
      if (suppressWatcher) return;
      console.log('  📋 Manifest klasörü değişti, yeniden yükleniyor...');
      setTimeout(loadManifests, 100);
    });
  } catch (_e) {
    console.log('  ⚠  Manifest watcher başlatılamadı');
  }
});

udpPort.on('message', (oscMsg: any, _timeTag: any, info: any) => {
  const time = new Date().toISOString().substring(11, 23);
  const from = info ? `${info.address}:${info.port}` : 'unknown';

  if (oscMsg.address === '/subscribe' && info) {
    const port = oscMsg.args[0]?.value;
    if (typeof port === 'number') {
      oscSubscribers.set(subscriberKey(info.address, port), {
        address: info.address, port, registeredAt: Date.now()
      });
      console.log(`  📡 Abone oldu: ${info.address}:${port}`);
      broadcastToClients({ type: 'SUBSCRIBERS_CHANGED', subscribers: Array.from(oscSubscribers.values()) });
    }
    return;
  }

  if (oscMsg.address === '/unsubscribe' && info) {
    const port = oscMsg.args[0]?.value;
    if (typeof port === 'number') {
      oscSubscribers.delete(subscriberKey(info.address, port));
      broadcastToClients({ type: 'SUBSCRIBERS_CHANGED', subscribers: Array.from(oscSubscribers.values()) });
    }
    return;
  }

  // Direkt UDP'den gelen mesajlar (eski tarz)
  const args = oscMsg.args.map((a: any) => ({ type: a.type, value: a.value }));
  const param: Parameter = {
    fullPath: oscMsg.address,
    type: args.length > 0 ? oscTypeToQueryType(args[0].type) : 's',
    value: args.map((a: any) => a.value),
    lastUpdate: Date.now(),
    source: from
  };
  const isNew = !namespace.has(oscMsg.address);
  namespace.set(oscMsg.address, param);

  const marker = isNew ? '🆕' : '  ';
  const valStr = args.map((a: any) => `${a.value}(${a.type})`).join(', ');
  console.log(`${marker} [${time}] [UDP-direct] ${oscMsg.address.padEnd(28)} → ${valStr}`);

  broadcastToClients({
    type: 'PATH_CHANGED', path: oscMsg.address, value: param.value,
    paramType: param.type, source: from, isNew, timestamp: param.lastUpdate
  });

  broadcastToOsc(oscMsg.address, param.value, param.type, from);
});

udpPort.on('error', (err: Error) => {
  console.error('OSC HATASI:', err.message);
});

udpPort.open();

// ============ NAMESPACE TREE ============
function buildTree(): any {
  const root: any = { FULL_PATH: '/', DESCRIPTION: HUB_NAME, CONTENTS: {} };
  for (const [path, param] of namespace.entries()) {
    const parts = path.split('/').filter(p => p.length > 0);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = '/' + parts.slice(0, i + 1).join('/');
      if (!current.CONTENTS) current.CONTENTS = {};
      if (!current.CONTENTS[part]) current.CONTENTS[part] = { FULL_PATH: fullPath };
      if (isLast) {
        current.CONTENTS[part].TYPE = param.type;
        current.CONTENTS[part].VALUE = param.value;
        current.CONTENTS[part].ACCESS = 3;
        current.CONTENTS[part].DESCRIPTION = `From ${param.source}`;
      }
      current = current.CONTENTS[part];
    }
  }
  return root;
}

// ============ HTTP SERVER ============
const app = express();
app.use((_req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });
app.use('/ui', express.static('web'));
app.use(express.json());

app.get('/', (req, res) => {
  if ('HOST_INFO' in req.query) {
    return res.json({
      NAME: HUB_NAME, OSC_PORT, OSC_TRANSPORT: 'UDP',
      EXTENSIONS: { ACCESS: true, VALUE: true, DESCRIPTION: true, TYPE: true, OSC_STREAMING: true }
    });
  }
  res.json(buildTree());
});

app.get('/_devices', (_req, res) => {
  const devs = Array.from(devices.values()).map(d => ({
    ...d,
    msgCount: deviceMsgCount.get(d.id) || 0
  }));
  res.json({ devices: devs, self: { name: HUB_NAME, port: HTTP_PORT, oscPort: OSC_PORT } });
});

app.get('/_status', (_req, res) => {
  res.json({
    namespace_size: namespace.size,
    ws_clients: wsClients.size,
    osc_subscribers: Array.from(oscSubscribers.values()),
    devices: Array.from(devices.values()),
    ableton_msgs_sent
  });
});

app.get(/^\/(.+)/, (req, res) => {
  const path = '/' + req.params[0];
  const param = namespace.get(path);
  if (param) {
    res.json({ FULL_PATH: path, TYPE: param.type, VALUE: param.value, ACCESS: 3,
      DESCRIPTION: `From ${param.source}` });
  } else {
    const tree = buildTree();
    const parts = path.split('/').filter(p => p.length > 0);
    let current = tree;
    for (const part of parts) {
      if (current.CONTENTS && current.CONTENTS[part]) current = current.CONTENTS[part];
      else return res.status(404).json({ error: 'Not found' });
    }
    res.json(current);
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`  🔌 WS bağlantı: ${ip}`);
  wsClients.add(ws);

  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    namespace: buildTree(),
    devices: Array.from(devices.values()),
    subscribers: Array.from(oscSubscribers.values()),
    discoveredDevices: Array.from(discoveredDevices.values())
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'SET' && msg.path && msg.value !== undefined) {
        const newValue = Array.isArray(msg.value) ? msg.value : [msg.value];
        const existing = namespace.get(msg.path);
        const param: Parameter = existing || {
          fullPath: msg.path,
          type: typeof msg.value === 'number' ? 'f' : 's',
          value: newValue, lastUpdate: Date.now(), source: `web:${ip}`
        };
        param.value = newValue;
        param.lastUpdate = Date.now();
        param.source = `web:${ip}`;
        namespace.set(msg.path, param);

        broadcastToClients({
          type: 'PATH_CHANGED', path: msg.path, value: param.value,
          paramType: param.type, source: param.source, isNew: !existing,
          timestamp: param.lastUpdate
        });
        broadcastToOsc(msg.path, param.value, param.type);
      }

      if (msg.type === 'UPDATE_DEVICE' && typeof msg.deviceId === 'number') {
        const result = saveManifest(msg.deviceId, msg.updates || {});
        ws.send(JSON.stringify({
          type: 'UPDATE_DEVICE_RESULT', deviceId: msg.deviceId,
          ok: result.ok, error: result.error
        }));
      }

      if (msg.type === 'RECONNECT_DEVICE' && typeof msg.deviceId === 'number') {
        const dev = devices.get(msg.deviceId);
        if (dev && dev.enabled) {
          if (oscQueryClients.has(dev.id)) {
            oscQueryClients.get(dev.id)!.disconnect();
            oscQueryClients.delete(dev.id);
          }
          connectToDevice(dev);
        }
      }

      if (msg.type === 'RELOAD_MANIFESTS') loadManifests();

      if (msg.type === 'ADD_DISCOVERED' && msg.host && msg.port) {
        const nextId = Math.max(0, ...Array.from(devices.keys())) + 1;
        const name = (msg.name || `Device${nextId}`).trim();
        const manifest = {
          id: nextId,
          name,
          type: 'oscquery-device',
          host: msg.host,
          oscQueryPort: msg.port,
          enabled: true,
          description: `Bonjour ile keşfedildi`
        };
        const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${nextId}.json`;
        writeFileSync(join(MANIFESTS_DIR, filename), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
        discoveredDevices.delete(`${msg.host}:${msg.port}`);
        console.log(`  ➕ Yeni cihaz eklendi: ${name} (ID ${nextId})`);
        loadManifests();
        broadcastDiscovered();
      }
    } catch (e) {
      console.error('  ⚠  WS mesaj hatası:', e);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

server.listen(HTTP_PORT, () => { publishBonjour(); startDiscovery(); });

const bonjour = new Bonjour();
function publishBonjour() {
  bonjour.publish({ name: HUB_NAME, type: 'oscjson', protocol: 'tcp', port: HTTP_PORT });
  bonjour.publish({ name: HUB_NAME, type: 'osc', protocol: 'udp', port: OSC_PORT });
  console.log('  Bonjour duyuruldu  ✓');
}

// ============ BONJOUR DISCOVERY ============
interface DiscoveredDevice { name: string; host: string; port: number; firstSeen: number; }
const discoveredDevices = new Map<string, DiscoveredDevice>();

function isAlreadyKnown(host: string, port: number): boolean {
  return Array.from(devices.values()).some(d => d.host === host && d.oscQueryPort === port);
}

function broadcastDiscovered() {
  broadcastToClients({ type: 'DISCOVERED_DEVICES', devices: Array.from(discoveredDevices.values()) });
}

function startDiscovery() {
  const browser = bonjour.find({ type: 'oscjson', protocol: 'tcp' });

  browser.on('up', (service: any) => {
    const ipv4 = (service.addresses as string[] || []).find(a => a.includes('.'));
    const host = ipv4 || service.host;
    const port = service.port as number;
    if (port === HTTP_PORT) return;          // kendimiz
    if (isAlreadyKnown(host, port)) return;  // zaten manifest'te

    const key = `${host}:${port}`;
    discoveredDevices.set(key, { name: service.name, host, port, firstSeen: Date.now() });
    console.log(`  🔍 Yeni cihaz keşfedildi: ${service.name} @ ${host}:${port}`);
    broadcastDiscovered();
  });

  browser.on('down', (service: any) => {
    const ipv4 = (service.addresses as string[] || []).find((a: string) => a.includes('.'));
    const host = ipv4 || service.host;
    const key = `${host}:${service.port}`;
    if (discoveredDevices.delete(key)) broadcastDiscovered();
  });
}

// ============ M4L GERİ KANAL (port 8888) ============
const feedbackSocket = dgram.createSocket('udp4');

feedbackSocket.on('message', (buf) => {
  try {
    // OSC olarak dene
    const packet = osc.readPacket(buf, { metadata: true }) as any;
    const address: string = packet.address || '';
    const m = address.match(/\/?device(\d+)/i);
    if (!m) return;
    const deviceId = parseInt(m[1]);
    const args = packet.args || [];
    const path   = args[0]?.value ?? args[0] ?? '';
    const value  = args[1]?.value ?? args[1] ?? 0;
    broadcastToClients({ type: 'M4L_FEEDBACK', deviceId, path, value });
    console.log(`  ◄ M4L [device${deviceId}] ${path} = ${value}`);
  } catch {
    // OSC değil — ham baytları logla, format tespiti için
    const hex = buf.slice(0, 24).toString('hex').replace(/(.{2})/g, '$1 ');
    const txt = buf.slice(0, 24).toString('utf8').replace(/[^\x20-\x7e]/g, '·');
    console.log(`  ◄ M4L [ham] ${buf.length}b  hex: ${hex.trim()}  txt: ${txt}`);
  }
});

feedbackSocket.bind(8889, () => {
  console.log('  ◄ M4L geri kanal:   UDP port 8889');
});

// Periyodik olarak msg count'u tarayıcıya gönder
setInterval(() => {
  if (deviceMsgCount.size === 0) return;
  const counts: Record<number, number> = {};
  for (const [id, c] of deviceMsgCount.entries()) counts[id] = c;
  broadcastToClients({ type: 'DEVICE_MSG_COUNTS', counts, abletonTotal: ableton_msgs_sent });
}, 500);

process.on('SIGINT', () => {
  console.log('\nKapatılıyor...');
  for (const client of oscQueryClients.values()) client.disconnect();
  bonjour.unpublishAll(() => {
    bonjour.destroy();
    udpPort.close();
    feedbackSocket.close();
    for (const client of wsClients) client.close();
    process.exit(0);
  });
});
