# CosmicSymphony — OSCQuery Hub

A central Node.js hub that bridges all stage OSC devices (LeapMotion, Spektra tablets, VR, Ring, WebInstrument, etc.) to Ableton Live through a single OSCQuery namespace.

Replaces the legacy Max/MSP Standalone Manager.

→ [Visual technical overview](https://mehmetunal-studio.github.io/CosmicSymphony-OscQueryHub/docs/visual-overview.html)

---

## Architecture

```
                   ┌─────────────────────────────────────┐
                   │           Node.js Hub               │
[OSCQuery device]─►│  • OSCQuery client (HTTP+WS)        │──UDP──►[Ableton M4L]
[Classic OSC]   ──►│  • UDP OSC listener        :5006    │       (port 10000)
[Max dict.JSON]──►│  • JSON UDP listener       :5007    │
[TouchOSC]      ──►│  • Bonjour/mDNS discovery           │◄──UDP──[M4L feedback]
                   │  • WebSocket broadcast              │       (port 8889)
                   │  • Web control panel       :5555    │
                   └─────────────────────────────────────┘
                                    ▲
                                    │ browser / iPad
                                    │ http://localhost:5555/ui/
```

- **Hub:** This repo — Node.js + TypeScript
- **Audio:** Ableton Live + Max for Live ("Cosmic Unity" device)
- **Visual:** TouchDesigner
- **Control:** TouchOSC (iPad), web browser

---

## What's New

### Hub backend
- **JSON UDP listener (port 5007)** — Send a JSON object from Max via `dict.serialize` → `udpsend 127.0.0.1 5007`. The `_device` field maps to a card; remaining keys are auto-written to the namespace.
- **`permanent` flag** — Devices with `"permanent": true` (Tablet1-3, TV, VR, Ring, LeapMotion) stay pinned in the panel regardless of connection state.
- **Delete device** — Each card has an `✕` button. Confirmation dialog → manifest file deleted, namespace entries cleared, active connection torn down. Real, irreversible delete.
- **State preservation across manifest reloads** — Earlier, every `manifests/` change reset `status`/`paramCount` to `configured`/undefined, so connected cards looked dead. Fixed: if `host`/`port`/`enabled` unchanged and the OSCQuery client is still active, runtime fields are carried over.
- **Bug fixes** — NaN guards on JSON UDP, WebSocket `error` cleanup, `deviceMsgCount` cleanup on manifest deletion, complete `Parameter` shape (fullPath, lastUpdate).

### Web UI
- **Full English locale** — locale-consistent for live/stage use (`<html lang="en">`).
- **Modern typography** — Inter (sans) + JetBrains Mono (mono), `tabular-nums` numeric columns.
- **Brightened offline cards** — the old `opacity: 0.45` made them invisible; now text is readable, OFFLINE badge is red, Enable button is cyan and clickable.
- **Per-card delete** — third action button (`✕`); destructive style on hover (red glow), `confirm()` dialog before fire.
- **Generative background** — `algo-art.js` ambient flow-field + mouse halo; respects `prefers-reduced-motion`, pauses on tab hide.

### Test instrument (`osc-test-instrument/`)
- **Standalone Express + WS server** on port 9100 (`npm start` inside `osc-test-instrument/`).
- **Cosmic XY pad UI** — full-screen WebGL nebula (three.js); mouse position drives `/x` and `/y` (0..1), clicks emit pulse rings. The mouse cursor IS the instrument.
- **Browser/subscriber separation** — UI clients announce `HELLO_BROWSER`; OSCQuery clients (the hub) issue `LISTEN`. Initial value pushed on subscribe so the hub gets the current state immediately.
- **Auto-discovery** — Bonjour-publishes `_oscjson._tcp`; the hub picks it up automatically.

### Development workflow
- **AI-assisted code review** — Husky pre-commit/pre-push hooks run every staged diff through the Anthropic API (details below).

---

## Setup

### Requirements

- [Node.js](https://nodejs.org) v18 or later
- A terminal (macOS: Terminal.app or iTerm)
- `ANTHROPIC_API_KEY` (optional — only needed if you want the AI review hooks)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/MehmetUnal-Studio/CosmicSymphony-OscQueryHub.git
cd CosmicSymphony-OscQueryHub

# 2. Install dependencies
npm install

# 3. Run
npm run dev
```

Open in browser:
```
http://localhost:5555/ui/
```

---

## Running

```bash
# Dev mode (auto-reloads on file change)
npm run dev

# Just run (no watcher)
npm start

# Mock OSCQuery device (for testing)
npm run test-device
```

Stop with `Ctrl + C`.

---

## Ports

| Port  | Protocol | Purpose |
|-------|----------|---------|
| 5555  | TCP      | Web UI + WebSocket |
| 5006  | UDP      | Classic OSC listener |
| 5007  | UDP      | JSON UDP listener (Max `dict.serialize` channel) |
| 10000 | UDP      | Ableton M4L `udpreceive` (hub forwards here) |
| 8889  | UDP      | M4L → Hub feedback channel |

---

## Adding Devices

Each device is defined by a JSON file in `manifests/`.

### Manual

```json
{
  "id": 3,
  "name": "Tablet3",
  "type": "spectra-tablet",
  "host": "192.168.1.103",
  "oscQueryPort": 9010,
  "enabled": true,
  "permanent": true,
  "description": "Spektra tablet 3"
}
```

| Field | Description |
|-------|-------------|
| `id` | Device ID (forwarded to Ableton as `device<id>`) |
| `name` | OSC namespace prefix (`/Tablet3/...`) |
| `type` | Visual label (rendered as the card subtitle) |
| `host`, `oscQueryPort` | Where the device's OSCQuery server lives |
| `enabled` | Should the hub attempt to connect? |
| `permanent` | If `true`, always shown in the UI (even when offline) |
| `description` | Human-readable note |

The hub watches `manifests/` live — no restart needed.

### Auto-discovery (Bonjour/mDNS)

Devices broadcasting `_oscjson._tcp` are auto-detected. They appear under **"Discovered Devices"** in the web UI; click **+ Add** to register them. ID is auto-assigned (10, 11, ...).

---

## Max → Hub Communication (3 ways)

### 1. Classic OSC — port 5006
Simplest. Data is sent as blind UDP, the hub interprets it.

```
[flonum]
|
[prepend /tablet3/slider]
|
[udpsend 127.0.0.1 5006]
```

### 2. JSON UDP — port 5007
Send an entire Max dict in one packet. The `_device` field handles routing.

```
[dict mydict]
|
[dict.serialize]
|
[udpsend 127.0.0.1 5007]
```

Format:
```json
{ "_device": "tablet3", "x": 0.5, "y": 0.7, "pressure": 0.92 }
```

### 3. Full OSCQuery server (inside Max)
If you want the device to show as "connected" on the hub side, run a real OSCQuery server inside Max using the `oscquery-max` package (Çağatay Güçlü / defektu). The hub reads the namespace via HTTP, opens a WebSocket for live values, and the card UI reports `Params` count + `Connected` status.

```
[node.script oscquery.server.js http_port=9010 service_name=tablet3]
```

---

## Ableton M4L Integration

The hub forwards each device's parameters to Ableton in this format:

```
device9 /HandR0/palm/Tx 0.5
```

- `device9` → device ID (Max's `route` object filters on this)
- `/HandR0/palm/Tx` → parameter path
- `0.5` → value

In M4L, listen with `udpreceive 10000`, then use `sprintf "device%ld"` + `route` to demultiplex by device.

### Feedback channel (M4L → Hub)

M4L can send messages back to the hub on port **8889**. The web UI flashes a `◄ M4L` indicator on each device card.

In M4L: `udpsend localhost 8889`

---

## AI-Assisted Development

This project follows a "human + AI pair-programming" pattern. AI plays three distinct roles:

### Layer 1 — `CLAUDE.md`: persistent context
The repo-root [CLAUDE.md](CLAUDE.md) tells the AI the project's purpose, architecture, namespace convention, and development rules. The AI reads this at the start of every session and grounds its decisions in it — for example, why a new device type follows the manifest format, why logs land in `logs/` with a timestamp.

### Layer 2 — pre-commit AI review
The `.husky/pre-commit` hook runs before every commit:

```
npx lint-staged                   # prettier formatting
node scripts/validate-staged.js   # AI review of staged diff
```

`scripts/validate-staged.js` sends only the **staged diff** to the Anthropic Claude API. The AI checks the rules in [.ai-rules.json](.ai-rules.json):

- Security issues (XSS, SQL/command injection, path traversal)
- Memory leak risk (Map/Set with adds but no deletes?)
- Missing NaN/null/undefined checks
- Race condition patterns
- WebSocket cleanup (close + error handlers)

Findings print directly to the terminal. Critical issues block the commit; minor suggestions are informational and you decide whether to address them.

**Important:** The hook reads only the diff, not the whole codebase — token cost stays small, response returns in 5–15s.

### Layer 3 — pre-push AI review
The `.husky/pre-push` hook reviews the stack of unpushed commits as a whole:

```
node scripts/validate-push.js
```

Goes deeper — checks whether commits are coherent together, whether backwards compatibility was broken. Output is summarized in the terminal; the push waits.

### Cache mechanism
[scripts/cache-utils.js](scripts/cache-utils.js) keeps a local `.ai-review-cache.json` so the same diff hash never re-runs (gitignored, local only). Since lint-staged normalizes formatting/whitespace, the cache hit rate is high.

### Disabling AI
The hooks require `ANTHROPIC_API_KEY` in the environment. If it's not set, the hooks fail. To work around:

```bash
git commit --no-verify   # one-off bypass
git push   --no-verify   # skip the push hook
```

Or persist the key in a local `.env` (gitignored):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### How the loop feels in practice
A typical iteration:

1. You open a Claude Code (terminal) or Claude Desktop session
2. The AI reads `CLAUDE.md` + relevant files, plans, writes code
3. You inspect the diff in your editor and test it
4. `git commit` → the pre-commit hook runs the AI review (a second AI pair of eyes)
5. `git push` → the pre-push hook runs the deeper review
6. The change ships

In practice there are two AI roles: the first AI (in your session) is the **producer**, the second AI (in the hooks) is the **reviewer**. The reviewer can catch the producer's mistakes; the human stays in the middle of the loop.

---

## Folder Layout

```
oscquery-hub/
├── src/
│   ├── index.ts              ← Hub brain (HTTP/WS/UDP/JSON UDP/Bonjour)
│   ├── oscquery-client.ts    ← OSCQuery client used to connect to devices
│   └── test-device.ts        ← Mock device emulator (npm run test-device)
├── manifests/                ← Device definitions (JSON)
├── web/
│   ├── index.html            ← Web control panel
│   ├── algo-art.js           ← Ambient generative background (drop-in)
│   └── test-device.html      ← Companion page for the test device
├── osc-test-instrument/      ← Standalone test instrument (separate process)
│   ├── server.js                 ← Express + WS OSCQuery server (port 9100)
│   ├── public/
│   │   └── index.html            ← Cosmic WebGL XY pad UI
│   └── package.json
├── scripts/                  ← AI review tooling
│   ├── ai-review.js              ← Anthropic API call + prompts
│   ├── validate-staged.js        ← Pre-commit hook entry
│   ├── validate-push.js          ← Pre-push hook entry
│   ├── diff-utils.js             ← Git diff parse helpers
│   ├── cache-utils.js            ← Local review cache
│   └── output-utils.js           ← Terminal coloring
├── .husky/                   ← Git hooks
│   ├── pre-commit
│   └── pre-push
├── .ai-rules.json            ← Rule set for AI review
├── .prettierrc               ← Formatter config
├── docs/                     ← Technical documentation
└── CLAUDE.md                 ← AI context file (persistent project memory)
```

---

## Troubleshooting

**Hub won't start — port already in use**
```bash
# Find and kill whatever holds port 5555
lsof -ti TCP:5555 | xargs kill -9
```

**Device doesn't appear**
- Check `"enabled": true` in the manifest
- Verify the host IP is correct (`ping 192.168.1.xxx`)
- Make sure device and hub share the same network
- If `permanent: true`, the card still appears with an "OFFLINE" badge

**No data reaching Ableton**
- M4L device must have `udpreceive 10000` open
- Sniff traffic: `sudo tcpdump -i lo0 -n udp port 10000`

**JSON UDP isn't bumping the card's message counter**
- Is the JSON `"_device": "<manifest_name>"` field correct?
- It must match the device manifest's `name` exactly (case-sensitive)

**Pre-commit hook fails**
- Is `ANTHROPIC_API_KEY` set? `echo $ANTHROPIC_API_KEY`
- One-off skip: `git commit --no-verify`
- Disable entirely: empty out or delete `.husky/pre-commit`

---

## Development

```bash
# Make changes
git add .
git commit -m "short description"   # → triggers AI review
git push                             # → triggers deeper AI review

# Pull latest
git pull
```

If you don't have an API key, skip the hooks with `--no-verify` (only in your own session).
