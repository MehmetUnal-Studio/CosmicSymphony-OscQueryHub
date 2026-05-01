import WebSocket from 'ws';
import osc from 'osc';

export interface OscQueryClientEvents {
  onConnect: () => void;
  onDisconnect: (reason: string) => void;
  onValue: (path: string, value: any) => void;
  onLog: (msg: string) => void;
}

interface NamespaceNode {
  FULL_PATH?: string;
  TYPE?: string;
  VALUE?: any[];
  ACCESS?: number;
  CONTENTS?: Record<string, NamespaceNode>;
}

export class OscQueryClient {
  private host: string;
  private port: number;
  private events: OscQueryClientEvents;
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private listenedPaths = new Set<string>();
  private debugCount = 0;
  public lastNamespace: NamespaceNode | null = null;

  constructor(host: string, port: number, events: OscQueryClientEvents) {
    this.host = host;
    this.port = port;
    this.events = events;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;

    try {
      const url = `http://${this.host}:${this.port}/`;
      this.events.onLog(`HTTP GET ${url}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tree = await res.json() as NamespaceNode;
      this.lastNamespace = tree;

      const paths = this.collectPaths(tree);
      this.events.onLog(`Namespace alındı: ${paths.length} parametre`);

      this.openWebSocket(paths);
    } catch (e) {
      this.events.onLog(`Bağlantı hatası: ${(e as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private collectPaths(node: NamespaceNode): string[] {
    const paths: string[] = [];
    if (node.TYPE !== undefined && node.FULL_PATH) {
      paths.push(node.FULL_PATH);
    }
    if (node.CONTENTS) {
      for (const [_key, child] of Object.entries(node.CONTENTS)) {
        paths.push(...this.collectPaths(child));
      }
    }
    return paths;
  }

  private openWebSocket(paths: string[]) {
    try {
      const wsUrl = `ws://${this.host}:${this.port}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.events.onLog(`WebSocket açık · ${paths.length} path için LISTEN gönderiliyor`);
        this.events.onConnect();

        for (const path of paths) {
          this.listen(path);
        }
      });

      // ⚡ KRİTİK: Binary mesajları da yakala
      this.ws.on('message', (raw, isBinary) => {
        // raw, ws kütüphanesinde Buffer | ArrayBuffer | Buffer[] olabilir
        const buf = this.toBuffer(raw);

        if (isBinary || this.looksLikeOscPacket(buf)) {
          // OSC binary packet
          this.handleOscBinary(buf);
        } else {
          // JSON mesajı (komut/yanıt vs.)
          try {
            const text = buf.toString('utf-8');
            const data = JSON.parse(text);
            this.handleJsonMessage(data);
          } catch (_e) {
            // JSON da değilse, OSC olarak dene
            this.handleOscBinary(buf);
          }
        }
      });

      this.ws.on('error', (err) => {
        this.events.onLog(`WS hata: ${err.message}`);
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this.events.onDisconnect(`WS kapandı (kod: ${code})`);
        this.scheduleReconnect();
      });
    } catch (e) {
      this.events.onLog(`WS açma hatası: ${(e as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private toBuffer(raw: any): Buffer {
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof ArrayBuffer) return Buffer.from(raw);
    if (Array.isArray(raw)) return Buffer.concat(raw.map((r: any) => this.toBuffer(r)));
    if (typeof raw === 'string') return Buffer.from(raw, 'utf-8');
    return Buffer.from(raw);
  }

  // OSC paketi karakteristikleri:
  // - "/" ile başlar (adres) veya
  // - "#bundle" ile başlar
  private looksLikeOscPacket(buf: Buffer): boolean {
    if (buf.length < 4) return false;
    const first = buf[0];
    return first === 0x2F /* / */ || first === 0x23 /* # */;
  }

  private handleOscBinary(buf: Buffer) {
    try {
      const packet = osc.readPacket(buf, { metadata: true });
      this.processOscPacket(packet);
    } catch (e) {
      if (this.debugCount < 3) {
        this.events.onLog(`⚠ OSC parse hatası: ${(e as Error).message}`);
        this.debugCount++;
      }
    }
  }

  private processOscPacket(packet: any) {
    // Bundle ise içindeki paketleri tek tek işle
    if (packet.packets && Array.isArray(packet.packets)) {
      for (const sub of packet.packets) {
        this.processOscPacket(sub);
      }
      return;
    }

    // Tek mesaj
    if (packet.address && packet.args) {
      const values = packet.args.map((a: any) => a.value);
      const value = values.length === 1 ? values[0] : values;
      this.events.onValue(packet.address, value);
    }
  }

  private handleJsonMessage(data: any) {
    // OSCQuery JSON komutları (PATH_CHANGED, PATH_ADDED, vs.)
    if (data.COMMAND) {
      // Bilgilendirici komutlar — şimdilik görmezden gel
      return;
    }

    // Bazı sunucular path-value mapping yollar
    if (data.PATH && data.VALUE !== undefined) {
      this.events.onValue(data.PATH, data.VALUE);
      return;
    }
    if (data.FULL_PATH && data.VALUE !== undefined) {
      this.events.onValue(data.FULL_PATH, data.VALUE);
      return;
    }
  }

  private listen(path: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.listenedPaths.add(path);
    try {
      this.ws.send(JSON.stringify({ COMMAND: 'LISTEN', DATA: path }));
    } catch (_e) { /* ignore */ }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.events.onLog(`Yeniden bağlanılıyor...`);
      this.connect();
    }, 3000);
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_e) { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }
}
