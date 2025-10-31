const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const { execSync, spawnSync } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Store active terminals
const terminals = new Map();

const parsedMaxTerminals = Number.parseInt(process.env.MAX_TERMINALS || '10', 10);
const MAX_TERMINALS = Number.isNaN(parsedMaxTerminals) ? 10 : parsedMaxTerminals;

const parsedHeartbeat = Number.parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000', 10);
const HEARTBEAT_INTERVAL = Number.isNaN(parsedHeartbeat) ? 30000 : parsedHeartbeat;

const parsedIdleTimeout = Number.parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || '0', 10);
const TERMINAL_IDLE_TIMEOUT_MS = Number.isNaN(parsedIdleTimeout) ? 0 : parsedIdleTimeout;

// Check if tmux is available
function isTmuxAvailable() {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

// Get list of tmux sessions
function getTmuxSessions() {
  if (!isTmuxAvailable()) {
    return [];
  }

  try {
    const output = execSync('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}"', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached, created] = line.split('|');
      return {
        name,
        windows: parseInt(windows),
        attached: parseInt(attached) > 0,
        created: new Date(parseInt(created) * 1000).toISOString()
      };
    });
  } catch (err) {
    // No sessions exist
    return [];
  }
}

function sendError(ws, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', message }));
  } catch (err) {
    console.error('Failed to send error to client:', err);
  }
}

function detachTmuxClient(session) {
  if (!session || !session.sessionName || !isTmuxAvailable()) {
    return;
  }

  const detach = spawnSync('tmux', ['detach-client', '-t', session.sessionName]);
  if (detach.status !== 0 || detach.error) {
    const stderr = detach.stderr ? detach.stderr.toString().trim() : '';
    console.error('Failed to detach tmux client:', detach.error || stderr || detach.status);
  }
}

function clearIdleTimeout(terminalId) {
  const session = terminals.get(terminalId);
  if (session?.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function scheduleIdleTimeout(terminalId) {
  if (TERMINAL_IDLE_TIMEOUT_MS <= 0) {
    return;
  }

  const session = terminals.get(terminalId);
  if (!session) {
    return;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }

  session.idleTimer = setTimeout(() => {
    const current = terminals.get(terminalId);
    if (!current) {
      return;
    }

    console.log(`Terminal ${terminalId} closing due to inactivity`);
    sendError(current.ws, 'Session closed due to inactivity.');

    if ((current.sessionMode === 'attach' || current.sessionMode === 'tmux') && current.sessionName) {
      detachTmuxClient(current);
    }

    try {
      current.term.kill();
    } catch (err) {
      console.error('Failed to kill idle terminal:', err);
    }

    terminals.delete(terminalId);

    if (current.ws && current.ws.readyState === WebSocket.OPEN) {
      try {
        current.ws.close(1000, 'Idle timeout');
      } catch (err) {
        console.error('Failed to close websocket after idle timeout:', err);
      }
    }
  }, TERMINAL_IDLE_TIMEOUT_MS);
}

// API endpoint to list sessions
app.get('/api/sessions', (req, res) => {
  if (!isTmuxAvailable()) {
    return res.json({
      tmuxAvailable: false,
      sessions: [],
      message: 'tmux is not installed. Install it with: brew install tmux'
    });
  }

  res.json({
    tmuxAvailable: true,
    sessions: getTmuxSessions()
  });
});

app.post('/api/tmux/rename', (req, res) => {
  if (!isTmuxAvailable()) {
    return res.status(400).json({ error: 'tmux is not installed on the server.' });
  }

  const currentName = typeof req.body?.currentName === 'string' ? req.body.currentName.trim() : '';
  const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';

  if (!currentName) {
    return res.status(400).json({ error: 'Current session name is required.' });
  }

  if (!newName) {
    return res.status(400).json({ error: 'New session name cannot be empty.' });
  }

  if (!/^[\w\-.]+$/.test(newName)) {
    return res.status(400).json({ error: 'Session name may only contain letters, numbers, dash, underscore, or dot.' });
  }

  const rename = spawnSync('tmux', ['rename-session', '-t', currentName, newName]);
  if (rename.status !== 0 || rename.error) {
    const stderr = rename.stderr ? rename.stderr.toString().trim() : '';
    console.error('Failed to rename tmux session:', rename.error || stderr || rename.status);
    return res.status(500).json({ error: stderr || 'Failed to rename tmux session.' });
  }

  terminals.forEach((session, id) => {
    if (session.sessionName === currentName) {
      session.sessionName = newName;
    }
  });

  res.json({ success: true, newName });
});

if (HEARTBEAT_INTERVAL > 0) {
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) {
        console.warn('Terminating stale websocket connection');
        return client.terminate();
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch (err) {
        console.error('Failed to ping client:', err);
      }
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeatInterval));
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let term = null;
  let terminalId = null;
  let sessionMode = null; // 'new' or 'attach'
  let sessionName = null;

  // Handle messages from browser
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'create' && !term) {
        // Create new session or attach to existing
        sessionMode = msg.mode || 'new';
        sessionName = msg.sessionName;

        if (MAX_TERMINALS > 0 && terminals.size >= MAX_TERMINALS) {
          console.warn('Terminal limit reached, rejecting new session');
          sendError(ws, 'Maximum number of terminals reached. Please close an existing session and try again.');
          ws.close(1013, 'Max terminals reached');
          return;
        }

        if (sessionMode === 'attach' && sessionName) {
          // Attach to existing tmux session
          console.log(`Attaching to tmux session: ${sessionName}`);
          if (!isTmuxAvailable()) {
            sendError(ws, 'tmux is not installed on the server.');
            ws.close(1011, 'tmux unavailable');
            return;
          }

          try {
            term = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
              name: 'xterm-256color',
              cols: msg.cols || 80,
              rows: msg.rows || 24,
              cwd: process.env.HOME,
              env: process.env
            });
          } catch (spawnErr) {
            console.error('Failed to attach to tmux session:', spawnErr);
            sendError(ws, `Failed to attach to tmux session "${sessionName}".`);
            ws.close(1011, 'Failed to attach tmux');
            return;
          }
        } else if (sessionMode === 'tmux') {
          // Create new tmux session
          if (!isTmuxAvailable()) {
            sendError(ws, 'tmux is not installed on the server.');
            ws.close(1011, 'tmux unavailable');
            return;
          }

          sessionName = msg.sessionName || `tailmux-${Date.now()}`;
          console.log(`Creating new tmux session: ${sessionName}`);

          const hasSession = spawnSync('tmux', ['has-session', '-t', sessionName]);
          if (hasSession.status !== 0 || hasSession.error) {
            const createSession = spawnSync('tmux', ['new-session', '-d', '-s', sessionName]);

            if (createSession.status !== 0 || createSession.error) {
              const stderr = createSession.stderr ? createSession.stderr.toString().trim() : '';
              console.error('Failed to create tmux session:', createSession.error || stderr || createSession.status);
              sendError(ws, `Failed to create tmux session "${sessionName}".`);
              ws.close(1011, 'Failed to create tmux');
              return;
            }
          }

          try {
            term = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
              name: 'xterm-256color',
              cols: msg.cols || 80,
              rows: msg.rows || 24,
              cwd: process.env.HOME,
              env: process.env
            });
          } catch (spawnErr) {
            console.error('Failed to attach to new tmux session:', spawnErr);
            sendError(ws, `Failed to attach to tmux session "${sessionName}".`);
            ws.close(1011, 'Failed to attach tmux');
            return;
          }
        } else {
          // Create regular shell session (no tmux)
          const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
          console.log(`Creating new shell session`);
          try {
            term = pty.spawn(shell, [], {
              name: 'xterm-256color',
              cols: msg.cols || 80,
              rows: msg.rows || 24,
              cwd: process.env.HOME,
              env: process.env
            });
          } catch (spawnErr) {
            console.error('Failed to spawn shell:', spawnErr);
            sendError(ws, 'Failed to start a shell session.');
            ws.close(1011, 'Failed to spawn shell');
            return;
          }
        }

        terminalId = Date.now().toString();
        terminals.set(terminalId, {
          term,
          sessionMode,
          sessionName,
          ws,
          idleTimer: null
        });

        scheduleIdleTimeout(terminalId);

        // Send terminal output to browser
        term.onData((data) => {
          try {
            ws.send(JSON.stringify({ type: 'output', data }));
          } catch (err) {
            console.error('Error sending data to client:', err);
          }
        });

        // Handle terminal exit
        term.onExit(({ exitCode, signal }) => {
          console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
          clearIdleTimeout(terminalId);
          terminals.delete(terminalId);
          try {
            ws.send(JSON.stringify({ type: 'exit', exitCode }));
            ws.close();
          } catch (err) {
            console.error('Error on terminal exit:', err);
          }
        });

        // Send ready signal
        ws.send(JSON.stringify({ type: 'ready' }));

      } else if (msg.type === 'input' && term) {
        term.write(msg.data);
        scheduleIdleTimeout(terminalId);
      } else if (msg.type === 'resize' && term) {
        term.resize(msg.cols, msg.rows);
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  // Cleanup on disconnect
  ws.on('close', () => {
    console.log('Client disconnected');
    const session = terminals.get(terminalId);
    if (!session) {
      term = null;
      return;
    }

    if ((session.sessionMode === 'attach' || session.sessionMode === 'tmux') && session.sessionName) {
      detachTmuxClient(session);
    }

    clearIdleTimeout(terminalId);

    try {
      session.term.kill();
    } catch (err) {
      console.error('Failed to kill terminal process:', err);
    }

    terminals.delete(terminalId);
    term = null;
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
