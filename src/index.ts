import osc from 'osc';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import { createServer } from 'http';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  watch,
  unlinkSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import dgram from 'dgram';
import { OscQueryClient } from './oscquery-client.js';

// ============ AYARLAR ============
const HTTP_PORT = 5555;
const OSC_PORT = 5006;
const JSON_UDP_PORT = 5007;
const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 10000;
const HUB_NAME = 'OSCQuery Hub';
const MANIFESTS_DIR = './manifests';
const RECORDINGS_DIR = './recordings';

// ============ GÜVENLİK SABİTLERİ ============
const MAX_SUBSCRIBERS = 50;
const MAX_NAMESPACE = 10_000;
const OSC_PATH_RE = /^\/[a-zA-Z0-9_./-]{1,256}$/;

function isValidHost(host: string): boolean {
  return (
    /^(localhost|127\.0\.0\.1|((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?))$/.test(
      host
    ) || /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/.test(host)
  );
}
function isValidOscPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

// ============ MANIFEST TYPES ============
interface DeviceManifest {
  id: number;
  name: string;
  type: string;
  host: string;
  oscQueryPort: number;
  enabled: boolean;
  description: string;
  permanent?: boolean;
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

        if (devices.has(manifest.id)) {
          console.log(`  ⚠  Çakışma: ID ${manifest.id} zaten var (${file})`);
          continue;
        }

        // Aynı id'de mevcut bir bağlantı varsa ve host/port değişmediyse runtime state'i koru
        const old = oldDevices.get(manifest.id);
        const sameEndpoint =
          old &&
          old.host === manifest.host &&
          old.oscQueryPort === manifest.oscQueryPort &&
          old.enabled === manifest.enabled &&
          oscQueryClients.has(manifest.id);

        if (sameEndpoint) {
          manifest.status = old!.status;
          manifest.lastMessageAt = old!.lastMessageAt;
          manifest.paramCount = old!.paramCount;
        } else {
          manifest.status = manifest.enabled ? 'configured' : 'disabled';
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
      devices: Array.from(devices.values()),
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
    const shouldDisconnect =
      !newDev ||
      !newDev.enabled ||
      newDev.host !== oldDev.host ||
      newDev.oscQueryPort !== oldDev.oscQueryPort;

    if (shouldDisconnect && oscQueryClients.has(id)) {
      const client = oscQueryClients.get(id)!;
      client.disconnect();
      oscQueryClients.delete(id);
      console.log(`  🔌 Disconnect: ${oldDev.name}`);
    }

    // Manifest tamamen silindiyse sayaçları da temizle
    if (!newDev) {
      deviceMsgCount.delete(id);
    }
  }

  // Yeni / aktif cihazlara connect
  for (const dev of devices.values()) {
    if (!dev.enabled) continue;
    if (oscQueryClients.has(dev.id)) continue; // zaten bağlı

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
    onDisconnect: reason => {
      dev.status = 'lost';
      console.log(`  ❌ ${dev.name} koptu: ${reason}`);
      broadcastDeviceUpdate(dev);
    },
    onLog: msg => {
      console.log(`     [${dev.name}] ${msg}`);
    },
    onValue: (path, value) => {
      handleClientValue(dev, path, value);
    },
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

// ============ RECORDING / PLAYBACK ============
interface RecordingEvent {
  t: number;
  path: string;
  value: any;
}
interface RecordingSession {
  deviceId: number;
  deviceName: string;
  startedAt: number;
  events: RecordingEvent[];
}
interface PlaybackSession {
  deviceId: number;
  events: RecordingEvent[];
  index: number;
  timer: NodeJS.Timeout | null;
  loop: boolean;
  file: string;
  startedAt: number;
}

const recordings = new Map<number, RecordingSession>(); // aktif kayıtlar
const playbacks = new Map<number, PlaybackSession>(); // aktif oynatmalar

function ensureRecordingsDir() {
  if (!existsSync(RECORDINGS_DIR)) mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function startRecording(deviceId: number): { ok: boolean; error?: string } {
  const dev = devices.get(deviceId);
  if (!dev) return { ok: false, error: 'device not found' };
  if (recordings.has(deviceId)) return { ok: false, error: 'already recording' };
  recordings.set(deviceId, {
    deviceId,
    deviceName: dev.name,
    startedAt: Date.now(),
    events: [],
  });
  console.log(`  ● REC start: ${dev.name} (ID ${deviceId})`);
  broadcastToClients({ type: 'REC_STATE', deviceId, recording: true });
  return { ok: true };
}

function stopRecording(deviceId: number): {
  ok: boolean;
  file?: string;
  events?: number;
  error?: string;
} {
  const rec = recordings.get(deviceId);
  if (!rec) return { ok: false, error: 'not recording' };
  recordings.delete(deviceId);

  const duration = Date.now() - rec.startedAt;
  const data = {
    deviceId: rec.deviceId,
    deviceName: rec.deviceName,
    recordedAt: rec.startedAt,
    durationMs: duration,
    eventCount: rec.events.length,
    events: rec.events,
  };
  const slug = rec.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const stamp = new Date(rec.startedAt).toISOString().replace(/[:.]/g, '-');
  const filename = `${slug}_${stamp}.json`;
  ensureRecordingsDir();
  writeFileSync(join(RECORDINGS_DIR, filename), JSON.stringify(data, null, 2) + '\n', 'utf-8');

  console.log(
    `  ■ REC stop:  ${rec.deviceName} → ${filename} (${rec.events.length} events, ${(duration / 1000).toFixed(1)}s)`
  );
  broadcastToClients({
    type: 'REC_STATE',
    deviceId,
    recording: false,
    file: filename,
    events: rec.events.length,
  });
  broadcastRecordings();
  return { ok: true, file: filename, events: rec.events.length };
}

function listRecordings() {
  ensureRecordingsDir();
  const files = readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
  return files.map(f => {
    try {
      const meta = JSON.parse(readFileSync(join(RECORDINGS_DIR, f), 'utf-8'));
      return {
        file: f,
        deviceId: meta.deviceId,
        deviceName: meta.deviceName,
        recordedAt: meta.recordedAt,
        durationMs: meta.durationMs,
        eventCount: meta.eventCount ?? meta.events?.length ?? 0,
      };
    } catch {
      return { file: f, error: 'parse failed' };
    }
  });
}

function broadcastRecordings() {
  broadcastToClients({ type: 'RECORDINGS_LIST', recordings: listRecordings() });
}

function startPlayback(
  deviceId: number,
  file: string,
  opts: { loop?: boolean } = {}
): { ok: boolean; error?: string; events?: number } {
  const dev = devices.get(deviceId);
  if (!dev) return { ok: false, error: 'device not found' };
  if (playbacks.has(deviceId)) return { ok: false, error: 'already playing' };

  const safeFile = file.replace(/[/\\]/g, '');
  const fullPath = join(RECORDINGS_DIR, safeFile);
  if (!existsSync(fullPath)) return { ok: false, error: 'file not found' };

  let data: any;
  try {
    data = JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch (e) {
    return { ok: false, error: 'parse error: ' + (e as Error).message };
  }
  const events: RecordingEvent[] = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) return { ok: false, error: 'no events in recording' };

  const session: PlaybackSession = {
    deviceId,
    events,
    index: 0,
    timer: null,
    loop: !!opts.loop,
    file: safeFile,
    startedAt: Date.now(),
  };
  playbacks.set(deviceId, session);

  console.log(
    `  ▶ PLAY start: ${dev.name} ← ${safeFile} (${events.length} events${opts.loop ? ', loop' : ''})`
  );
  broadcastToClients({ type: 'PLAY_STATE', deviceId, playing: true, file: safeFile });

  schedulePlaybackTick(deviceId);
  return { ok: true, events: events.length };
}

function schedulePlaybackTick(deviceId: number) {
  const session = playbacks.get(deviceId);
  if (!session) return;
  const dev = devices.get(deviceId);
  if (!dev) {
    stopPlayback(deviceId);
    return;
  }

  const ev = session.events[session.index];
  if (!ev) {
    if (session.loop) {
      session.index = 0;
      session.startedAt = Date.now();
      schedulePlaybackTick(deviceId);
    } else {
      stopPlayback(deviceId);
    }
    return;
  }

  const elapsed = Date.now() - session.startedAt;
  const delay = Math.max(0, ev.t - elapsed);
  session.timer = setTimeout(() => {
    handleClientValue(dev, ev.path, ev.value);
    session.index++;
    schedulePlaybackTick(deviceId);
  }, delay);
}

function stopPlayback(deviceId: number): { ok: boolean; error?: string } {
  const session = playbacks.get(deviceId);
  if (!session) return { ok: false, error: 'not playing' };
  if (session.timer) clearTimeout(session.timer);
  playbacks.delete(deviceId);
  const dev = devices.get(deviceId);
  console.log(`  ■ PLAY stop:  ${dev?.name ?? 'ID ' + deviceId}`);
  broadcastToClients({ type: 'PLAY_STATE', deviceId, playing: false });
  return { ok: true };
}

function handleClientValue(dev: DeviceManifest, path: string, value: any) {
  // Kayıt aktifse buffer'a ekle — gerçek cihazdan gelen değer
  const rec = recordings.get(dev.id);
  if (rec) {
    const t = Date.now() - rec.startedAt;
    rec.events.push({ t, path, value });
  }

  dev.lastMessageAt = Date.now();
  dev.status = 'connected';

  // Sayaç
  deviceMsgCount.set(dev.id, (deviceMsgCount.get(dev.id) || 0) + 1);

  // Namespace'e kaydet (Hub'ın kendi namespace'i altında, cihaz adıyla)
  // Örn: /Tablet2/HandR0/palm/Tx
  const hubPath = `/${dev.name}${path}`;
  const v = Array.isArray(value) ? value : [value];
  const firstVal = v[0];
  const type =
    typeof firstVal === 'number'
      ? Number.isInteger(firstVal)
        ? 'i'
        : 'f'
      : typeof firstVal === 'boolean'
        ? firstVal
          ? 'T'
          : 'F'
        : 's';

  namespace.set(hubPath, {
    fullPath: hubPath,
    type,
    value: v,
    lastUpdate: Date.now(),
    source: `${dev.host}:${dev.oscQueryPort}`,
    deviceId: dev.id,
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
    timestamp: Date.now(),
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
function saveManifest(
  deviceId: number,
  updates: Partial<DeviceManifest>
): { ok: boolean; error?: string } {
  const dev = devices.get(deviceId);
  const filename = manifestFilenames.get(deviceId);

  if (!dev || !filename) {
    return { ok: false, error: `Cihaz bulunamadı: ID ${deviceId}` };
  }

  if (updates.host !== undefined && !isValidHost(updates.host)) {
    return { ok: false, error: `Geçersiz host: ${updates.host}` };
  }
  if (updates.oscQueryPort !== undefined && !isValidOscPort(updates.oscQueryPort)) {
    return { ok: false, error: `Geçersiz port: ${updates.oscQueryPort}` };
  }
  if (
    updates.name !== undefined &&
    (updates.name.trim().length === 0 || updates.name.length > 64)
  ) {
    return { ok: false, error: 'Geçersiz cihaz adı' };
  }

  const updated: DeviceManifest = {
    id: dev.id,
    name: updates.name ?? dev.name,
    type: dev.type,
    host: updates.host ?? dev.host,
    oscQueryPort: updates.oscQueryPort ?? dev.oscQueryPort,
    enabled: updates.enabled ?? dev.enabled,
    description: updates.description ?? dev.description,
    ...(dev.permanent !== undefined && { permanent: dev.permanent }),
  };

  try {
    suppressWatcher = true;
    const filePath = join(MANIFESTS_DIR, filename);
    writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

    const oldDev = { ...dev };
    const newDev: DeviceManifest = {
      ...updated,
      status: updated.enabled ? 'configured' : 'disabled',
    };
    devices.set(deviceId, newDev);

    console.log(`  💾 Manifest kaydedildi: ${dev.name} (ID ${deviceId})`);
    if (updates.host !== undefined) console.log(`     host: ${oldDev.host} → ${updated.host}`);
    if (updates.oscQueryPort !== undefined)
      console.log(`     port: ${oldDev.oscQueryPort} → ${updated.oscQueryPort}`);
    if (updates.enabled !== undefined)
      console.log(`     enabled: ${oldDev.enabled} → ${updated.enabled}`);

    // Bağlantıları yenile
    const oldMap = new Map(devices);
    oldMap.set(deviceId, oldDev);
    reconcileClients(oldMap);

    setTimeout(() => {
      suppressWatcher = false;
    }, 500);

    broadcastToClients({ type: 'DEVICE_UPDATED', device: newDev });
    return { ok: true };
  } catch (e) {
    suppressWatcher = false;
    return { ok: false, error: (e as Error).message };
  }
}

function deleteDevice(deviceId: number): { ok: boolean; error?: string } {
  const dev = devices.get(deviceId);
  const filename = manifestFilenames.get(deviceId);

  if (!dev || !filename) {
    return { ok: false, error: `Device not found: ID ${deviceId}` };
  }

  try {
    suppressWatcher = true;

    // 1. Disconnect any active OSCQuery client
    const client = oscQueryClients.get(deviceId);
    if (client) {
      client.disconnect();
      oscQueryClients.delete(deviceId);
    }

    // 2. Remove namespace entries owned by this device (prefix /<name>/)
    const prefix = `/${dev.name}/`;
    let removed = 0;
    for (const path of [...namespace.keys()]) {
      if (path === `/${dev.name}` || path.startsWith(prefix)) {
        namespace.delete(path);
        removed++;
      }
    }

    // 3. Delete manifest file
    const filePath = join(MANIFESTS_DIR, filename);
    unlinkSync(filePath);

    // 4. Clean in-memory maps
    devices.delete(deviceId);
    manifestFilenames.delete(deviceId);
    deviceMsgCount.delete(deviceId);

    console.log(
      `  🗑  Device deleted: ${dev.name} (ID ${deviceId}) — ${filename}, ${removed} namespace entries`
    );

    setTimeout(() => {
      suppressWatcher = false;
    }, 500);

    broadcastToClients({ type: 'DEVICES_RELOADED', devices: Array.from(devices.values()) });
    broadcastToClients({ type: 'DEVICE_DELETED', deviceId });
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

interface OscSubscriber {
  address: string;
  port: number;
  registeredAt: number;
}
const oscSubscribers = new Map<string, OscSubscriber>();
function subscriberKey(addr: string, port: number) {
  return `${addr}:${port}`;
}

const wsClients = new Set<WebSocket>();
function broadcastToClients(data: any) {
  const message = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function oscTypeToQueryType(oscType: string): string {
  const map: Record<string, string> = { f: 'f', i: 'i', s: 's', T: 'T', F: 'F', d: 'd' };
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
  const addrBuf = encodeOscString(address);
  const typeBuf = encodeOscString(isInt ? ',si' : ',sf');
  const pathBuf = encodeOscString(path);
  const valBuf = Buffer.alloc(4);
  if (isInt) valBuf.writeInt32BE(Math.round(value), 0);
  else valBuf.writeFloatBE(value, 0);
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
  const args = (Array.isArray(value) ? value : [value]).map(v => {
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
  metadata: true,
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
      const key = subscriberKey(info.address, port);
      if (!oscSubscribers.has(key) && oscSubscribers.size >= MAX_SUBSCRIBERS) {
        console.log(
          `  ⚠  Abone limiti aşıldı (${MAX_SUBSCRIBERS}), reddedildi: ${info.address}:${port}`
        );
        return;
      }
      oscSubscribers.set(key, {
        address: info.address,
        port,
        registeredAt: Date.now(),
      });
      console.log(`  📡 Abone oldu: ${info.address}:${port}`);
      broadcastToClients({
        type: 'SUBSCRIBERS_CHANGED',
        subscribers: Array.from(oscSubscribers.values()),
      });
    }
    return;
  }

  if (oscMsg.address === '/unsubscribe' && info) {
    const port = oscMsg.args[0]?.value;
    if (typeof port === 'number') {
      oscSubscribers.delete(subscriberKey(info.address, port));
      broadcastToClients({
        type: 'SUBSCRIBERS_CHANGED',
        subscribers: Array.from(oscSubscribers.values()),
      });
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
    source: from,
  };
  const isNew = !namespace.has(oscMsg.address);
  if (isNew && namespace.size >= MAX_NAMESPACE) {
    console.log(`  ⚠  Namespace limiti aşıldı (${MAX_NAMESPACE}), path atlandı: ${oscMsg.address}`);
    return;
  }
  namespace.set(oscMsg.address, param);

  // Path'in ilk segmentini cihaz adıyla eşleştir → sayacı artır
  const firstSeg = oscMsg.address.split('/').filter(Boolean)[0];
  if (firstSeg) {
    for (const dev of devices.values()) {
      if (dev.name === firstSeg) {
        deviceMsgCount.set(dev.id, (deviceMsgCount.get(dev.id) || 0) + 1);
        dev.lastMessageAt = Date.now();
        break;
      }
    }
  }

  const marker = isNew ? '🆕' : '  ';
  const valStr = args.map((a: any) => `${a.value}(${a.type})`).join(', ');
  console.log(`${marker} [${time}] [UDP-direct] ${oscMsg.address.padEnd(28)} → ${valStr}`);

  broadcastToClients({
    type: 'PATH_CHANGED',
    path: oscMsg.address,
    value: param.value,
    paramType: param.type,
    source: from,
    isNew,
    timestamp: param.lastUpdate,
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
app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin || `http://localhost:${HTTP_PORT}`);
  }
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src ws: wss: http://localhost:* http://127.0.0.1:*"
  );
  next();
});
app.use('/ui', express.static('web'));
app.use(express.json());

app.get('/', (req, res) => {
  if ('HOST_INFO' in req.query) {
    return res.json({
      NAME: HUB_NAME,
      OSC_PORT,
      OSC_TRANSPORT: 'UDP',
      EXTENSIONS: { ACCESS: true, VALUE: true, DESCRIPTION: true, TYPE: true, OSC_STREAMING: true },
    });
  }
  res.json(buildTree());
});

app.get('/_devices', (_req, res) => {
  const devs = Array.from(devices.values()).map(d => ({
    ...d,
    msgCount: deviceMsgCount.get(d.id) || 0,
  }));
  res.json({ devices: devs, self: { name: HUB_NAME, port: HTTP_PORT, oscPort: OSC_PORT } });
});

app.get('/_status', (_req, res) => {
  res.json({
    namespace_size: namespace.size,
    ws_clients: wsClients.size,
    osc_subscribers: Array.from(oscSubscribers.values()),
    devices: Array.from(devices.values()),
    ableton_msgs_sent,
  });
});

app.get(/^\/(.+)/, (req, res) => {
  const path = '/' + req.params[0];
  const param = namespace.get(path);
  if (param) {
    res.json({
      FULL_PATH: path,
      TYPE: param.type,
      VALUE: param.value,
      ACCESS: 3,
      DESCRIPTION: `From ${param.source}`,
    });
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
const wss = new WebSocketServer({ server, maxPayload: 65_536 });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`  🔌 WS bağlantı: ${ip}`);
  wsClients.add(ws);

  ws.send(
    JSON.stringify({
      type: 'INITIAL_STATE',
      namespace: buildTree(),
      devices: Array.from(devices.values()),
      subscribers: Array.from(oscSubscribers.values()),
      discoveredDevices: Array.from(discoveredDevices.values()),
      recordings: listRecordings(),
      activeRecordings: Array.from(recordings.keys()),
      activePlaybacks: Array.from(playbacks.entries()).map(([id, s]) => ({
        deviceId: id,
        file: s.file,
      })),
    })
  );

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'SET' && msg.path && msg.value !== undefined) {
        if (!OSC_PATH_RE.test(msg.path)) return;
        if (!namespace.has(msg.path) && namespace.size >= MAX_NAMESPACE) return;
        const newValue = Array.isArray(msg.value) ? msg.value : [msg.value];
        const existing = namespace.get(msg.path);
        const param: Parameter = existing || {
          fullPath: msg.path,
          type: typeof msg.value === 'number' ? 'f' : 's',
          value: newValue,
          lastUpdate: Date.now(),
          source: `web:${ip}`,
        };
        param.value = newValue;
        param.lastUpdate = Date.now();
        param.source = `web:${ip}`;
        namespace.set(msg.path, param);

        broadcastToClients({
          type: 'PATH_CHANGED',
          path: msg.path,
          value: param.value,
          paramType: param.type,
          source: param.source,
          isNew: !existing,
          timestamp: param.lastUpdate,
        });
        broadcastToOsc(msg.path, param.value, param.type);
      }

      if (msg.type === 'UPDATE_DEVICE' && typeof msg.deviceId === 'number') {
        const result = saveManifest(msg.deviceId, msg.updates || {});
        ws.send(
          JSON.stringify({
            type: 'UPDATE_DEVICE_RESULT',
            deviceId: msg.deviceId,
            ok: result.ok,
            error: result.error,
          })
        );
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

      if (msg.type === 'DELETE_DEVICE' && typeof msg.deviceId === 'number') {
        const result = deleteDevice(msg.deviceId);
        ws.send(
          JSON.stringify({
            type: 'DELETE_DEVICE_RESULT',
            deviceId: msg.deviceId,
            ok: result.ok,
            error: result.error,
          })
        );
      }

      if (msg.type === 'RELOAD_MANIFESTS') loadManifests();

      if (msg.type === 'REC_START' && typeof msg.deviceId === 'number') {
        const r = startRecording(msg.deviceId);
        ws.send(
          JSON.stringify({
            type: 'REC_START_RESULT',
            deviceId: msg.deviceId,
            ok: r.ok,
            error: r.error,
          })
        );
      }
      if (msg.type === 'REC_STOP' && typeof msg.deviceId === 'number') {
        const r = stopRecording(msg.deviceId);
        ws.send(
          JSON.stringify({
            type: 'REC_STOP_RESULT',
            deviceId: msg.deviceId,
            ok: r.ok,
            error: r.error,
            file: r.file,
            events: r.events,
          })
        );
      }
      if (msg.type === 'LIST_RECORDINGS') {
        ws.send(JSON.stringify({ type: 'RECORDINGS_LIST', recordings: listRecordings() }));
      }
      if (
        msg.type === 'PLAY_START' &&
        typeof msg.deviceId === 'number' &&
        typeof msg.file === 'string'
      ) {
        const r = startPlayback(msg.deviceId, msg.file, { loop: !!msg.loop });
        ws.send(
          JSON.stringify({
            type: 'PLAY_START_RESULT',
            deviceId: msg.deviceId,
            ok: r.ok,
            error: r.error,
            events: r.events,
          })
        );
      }
      if (msg.type === 'PLAY_STOP' && typeof msg.deviceId === 'number') {
        const r = stopPlayback(msg.deviceId);
        ws.send(
          JSON.stringify({
            type: 'PLAY_STOP_RESULT',
            deviceId: msg.deviceId,
            ok: r.ok,
            error: r.error,
          })
        );
      }

      if (msg.type === 'ADD_DISCOVERED' && msg.host && msg.port) {
        if (!isValidHost(String(msg.host))) {
          ws.send(JSON.stringify({ type: 'ERROR', message: `Geçersiz host: ${msg.host}` }));
          return;
        }
        if (!isValidOscPort(Number(msg.port))) {
          ws.send(JSON.stringify({ type: 'ERROR', message: `Geçersiz port: ${msg.port}` }));
          return;
        }
        const nextId = Math.max(0, ...Array.from(devices.keys())) + 1;
        const rawName = (msg.name || `Device${nextId}`).trim().slice(0, 64);
        const name = rawName.length > 0 ? rawName : `Device${nextId}`;
        const manifest = {
          id: nextId,
          name,
          type: 'oscquery-device',
          host: msg.host,
          oscQueryPort: msg.port,
          enabled: true,
          description: `Bonjour ile keşfedildi`,
        };
        const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${nextId}.json`;
        writeFileSync(
          join(MANIFESTS_DIR, filename),
          JSON.stringify(manifest, null, 2) + '\n',
          'utf-8'
        );
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

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

server.listen(HTTP_PORT, () => {
  publishBonjour();
  startDiscovery();
});

const bonjour = new Bonjour();
function publishBonjour() {
  bonjour.publish({ name: HUB_NAME, type: 'oscjson', protocol: 'tcp', port: HTTP_PORT });
  bonjour.publish({ name: HUB_NAME, type: 'osc', protocol: 'udp', port: OSC_PORT });
  console.log('  Bonjour duyuruldu  ✓');
}

// ============ BONJOUR DISCOVERY ============
interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  firstSeen: number;
}
const discoveredDevices = new Map<string, DiscoveredDevice>();

function isAlreadyKnown(host: string, port: number): boolean {
  return Array.from(devices.values()).some(d => d.host === host && d.oscQueryPort === port);
}

function broadcastDiscovered() {
  broadcastToClients({
    type: 'DISCOVERED_DEVICES',
    devices: Array.from(discoveredDevices.values()),
  });
}

function startDiscovery() {
  const browser = bonjour.find({ type: 'oscjson', protocol: 'tcp' });

  browser.on('up', (service: any) => {
    const ipv4 = ((service.addresses as string[]) || []).find(a => a.includes('.'));
    const host = ipv4 || service.host;
    const port = service.port as number;
    if (port === HTTP_PORT) return; // kendimiz
    if (isAlreadyKnown(host, port)) return; // zaten manifest'te

    const key = `${host}:${port}`;
    discoveredDevices.set(key, { name: service.name, host, port, firstSeen: Date.now() });
    console.log(`  🔍 Yeni cihaz keşfedildi: ${service.name} @ ${host}:${port}`);
    broadcastDiscovered();
  });

  browser.on('down', (service: any) => {
    const ipv4 = ((service.addresses as string[]) || []).find((a: string) => a.includes('.'));
    const host = ipv4 || service.host;
    const key = `${host}:${service.port}`;
    if (discoveredDevices.delete(key)) broadcastDiscovered();
  });
}

// ============ M4L GERİ KANAL (port 8888) ============
const feedbackSocket = dgram.createSocket('udp4');

feedbackSocket.on('message', buf => {
  try {
    // OSC olarak dene
    const packet = osc.readPacket(buf, { metadata: true }) as any;
    const address: string = packet.address || '';
    const m = address.match(/\/?device(\d+)/i);
    if (!m) return;
    const deviceId = parseInt(m[1]);
    const args = packet.args || [];
    const path = args[0]?.value ?? args[0] ?? '';
    const value = args[1]?.value ?? args[1] ?? 0;
    broadcastToClients({ type: 'M4L_FEEDBACK', deviceId, path, value });
    console.log(`  ◄ M4L [device${deviceId}] ${path} = ${value}`);
  } catch {
    // OSC değil — ham baytları logla, format tespiti için
    const hex = buf
      .slice(0, 24)
      .toString('hex')
      .replace(/(.{2})/g, '$1 ');
    const txt = buf
      .slice(0, 24)
      .toString('utf8')
      .replace(/[^\x20-\x7e]/g, '·');
    console.log(`  ◄ M4L [ham] ${buf.length}b  hex: ${hex.trim()}  txt: ${txt}`);
  }
});

feedbackSocket.bind(8889, '127.0.0.1', () => {
  console.log('  ◄ M4L geri kanal:   UDP 127.0.0.1:8889');
});

// ============ JSON UDP DİNLEYİCİ (port 5007) ============
// Max'ten: dict.serialize → udpsend 127.0.0.1 5007
// Format: {"_device":"ece","x":1.0,"y":2.0} — _device opsiyonel
const jsonUdpSocket = dgram.createSocket('udp4');

jsonUdpSocket.on('message', buf => {
  try {
    const raw = buf.toString('utf8').trim();
    const data = JSON.parse(raw) as Record<string, unknown>;

    const deviceName = typeof data['_device'] === 'string' ? data['_device'] : null;
    const devId = deviceName
      ? (() => {
          for (const [id, d] of devices.entries()) if (d.name === deviceName) return id;
          return null;
        })()
      : null;

    let count = 0;
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      const path = deviceName ? `/${deviceName}/${key}` : `/${key}`;
      if (!OSC_PATH_RE.test(path)) continue;
      if (namespace.size >= MAX_NAMESPACE) break;
      const numVal = typeof val === 'number' ? val : parseFloat(String(val));
      if (!Number.isFinite(numVal)) continue;
      namespace.set(path, {
        fullPath: path,
        type: 'f',
        value: [numVal],
        lastUpdate: Date.now(),
        source: deviceName ?? 'json-udp',
      });
      broadcastToClients({
        type: 'PATH_CHANGED',
        path,
        paramType: 'f',
        value: [numVal],
        deviceName,
      });
      count++;
    }

    if (devId !== null) {
      deviceMsgCount.set(devId, (deviceMsgCount.get(devId) || 0) + count);
      const dev = devices.get(devId);
      if (dev) dev.lastMessageAt = Date.now();
    }
  } catch {
    // JSON parse hatası — sessizce geç
  }
});

jsonUdpSocket.bind(JSON_UDP_PORT, '0.0.0.0', () => {
  console.log(`  ◄ JSON UDP:         port ${JSON_UDP_PORT}`);
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
    jsonUdpSocket.close();
    for (const client of wsClients) client.close();
    process.exit(0);
  });
});
