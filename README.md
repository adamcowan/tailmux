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

## TrueNAS Deployment

If your TrueNAS host already runs Tailscale, use the compose file in `deploy/truenas.yml`:

1. Open **Apps → Custom App → Install via YAML**.
2. Paste the contents of `deploy/truenas.yml`.
3. After the container starts, publish Tailmux inside your tailnet:
   ```bash
   tailscale serve tcp 3000 --name tailmux
   ```
4. Tailnet users can now reach Tailmux using the MagicDNS name you chose.

For hosts without Tailscale, run a sidecar container or adapt the compose file accordingly.

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

### Optional: Install tmux for session persistence

To attach to existing terminal sessions or create persistent sessions:

```bash
brew install tmux
```

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
