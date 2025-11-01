# Tailmux - Remote Terminal Access

Access terminal applications remotely through your browser.

## Quick Start

```bash
npm install
npm start
```

Visit `http://localhost:3000` to open Tailmux.

## Docker

Build and run the container locally:

```bash
docker build -t tailmux:latest .
docker run --rm -it -p 3000:3000 tailmux:latest
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port Tailmux listens on |
| `MAX_TERMINALS` | `10` | Maximum concurrent terminals |
| `WS_HEARTBEAT_INTERVAL` | `30000` | WebSocket ping interval (ms) |
| `TERMINAL_IDLE_TIMEOUT_MS` | `0` | Idle timeout before closing terminals |
| `tmux` | bundled | Alpine tmux package is installed at build time |

## TrueNAS Deployment

If your TrueNAS host already runs Tailscale, use the compose file in `deploy/truenas.yml`:

1. Open **Apps → Custom App → Install via YAML**.
2. Paste the contents of `deploy/truenas.yml` and replace `/mnt/POOL/apps/tailmux` with the dataset path you want to bind inside the container.
3. After the container starts, publish Tailmux inside your tailnet:
   ```bash
   tailscale serve tcp 3000 --name tailmux
   ```
4. Tailnet users can now reach Tailmux using the MagicDNS name you chose.

For hosts without Tailscale, run a sidecar container or adapt the compose file accordingly.

## Tailscale & Private Network Usage

Tailmux is designed for private networks. Keep the HTTP endpoint off the public internet and put it behind a trusted overlay such as Tailscale. Tailmux does **not** ship with built‑in authentication—anyone who can reach port 3000 can run shell commands under the container’s user.

### Recommended pattern

1. Create a Tailscale tailnet and install the Tailscale client on the machines that need access to Tailmux.
2. Run Tailmux on a host that also runs the Tailscale node (Docker, TrueNAS, bare metal, etc.).
3. Advertise the service to the tailnet:

   ```bash
   tailscale serve tcp 3000 --name tailmux
   ```

   Tailnet members with the correct ACLs can now use the MagicDNS name assigned to `tailmux`.
4. (Optional) If you move Tailmux between hosts, reuse the same service name so clients keep a stable URL.

### Security considerations

- **Never expose Tailmux directly to the public internet.** Without extra front-ends (reverse proxies with auth, OAuth, etc.), anyone who can reach the service gets a shell.
- For bare-metal deployments, create a dedicated system user with minimal privileges; avoid running the server as root.
- Enforce Tailscale ACLs to limit who can reach the service. Tailmux happily spawns shells for every connected browser tab.
- If you add HTTP auth in front (e.g., nginx, Caddy, OAuth2 Proxy), ensure idle timeout and audit logging match your organization’s expectations.
- Rotate your Tailscale auth keys and GitHub container registry PATs regularly.

Running Tailmux inside a private overlay network (Tailscale, ZeroTier, VPN) is the easiest way to keep the attack surface small while still supporting remote tmux access.

## Running Tailmux as a systemd Service (bare metal)

When you deploy Tailmux directly on Linux, run it under a dedicated user and supervise it with systemd so it restarts automatically on boot.

1. **Create a runtime user and install dependencies**

   ```bash
   sudo useradd --system --home /opt/tailmux --shell /usr/sbin/nologin tailmux
   sudo mkdir -p /opt/tailmux
   sudo chown tailmux:tailmux /opt/tailmux
   sudo apt install -y nodejs npm tmux   # substitute your distro's package manager
   ```

2. **Deploy the application**

   ```bash
   sudo -u tailmux git clone https://github.com/adamcowan/tailmux.git /opt/tailmux
   cd /opt/tailmux
   sudo -u tailmux npm install --omit=dev
   ```

3. **Create `/etc/systemd/system/tailmux.service`**

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
   Environment=WS_HEARTBEAT_INTERVAL=30000
   Environment=TERMINAL_IDLE_TIMEOUT_MS=0
   ExecStart=/usr/bin/node /opt/tailmux/server.js
   Restart=on-failure
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

4. **Enable and start the service**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now tailmux.service
   sudo systemctl status tailmux.service
   ```

Pair this with a Tailscale client running on the same host and publish the service (`tailscale serve tcp 3000 --name tailmux`). Always restrict access at the network layer because Tailmux itself has no built-in authentication.

## Features

### Core Functionality
- Full terminal emulation using xterm.js
- WebSocket-based real-time communication
- Support for interactive terminal apps (vim, nano, htop, etc.)
- **Attach to existing tmux sessions** - Access terminals running in iTerm2 or other terminals
- **Persistent sessions** - Create tmux sessions that survive disconnects

### Multi-Tab Support
- Open multiple terminals in separate tabs
- Switch between sessions seamlessly
- Each tab maintains its own connection
- Visual status indicators (connected/disconnected)

### Session Dashboard
- Overview of all active sessions
- Statistics: active connections, open tabs, tmux sessions
- Quick actions: switch to tab, close tab, create new session
- Session metadata and status

### Mobile Optimization
- Responsive design for phones and tablets
- Virtual keyboard with special keys (Esc, Tab, Ctrl+C, arrows)
- **tmux control panel** - One-tap access to all tmux commands
- **Advanced scrolling** - 5 ways to navigate terminal history
- Touch-friendly controls
- Adaptive layout

## Installation

```bash
npm install
```

### Install tmux on bare-metal hosts

Tailmux can create and attach to tmux sessions. If you run the Node server directly on macOS/Linux, install tmux locally:

```bash
brew install tmux   # or apt/yum equivalent
```

The Docker image already bundles the Alpine `tmux` package (verified during build), so no extra steps are needed in container deployments.

## Usage

Start the server:

```bash
npm start
```

Then open your browser to:

```
http://localhost:3000
```

You'll see a session selector with options to:
- **Attach to existing tmux sessions** (if any are running)
- **Create a new tmux session** (persistent, survives disconnects)
- **Start a regular shell** (non-persistent)

### Using the Interface

**Multiple Tabs:**
- Click the `+` button in the header to open a new terminal tab
- Click on any tab to switch to it
- Click the `×` on a tab to close it

**Dashboard:**
- Click the grid icon in the header to open the dashboard
- View statistics about active sessions
- Manage all your tabs from one place
- Close all tabs at once

**Mobile:**
- Click the keyboard icon to show/hide the virtual keyboard
- Use special keys like Ctrl+C, Esc, Tab, and arrow keys
- Click the tmux icon (grid with split) for tmux-specific controls
- All features work on touch devices

**tmux Controls (Mobile):**

The tmux control panel provides one-tap access to all common tmux commands:

- **Windows**:
  - New: Create new window (Ctrl+B c)
  - Next/Prev: Switch between windows (Ctrl+B n/p)
  - Kill: Close current window (Ctrl+B &)
  - Rename: Rename window (Ctrl+B ,)

- **Panes**:
  - Split V: Split pane vertically (Ctrl+B %)
  - Split H: Split pane horizontally (Ctrl+B ")
  - Next: Switch to next pane (Ctrl+B o)
  - Kill: Close current pane (Ctrl+B x)
  - Zoom: Toggle pane zoom (Ctrl+B z)

- **Navigation**:
  - Arrow keys: Move between panes (Ctrl+B ↑↓←→)

- **Session**:
  - Detach: Detach from session (Ctrl+B d)
  - Rename: Rename session (Ctrl+B $)
  - List: Show session list (Ctrl+B s)

- **Quick Actions**:
  - Copy: Enter copy mode (Ctrl+B [)
  - Time: Show clock (Ctrl+B t)
  - Help: Show key bindings (Ctrl+B ?)

All commands automatically send the Ctrl+B prefix, so you don't need to press it manually!

**Scrolling (Mobile):**

Navigate through terminal history with 5 different methods:

1. **Two-Finger Scroll**: Place two fingers on terminal and swipe up/down for smooth scrolling with momentum
2. **Scroll Buttons**: Four circular buttons on the right side:
   - ⇈ Jump to top of history
   - ↑ Page up (75% of screen)
   - ↓ Page down (75% of screen)
   - ⇊ Jump to bottom (current prompt)
3. **Visual Indicator**: Blue bar shows your current scroll position
4. **Mouse Wheel**: Standard wheel scrolling on desktop
5. **tmux Copy Mode**: Tap "Copy" in tmux panel for precise navigation

See `SCROLLING_GUIDE.md` for detailed usage and tips.

## How it Works

1. **Backend**: Node.js server using `node-pty` to spawn real shell processes or attach to tmux sessions
2. **WebSocket**: Bidirectional communication between browser and terminal
3. **Frontend**: xterm.js provides a full-featured terminal emulator in the browser
4. **Session Management**: Uses tmux for persistent sessions that can be shared across multiple clients

## Connecting to Existing iTerm2 Sessions

To access a terminal session already running in iTerm2 (or any terminal):

1. In your existing terminal, start a tmux session:
   ```bash
   tmux new -s mysession
   ```

2. Run your apps (vim, htop, etc.) inside the tmux session

3. Open the web interface at `http://localhost:3000`

4. Click on "Attach to: mysession" to connect

Now you can access the same session from both iTerm2 and your browser! Changes in one will be reflected in the other in real-time.

## Configuration

The server runs on port 3000 by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm start
```

## Security Note

This is a basic implementation for local/trusted networks. For production use, you should add:

- Authentication (username/password, tokens, SSH keys)
- HTTPS/WSS encryption
- Rate limiting
- Session management
- Input validation and sanitization
- Network access controls

## Running Remote Apps

Once connected, you can run any terminal application:

```bash
# Code editors
vim myfile.txt
nano myfile.txt

# System monitoring
htop
top

# Interactive shells
python
node

# And more!
```
