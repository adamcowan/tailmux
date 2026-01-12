# Tailmux - Remote Terminal Access

Browser-based terminal emulator with tmux integration, multi-tab support, and mobile optimization.

## Quick Start

```bash
npm install
npm start
```

Visit `http://localhost:3000` to open Tailmux.

## Features

- **Full terminal emulation** using xterm.js
- **Multi-tab support** - Multiple terminals in separate tabs
- **tmux integration** - Create or attach to persistent tmux sessions
- **Session dashboard** - Manage all tabs from one interface
- **Mobile optimized** - Virtual keyboard and tmux control panel

## Deployment

### Docker

```bash
docker build -t tailmux:latest .
docker run --rm -it -p 3000:3000 tailmux:latest
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `MAX_TERMINALS` | `10` | Maximum concurrent terminals |
| `WS_HEARTBEAT_INTERVAL` | `30000` | WebSocket ping interval (ms) |
| `TERMINAL_IDLE_TIMEOUT_MS` | `0` | Idle timeout (0 = disabled) |
| `ALLOWED_ORIGINS` | _(empty)_ | Comma-separated list of allowed WebSocket origins |
| `TAILMUX_TOKEN` | _(empty)_ | Shared token required for WebSocket access |

### TrueNAS SCALE

Use the compose file in `deploy/truenas.yml`:

1. Open **Apps → Custom App → Install via YAML**
2. Paste contents and update the volume path
3. Publish via Tailscale: `tailscale serve tcp 3000 --name tailmux`

### Bare Metal (systemd)

See the systemd service configuration in the [deployment section below](#systemd-service-configuration).

## Security

**⚠️ Important:** Tailmux does **not** require authentication unless you set `TAILMUX_TOKEN`. Without it, anyone who can reach port 3000 can access a shell.

### Recommended Setup

1. **Use Tailscale or VPN** - Never expose directly to the internet
2. **Run as dedicated user** - Create a limited-privilege user for the service
3. **Enable Tailscale ACLs** - Restrict which tailnet users can access the service
4. **Set `TAILMUX_TOKEN`** - Require a shared token for WebSocket + API access
5. **Add reverse proxy auth** - Use nginx/Caddy with OAuth if needed

### Tailscale Integration

```bash
# Bind Tailmux to localhost, then publish via Tailscale:
HOST=127.0.0.1 TAILMUX_TOKEN=your-token-here npm start
tailscale serve tcp 3000 --name tailmux
```

Connect with the token once to store it in your browser:

```bash
https://tailmux.<tailnet>.ts.net/?token=your-token-here
```

The token is saved in `localStorage` (key `tailmux_token`). Clear it in the browser if you need to rotate it.

API requests include the token as an `Authorization: Bearer` header when set.

Users on your tailnet can access via the MagicDNS name.

## Installation

### Docker
tmux is pre-installed in the Docker image.

### Bare Metal
Install Node.js 20+ and tmux:

```bash
# macOS
brew install tmux

# Debian/Ubuntu
sudo apt install -y nodejs npm tmux

# RHEL/Fedora
sudo dnf install -y nodejs npm tmux
```

## Usage

Open `http://localhost:3000` in your browser. You'll see options to:
- **Attach to existing tmux session** (if any are running)
- **Create new tmux session** (persistent, survives disconnects)
- **Start regular shell** (non-persistent)

### Interface

- **Tabs**: Click `+` to create new tabs, click tab to switch, `×` to close
- **Dashboard**: Grid icon shows all sessions and statistics
- **Mobile**: Keyboard icon for virtual keys, tmux icon for command panel
- **Scrolling**: Two-finger swipe, scroll buttons, or tmux copy mode

## systemd Service Configuration

For bare-metal Linux deployments:

1. **Create dedicated user:**
   ```bash
   sudo useradd --system --home /opt/tailmux --shell /usr/sbin/nologin tailmux
   sudo mkdir -p /opt/tailmux
   sudo chown tailmux:tailmux /opt/tailmux
   ```

2. **Deploy application:**
   ```bash
   sudo -u tailmux git clone https://github.com/adamcowan/tailmux.git /opt/tailmux
   cd /opt/tailmux
   sudo -u tailmux npm install --omit=dev
   ```

3. **Create `/etc/systemd/system/tailmux.service`:**
   ```ini
   [Unit]
   Description=Tailmux remote terminal gateway
   After=network.target

   [Service]
   User=tailmux
   Group=tailmux
   WorkingDirectory=/opt/tailmux
   Environment=PORT=3000
   Environment=MAX_TERMINALS=20
   ExecStart=/usr/bin/node /opt/tailmux/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

4. **Enable service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now tailmux.service
   ```

## License

MIT - See [LICENSE](LICENSE) file for details.
