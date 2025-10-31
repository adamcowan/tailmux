// Terminal tabs management
const tabs = new Map();
let activeTabId = null;
let nextTabId = 1;
let sessionMode = 'new';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 500;
const RECONNECT_MAX_DELAY = 5000;

const SESSION_CACHE_TTL = 5000;
let cachedSessions = null;
let cachedSessionsTimestamp = 0;
let sessionFetchPromise = null;

const DEFAULT_TOAST_DURATION = 4000;
let toastContainer = null;

function dismissToast(toast) {
  if (!toast) return;
  const timeoutId = toast.dataset.timeoutId;
  if (timeoutId) {
    clearTimeout(Number(timeoutId));
    delete toast.dataset.timeoutId;
  }
  toast.classList.remove('visible');
  toast.classList.add('hiding');
  setTimeout(() => {
    if (toast.parentElement) {
      toast.parentElement.removeChild(toast);
    }
  }, 200);
}

function showToast(message, variant = 'info', options = {}) {
  if (!toastContainer) return null;

  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  const duration = typeof options.duration === 'number' ? options.duration : DEFAULT_TOAST_DURATION;
  if (duration > 0) {
    const timeoutId = setTimeout(() => dismissToast(toast), duration);
    toast.dataset.timeoutId = timeoutId.toString();
  }

  toast.addEventListener('click', () => dismissToast(toast));

  return toast;
}

function handleWindowResize() {
  if (!activeTabId) return;

  const tab = tabs.get(activeTabId);
  if (!tab) return;

  tab.fitAddon.fit();

  if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
    tab.socket.send(JSON.stringify({
      type: 'resize',
      cols: tab.term.cols,
      rows: tab.term.rows
    }));
  }
}

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  toastContainer = document.getElementById('toast-container');
  showSessionSelector();
  setupMobileDetection();
  setupTmuxFastActions();
});

window.addEventListener('resize', handleWindowResize);

function invalidateSessionCache() {
  cachedSessions = null;
  cachedSessionsTimestamp = 0;
}

async function fetchSessions(force = false) {
  const now = Date.now();

  if (!force && cachedSessions && (now - cachedSessionsTimestamp) < SESSION_CACHE_TTL) {
    return cachedSessions;
  }

  if (!force && sessionFetchPromise) {
    return sessionFetchPromise;
  }

  const request = fetch('/api/sessions')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      cachedSessions = data;
      cachedSessionsTimestamp = Date.now();
      return data;
    })
    .catch((err) => {
      console.error('Failed to fetch sessions:', err);
      throw err;
    })
    .finally(() => {
      sessionFetchPromise = null;
    });

  if (!force) {
    sessionFetchPromise = request;
  }

  return request;
}

// Mobile detection
function setupMobileDetection() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    document.body.classList.add('mobile');
  }
}

function setupTmuxFastActions() {
  const newWindowBtn = document.getElementById('tmux-new-window-btn');
  const renameBtn = document.getElementById('tmux-rename-btn');
  if (!newWindowBtn) return;

  newWindowBtn.addEventListener('click', () => {
    if (!activeTabId) {
      showToast('Open a tmux tab before adding a window.', 'warning');
      return;
    }

    const tab = tabs.get(activeTabId);
    if (!tab || (tab.mode !== 'tmux' && tab.mode !== 'attach')) {
      showToast('New tmux window is only available inside tmux tabs.', 'warning');
      return;
    }

    if (!tab.socket || tab.socket.readyState !== WebSocket.OPEN) {
      showToast('Session is not connected yet.', 'error');
      return;
    }

    sendTmuxCommandInternal(null, 'c', activeTabId);
    showToast('Created new tmux window.', 'success', { duration: 2000 });
  });

  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      if (!activeTabId) {
        showToast('Open a tmux tab before renaming.', 'warning');
        return;
      }

      const tab = tabs.get(activeTabId);
      if (!tab || (tab.mode !== 'tmux' && tab.mode !== 'attach')) {
        showToast('Rename is only available inside tmux tabs.', 'warning');
        return;
      }

      if (!tab.socket || tab.socket.readyState !== WebSocket.OPEN) {
        showToast('Session is not connected yet.', 'error');
        return;
      }

      if (!tab.sessionName) {
        showToast('Session name is unavailable for this tab.', 'error');
        return;
      }

      const proposed = prompt('Rename tmux session', tab.sessionName);
      if (proposed === null) {
        return;
      }

      const newName = proposed.trim();
      if (!newName) {
        showToast('Session name cannot be empty.', 'warning');
        return;
      }

      if (newName === tab.sessionName) {
        showToast('Session name unchanged.', 'info', { duration: 2000 });
        return;
      }

      renameBtn.disabled = true;

      try {
        const response = await fetch('/api/tmux/rename', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ currentName: tab.sessionName, newName })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to rename tmux session.');
        }

        tab.sessionName = newName;
        tab.sessionLabel = newName;
        if (tab.tabButton) {
          const labelEl = tab.tabButton.querySelector('.tab-label');
          if (labelEl) {
            labelEl.textContent = newName;
          }
        }

        invalidateSessionCache();
        updateDashboard();
        showToast(`Renamed session to ${newName}`, 'success', { duration: 2500 });
      } catch (err) {
        showToast(err.message || 'Failed to rename tmux session.', 'error', { duration: 0 });
      } finally {
        renameBtn.disabled = false;
        updateTabActionButtons();
      }
    });
  }

  updateTabActionButtons();
}

function sendTmuxCommandInternal(evt, command, tabIdOverride) {
  const targetTabId = tabIdOverride || activeTabId;
  if (!targetTabId) return;

  const tab = tabs.get(targetTabId);
  if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN) return;

  const prefix = '\x02';
  let data = prefix;

  if (command === 'ArrowUp') {
    data += '\x1b[A';
  } else if (command === 'ArrowDown') {
    data += '\x1b[B';
  } else if (command === 'ArrowLeft') {
    data += '\x1b[D';
  } else if (command === 'ArrowRight') {
    data += '\x1b[C';
  } else if (command === '&quot;') {
    data += '"';
  } else {
    data += command;
  }

  tab.socket.send(JSON.stringify({
    type: 'input',
    data: data
  }));

  if (command === '[' && tab.tmuxCopyModeActive !== undefined) {
    setTmuxCopyMode(tab, true);
  } else if (command === 'q' && tab.tmuxCopyModeActive !== undefined) {
    setTmuxCopyMode(tab, false);
  }

  if (evt) {
    const button = evt?.target?.closest('button');
    if (button) {
      button.style.transform = 'scale(0.95)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

// Tab Management
function createTab(sessionLabel, mode, requestedSessionName = sessionLabel) {
  const tabId = `tab-${nextTabId++}`;
  const displayName = sessionLabel || 'Terminal';

  // Create terminal instance
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    scrollback: 10000, // Increased scrollback buffer
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selection: 'rgba(255, 255, 255, 0.3)',
      black: '#000000',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#bbbbbb',
      brightBlack: '#555555',
      brightRed: '#ff5555',
      brightGreen: '#50fa7b',
      brightYellow: '#f1fa8c',
      brightBlue: '#bd93f9',
      brightMagenta: '#ff79c6',
      brightCyan: '#8be9fd',
      brightWhite: '#ffffff'
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // Create terminal wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `terminal-${tabId}`;

  // Create scroll controls (mobile)
  const scrollControls = document.createElement('div');
  scrollControls.className = 'scroll-controls mobile-only';
  scrollControls.innerHTML = `
    <div class="scroll-indicator" id="scroll-indicator-${tabId}">
      <div class="scroll-indicator-track">
        <div class="scroll-indicator-bar"></div>
      </div>
      <div class="scroll-indicator-label">Live</div>
    </div>
    <button class="scroll-btn" data-action="up" title="Page up">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="18 15 12 9 6 15"></polyline>
      </svg>
    </button>
    <button class="scroll-btn" data-action="down" title="Page down">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
    <button class="scroll-btn" data-action="bottom" title="Exit scrollback">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="7 13 12 18 17 13"></polyline>
        <polyline points="7 6 12 11 17 6"></polyline>
      </svg>
    </button>
  `;

  let tmuxSoftKeys = null;
  if (mode === 'tmux' || mode === 'attach') {
    tmuxSoftKeys = document.createElement('div');
    tmuxSoftKeys.className = 'tmux-soft-keys mobile-only';
    tmuxSoftKeys.innerHTML = `
      <button class="tmux-soft-key" data-action="prev" title="Previous tmux window" aria-label="Previous tmux window">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <button class="tmux-soft-key" data-action="next" title="Next tmux window" aria-label="Next tmux window">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      <button class="tmux-soft-key" data-action="last" title="Last tmux window" aria-label="Last tmux window">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="8 6 12 10 8 14"></polyline>
          <polyline points="16 6 20 10 16 14"></polyline>
        </svg>
      </button>
    `;
  }

  const terminalDiv = document.createElement('div');
  terminalDiv.className = 'terminal';

  wrapper.appendChild(scrollControls);
  if (tmuxSoftKeys) {
    wrapper.appendChild(tmuxSoftKeys);
  }
  wrapper.appendChild(terminalDiv);

  document.getElementById('terminal-container').appendChild(wrapper);

  // Add event listeners AFTER adding to DOM
  console.log('Attaching scroll button listeners for', tabId);
  scrollControls.querySelectorAll('.scroll-btn').forEach((btn, index) => {
    console.log('Attaching listener to button', index, btn.getAttribute('data-action'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const action = e.currentTarget.getAttribute('data-action');
      console.log('Button clicked!', action);
      performScroll(tabId, action, e);
      return false;
    }, { passive: false });
  });

  if (tmuxSoftKeys) {
    tmuxSoftKeys.querySelectorAll('.tmux-soft-key').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = e.currentTarget.getAttribute('data-action');
        handleTmuxSoftKey(tabId, action, e);
        return false;
      }, { passive: false });
    });
  }

  // Open terminal
  term.open(terminalDiv);
  fitAddon.fit();

  // Enable touch scrolling
  setupTerminalScrolling(terminalDiv, term, tabId);

  term.onScroll(() => updateScrollIndicator(tabId));
  term.onLineFeed(() => updateScrollIndicator(tabId));
  updateScrollIndicator(tabId);

  // Create tab button
  const tabButton = document.createElement('div');
  tabButton.className = 'tab';
  tabButton.id = tabId;
  tabButton.innerHTML = `
    <div class="tab-status"></div>
    <div class="tab-label">${displayName}</div>
    <div class="tab-close" onclick="closeTab('${tabId}', event)">×</div>
  `;
  tabButton.onclick = (e) => {
    if (!e.target.classList.contains('tab-close')) {
      switchTab(tabId);
    }
  };

  document.getElementById('tabs').appendChild(tabButton);

  // Store tab data
  tabs.set(tabId, {
    term,
    fitAddon,
    wrapper,
    tabButton,
    socket: null,
    sessionName: requestedSessionName || '',
    sessionLabel: displayName,
    mode,
    connected: false,
    tmuxCopyModeActive: false,
    shouldReconnect: mode === 'tmux' || mode === 'attach',
    reconnectAttempts: 0,
    reconnectTimer: null,
    dataDisposable: null,
    reconnectToast: null,
    lastCloseReason: null
  });

  // Connect to server
  connectTerminal(tabId);

  // Switch to new tab
  switchTab(tabId);

  return tabId;
}

function switchTab(tabId) {
  if (activeTabId === tabId) return;

  // Hide all terminals
  tabs.forEach((tab, id) => {
    tab.wrapper.classList.remove('active');
    tab.tabButton.classList.remove('active');
  });

  // Show selected terminal
  const tab = tabs.get(tabId);
  if (tab) {
    tab.wrapper.classList.add('active');
    tab.tabButton.classList.add('active');
    activeTabId = tabId;

    updateScrollIndicator(tabId);

    // Refit terminal
    setTimeout(() => {
      tab.fitAddon.fit();
      tab.term.focus();
    }, 0);
  }

  updateDashboard();
  updateTabActionButtons();
}

function closeTab(tabId, event) {
  if (event) event.stopPropagation();

  const tab = tabs.get(tabId);
  if (!tab) return;

  tab.shouldReconnect = false;
  if (tab.reconnectTimer) {
    clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = null;
  }

  // Close socket
  if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
    tab.socket.close();
  }
  tab.socket = null;

  if (tab.reconnectToast) {
    dismissToast(tab.reconnectToast);
    tab.reconnectToast = null;
  }

  // Remove DOM elements
  tab.wrapper.remove();
  tab.tabButton.remove();

  // Remove from map
  tabs.delete(tabId);

  if (tab.dataDisposable) {
    tab.dataDisposable.dispose();
  }
  if (typeof tab.term.dispose === 'function') {
    tab.term.dispose();
  }

  if (tab.mode === 'tmux' || tab.mode === 'attach') {
    invalidateSessionCache();
  }

  // Switch to another tab if this was active
  if (activeTabId === tabId) {
    activeTabId = null;
    const remainingTabs = Array.from(tabs.keys());
    if (remainingTabs.length > 0) {
      switchTab(remainingTabs[0]);
    } else {
      showSessionSelector();
    }
  }

  updateDashboard();
  updateTabActionButtons();
}

function closeAllTabs() {
  if (!confirm('Close all tabs?')) return;

  const tabIds = Array.from(tabs.keys());
  tabIds.forEach(tabId => closeTab(tabId));

  toggleDashboard();
}

// Terminal Connection
function connectTerminal(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  if (tab.reconnectTimer) {
    clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = null;
  }

  const socket = new WebSocket(wsUrl);
  tab.socket = socket;

  if (!tab.dataDisposable) {
    tab.dataDisposable = tab.term.onData((data) => {
      if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({
          type: 'input',
          data
        }));
      }
    });
  }

  socket.onopen = () => {
    console.log(`WebSocket connected for ${tabId}`);
    const wasReconnecting = tab.reconnectAttempts > 0;
    tab.reconnectAttempts = 0;
    setTmuxCopyMode(tab, false);
    updateTabStatus(tabId, true);

    socket.send(JSON.stringify({
      type: 'create',
      mode: tab.mode,
      sessionName: tab.sessionName || '',
      cols: tab.term.cols,
      rows: tab.term.rows
    }));

    if (wasReconnecting) {
      if (tab.reconnectToast) {
        dismissToast(tab.reconnectToast);
        tab.reconnectToast = null;
      }
      showToast(`Reconnected to ${tab.sessionLabel}`, 'success');
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'output') {
        tab.term.write(msg.data);
      } else if (msg.type === 'exit') {
        tab.shouldReconnect = false;
        tab.term.write('\r\n\r\n[Process exited with code ' + msg.exitCode + ']\r\n');
        updateTabStatus(tabId, false);
        tab.lastCloseReason = 'exit';
        if (tab.reconnectToast) {
          dismissToast(tab.reconnectToast);
          tab.reconnectToast = null;
        }
        showToast(`${tab.sessionLabel} exited (code ${msg.exitCode})`, 'info');
      } else if (msg.type === 'error') {
        tab.shouldReconnect = false;
        const errorMessage = msg.message || 'An unknown error occurred.';
        tab.term.write(`\r\n\r\n[Error: ${errorMessage}]\r\n`);
        updateTabStatus(tabId, false);
        tab.lastCloseReason = 'error';
        if (tab.reconnectToast) {
          dismissToast(tab.reconnectToast);
          tab.reconnectToast = null;
        }
        const lowered = errorMessage.toLowerCase();
        const variant = lowered.includes('inactive') || lowered.includes('inactivity') ? 'warning' : 'error';
        showToast(errorMessage, variant, { duration: variant === 'error' ? 0 : DEFAULT_TOAST_DURATION });
        socket.close();
      } else if (msg.type === 'ready') {
        console.log(`Terminal ready: ${tabId}`);
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  };

  socket.onerror = (error) => {
    console.error(`WebSocket error for ${tabId}:`, error);
    updateTabStatus(tabId, false);
  };

  socket.onclose = () => {
    tab.socket = null;
    if (!tabs.has(tabId)) {
      return;
    }

    console.log(`WebSocket disconnected for ${tabId}`);
    updateTabStatus(tabId, false);
    tab.term.write('\r\n\r\n[Connection closed]\r\n');
    setTmuxCopyMode(tab, false);

    if (tab.shouldReconnect) {
      if (tab.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        tab.term.write('\r\n\r\n[Reconnect attempts exhausted. Please reopen the session manually.]\r\n');
        const exhaustedMessage = `Reconnect attempts exhausted for ${tab.sessionLabel}`;
        if (tab.reconnectToast) {
          tab.reconnectToast.textContent = exhaustedMessage;
        } else {
          tab.reconnectToast = showToast(exhaustedMessage, 'error', { duration: 0 });
        }
        tab.shouldReconnect = false;
        tab.reconnectAttempts = 0;
      } else {
        const nextAttempt = tab.reconnectAttempts + 1;
        const retryMessage = `Connection lost. Reconnecting ${tab.sessionLabel} (${nextAttempt}/${MAX_RECONNECT_ATTEMPTS})...`;
        if (tab.reconnectToast) {
          tab.reconnectToast.textContent = retryMessage;
        } else {
          tab.reconnectToast = showToast(retryMessage, 'warning', { duration: 0 });
        }

        const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * Math.pow(2, tab.reconnectAttempts));
        tab.reconnectAttempts = nextAttempt;
        tab.term.write(`\r\n[Reconnecting in ${(delay / 1000).toFixed(1)}s...]\r\n`);

        tab.reconnectTimer = setTimeout(() => {
          tab.reconnectTimer = null;
          connectTerminal(tabId);
        }, delay);
      }
    } else {
      if (tab.reconnectToast) {
        dismissToast(tab.reconnectToast);
        tab.reconnectToast = null;
      }
      if (tab.lastCloseReason !== 'exit' && tab.lastCloseReason !== 'error') {
        showToast(`${tab.sessionLabel} disconnected`, 'warning');
      }
      tab.reconnectAttempts = 0;
    }

    tab.lastCloseReason = null;
  };
}

function updateTabStatus(tabId, connected) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  tab.connected = connected;
  const statusEl = tab.tabButton.querySelector('.tab-status');
  if (statusEl) {
    statusEl.classList.toggle('disconnected', !connected);
  }

  updateDashboard();
  if (tabId === activeTabId) {
    updateTabActionButtons();
  }
}

// Session Selector
async function showSessionSelector() {
  await loadSessions();
  document.getElementById('session-selector').classList.remove('hidden');
}

function hideSessionSelector() {
  document.getElementById('session-selector').classList.add('hidden');
  hideNewSessionForm();
}

async function loadSessions() {
  try {
    const data = await fetchSessions(true);

    const existingSessionsDiv = document.getElementById('existing-sessions');

    if (!data.tmuxAvailable) {
      document.getElementById('tmux-warning').classList.remove('hidden');
      return;
    } else {
      document.getElementById('tmux-warning').classList.add('hidden');
    }

    if (data.sessions && data.sessions.length > 0) {
      const sessionsHtml = data.sessions.map(session => `
        <div class="session-option" onclick="attachToSession('${session.name}')">
          <h3>Attach to: ${session.name}</h3>
          <p>
            ${session.windows} window(s) |
            ${session.attached ? 'Currently attached' : 'Detached'} |
            Created: ${new Date(session.created).toLocaleString()}
          </p>
        </div>
      `).join('');

      existingSessionsDiv.innerHTML = `
        <h3 style="color: #fff; font-size: 16px; margin-bottom: 10px;">Existing tmux Sessions</h3>
        ${sessionsHtml}
      `;
    } else {
      existingSessionsDiv.innerHTML = '';
    }
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function showNewSessionForm(mode) {
  sessionMode = mode;
  document.getElementById('new-session-form').classList.remove('hidden');
}

function hideNewSessionForm() {
  document.getElementById('new-session-form').classList.add('hidden');
  document.getElementById('session-name').value = '';
}

function attachToSession(sessionName) {
  createTab(sessionName, 'attach', sessionName);
  invalidateSessionCache();
  hideSessionSelector();
}

function createSession() {
  const userInput = document.getElementById('session-name').value.trim();
  let actualSessionName = userInput;
  let displayLabel = userInput;

  if (sessionMode === 'tmux') {
    if (!actualSessionName) {
      actualSessionName = `tailmux-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
    displayLabel = userInput || actualSessionName;
  } else if (sessionMode === 'new') {
    actualSessionName = userInput || '';
    displayLabel = userInput || 'shell';
  }

  createTab(displayLabel, sessionMode, actualSessionName);
  if (sessionMode === 'tmux') {
    invalidateSessionCache();
  }
  hideSessionSelector();
}

// Dashboard
function toggleDashboard() {
  const dashboard = document.getElementById('dashboard');
  dashboard.classList.toggle('hidden');

  if (!dashboard.classList.contains('hidden')) {
  updateDashboard();
  updateTabActionButtons();
}
}

async function updateDashboard() {
  // Update stats
  const activeTabs = Array.from(tabs.values()).filter(t => t.connected).length;
  document.getElementById('stat-active').textContent = activeTabs;
  document.getElementById('stat-tabs').textContent = tabs.size;

  // Get tmux sessions count
  try {
    const data = await fetchSessions();
    document.getElementById('stat-tmux').textContent = data.sessions?.length || 0;
  } catch (err) {
    document.getElementById('stat-tmux').textContent = '?';
  }

  // Update tabs list
  const tabsList = document.getElementById('dashboard-tabs-list');
  if (tabs.size === 0) {
    tabsList.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No active tabs</p>';
  } else {
    tabsList.innerHTML = Array.from(tabs.entries()).map(([tabId, tab]) => `
      <div class="dashboard-tab-item">
        <div class="dashboard-tab-info">
          <div class="dashboard-tab-name">${tab.sessionLabel}</div>
          <div class="dashboard-tab-details">
            ${tab.mode} | ${tab.connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div class="dashboard-tab-actions">
          <button class="icon-btn" onclick="switchTab('${tabId}'); toggleDashboard();" title="Switch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
          <button class="icon-btn" onclick="closeTab('${tabId}')" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    `).join('');
  }
}

// Virtual Keyboard (Mobile)
function toggleVirtualKeyboard() {
  const keyboard = document.getElementById('virtual-keyboard');
  const container = document.getElementById('terminal-container');

  keyboard.classList.toggle('hidden');
  container.classList.toggle('keyboard-visible');

  // Refit active terminal
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      setTimeout(() => tab.fitAddon.fit(), 100);
    }
  }
}

function sendKey(key, modifier) {
  if (!activeTabId) return;

  const tab = tabs.get(activeTabId);
  if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN) return;

  let data;

  if (modifier === 'c') {
    data = '\x03'; // Ctrl+C
  } else if (modifier === 'd') {
    data = '\x04'; // Ctrl+D
  } else if (modifier === 'z') {
    data = '\x1a'; // Ctrl+Z
  } else if (key === 'Escape') {
    data = '\x1b';
  } else if (key === 'Tab') {
    data = '\t';
  } else if (key === 'Enter') {
    data = '\r';
  } else if (key === 'ArrowUp') {
    data = '\x1b[A';
  } else if (key === 'ArrowDown') {
    data = '\x1b[B';
  } else if (key === 'ArrowRight') {
    data = '\x1b[C';
  } else if (key === 'ArrowLeft') {
    data = '\x1b[D';
  }

  if (data) {
    tab.socket.send(JSON.stringify({
      type: 'input',
      data: data
    }));
  }
}

// tmux Control Panel (Mobile)
function toggleTmuxPanel() {
  const panel = document.getElementById('tmux-panel');
  const keyboard = document.getElementById('virtual-keyboard');
  const container = document.getElementById('terminal-container');

  // Hide keyboard if showing
  if (!keyboard.classList.contains('hidden')) {
    keyboard.classList.add('hidden');
    container.classList.remove('keyboard-visible');
  }

  // Toggle tmux panel
  panel.classList.toggle('hidden');
  container.classList.toggle('tmux-visible');

  // Refit active terminal
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      setTimeout(() => tab.fitAddon.fit(), 100);
    }
  }
}

function sendTmuxCommand(evt, command) {
  sendTmuxCommandInternal(evt, command, activeTabId);
}

// Terminal Scrolling Controls
function setupTerminalScrolling(terminalDiv, term, tabId) {
  let touchStartY = 0;
  let touchStartTime = 0;
  let isScrolling = false;
  let scrollVelocity = 0;

  // Detect two-finger touch for scrolling
  terminalDiv.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // Two-finger touch = scroll mode
      isScrolling = true;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      e.preventDefault();
    }
  }, { passive: false });

  terminalDiv.addEventListener('touchmove', (e) => {
    if (isScrolling && e.touches.length === 2) {
      const touchY = e.touches[0].clientY;
      const deltaY = touchStartY - touchY;
      const deltaTime = Date.now() - touchStartTime;

      // Calculate velocity for momentum scrolling
      scrollVelocity = deltaY / (deltaTime || 1);

      // Scroll the terminal
      const scrollAmount = Math.round(deltaY / 20); // Adjust sensitivity
      if (Math.abs(scrollAmount) > 0) {
        term.scrollLines(scrollAmount);
        updateScrollIndicator(tabId);
        touchStartY = touchY;
        touchStartTime = Date.now();
      }

      e.preventDefault();
    }
  }, { passive: false });

  terminalDiv.addEventListener('touchend', (e) => {
    if (isScrolling) {
      // Apply momentum scrolling
      if (Math.abs(scrollVelocity) > 0.5) {
        const momentum = Math.round(scrollVelocity * 10);
        term.scrollLines(momentum);
        updateScrollIndicator(tabId);
      }
      isScrolling = false;
      scrollVelocity = 0;
    }
  });

  // Mouse wheel scrolling (desktop)
  terminalDiv.addEventListener('wheel', (e) => {
    const delta = e.deltaY > 0 ? 3 : -3;
    term.scrollLines(delta);
    updateScrollIndicator(tabId);
    e.preventDefault();
  }, { passive: false });
}

// Scroll function for on-screen buttons
function performScroll(tabId, direction, event) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.term) {
    console.error('Unable to perform scroll - terminal missing for tab:', tabId);
    return;
  }

  let handled = false;

  if (tab.mode === 'tmux' || tab.mode === 'attach') {
    handled = performTmuxScroll(tab, direction);
  } else {
    handled = performLocalScroll(tab, direction);
  }

  if (handled) {
    // Allow tmux some time to update before recomputing indicator
    setTimeout(() => updateScrollIndicator(tabId), (tab.mode === 'tmux' || tab.mode === 'attach') ? 100 : 0);
  }

  // Visual feedback
  if (event) {
    const button = event.target.closest('button');
    if (button) {
      button.style.transform = 'scale(0.9)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

function setTmuxCopyMode(tab, isActive) {
  if (!tab) return;
  tab.tmuxCopyModeActive = isActive;
  if (tab.wrapper) {
    tab.wrapper.classList.toggle('tmux-copy-mode', Boolean(isActive));
  }
}

function performLocalScroll(tab, direction) {
  const term = tab.term;
  const buffer = term.buffer.active;
  const viewportStart = typeof buffer.viewportY === 'number'
    ? buffer.viewportY
    : buffer.baseY;
  const maxViewportStart = Math.max(0, buffer.length - term.rows);
  const pageSize = Math.max(1, Math.floor(term.rows * 0.75));

  const scrollToLine = (line) => {
    if (typeof term.scrollToLine === 'function') {
      term.scrollToLine(line);
    } else {
      term.scrollLines(line - viewportStart);
    }
  };

  switch (direction) {
    case 'up':
      scrollToLine(Math.max(0, viewportStart - pageSize));
      return true;
    case 'down':
      scrollToLine(Math.min(maxViewportStart, viewportStart + pageSize));
      return true;
    case 'bottom':
      term.scrollToBottom();
      return true;
    default:
      console.warn('Unknown scroll direction:', direction);
      return false;
  }
}

function performTmuxScroll(tab, direction) {
  if (!tab.socket || tab.socket.readyState !== WebSocket.OPEN) {
    console.warn('Cannot scroll tmux session - socket not ready');
    return false;
  }

  const sendInput = (data) => {
    tab.socket.send(JSON.stringify({
      type: 'input',
      data
    }));
  };

  const ensureCopyMode = () => {
    if (tab.tmuxCopyModeActive) {
      return;
    }
    sendInput('\x02['); // Ctrl+B [
    setTmuxCopyMode(tab, true);
  };

  switch (direction) {
    case 'up':
      ensureCopyMode();
      sendInput('\x1b[5~'); // Page Up
      return true;
    case 'down':
      ensureCopyMode();
      sendInput('\x1b[6~'); // Page Down
      return true;
    case 'bottom':
      if (tab.tmuxCopyModeActive) {
        sendInput('q'); // exit copy mode
        setTmuxCopyMode(tab, false);
        return true;
      }
      return false;
    default:
      console.warn('Unknown tmux scroll direction:', direction);
      return false;
  }
}

function handleTmuxSoftKey(tabId, action, event) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send tmux window command - socket not ready');
    return;
  }

  const sendInput = (data) => {
    tab.socket.send(JSON.stringify({
      type: 'input',
      data
    }));
  };

  const tmuxPrefix = '\x02';
  let command = null;

  switch (action) {
    case 'prev':
      command = 'p';
      break;
    case 'next':
      command = 'n';
      break;
    case 'last':
      command = 'l';
      break;
    default:
      console.warn('Unknown tmux soft key action:', action);
  }

  if (command) {
    sendInput(tmuxPrefix + command);
  }

  if (event) {
    const button = event.target.closest('button');
    if (button) {
      button.style.transform = 'scale(0.9)';
      setTimeout(() => {
        button.style.transform = '';
      }, 100);
    }
  }
}

function updateScrollIndicator(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.term) return;

  const term = tab.term;
  const buffer = term.buffer.active;

  const totalLines = buffer.length;
  const viewportStart = typeof buffer.viewportY === 'number'
    ? buffer.viewportY
    : buffer.baseY;
  const maxViewportStart = Math.max(0, totalLines - term.rows);
  const hasHistory = maxViewportStart > 0;
  const inHistory = hasHistory && viewportStart < maxViewportStart;

  // Update indicator
  const indicator = document.getElementById(`scroll-indicator-${tabId}`);
  if (indicator) {
    indicator.classList.toggle('active', hasHistory);
    indicator.classList.toggle('history', inHistory);
    indicator.classList.toggle('live', !inHistory);

    const bar = indicator.querySelector('.scroll-indicator-bar');
    if (bar) {
      const visibleRatio = totalLines > 0 ? Math.min(1, term.rows / totalLines) : 1;
      const clampedRatio = Math.max(0.12, visibleRatio);
      const barHeight = clampedRatio * 100;
      const offsetRatio = hasHistory ? Math.min(1, viewportStart / maxViewportStart) : 0;
      const translate = (100 - barHeight) * offsetRatio;

      bar.style.height = `${barHeight}%`;
      bar.style.transform = `translateY(${translate}%)`;
    }

    const label = indicator.querySelector('.scroll-indicator-label');
    if (label) {
      label.textContent = inHistory ? 'History' : 'Live';
    }
  }
}

function updateTabActionButtons() {
  const newWindowBtn = document.getElementById('tmux-new-window-btn');
  const renameBtn = document.getElementById('tmux-rename-btn');

  const tab = activeTabId ? tabs.get(activeTabId) : null;
  const isTmuxActive = Boolean(tab && (tab.mode === 'tmux' || tab.mode === 'attach') && tab.connected && tab.socket && tab.socket.readyState === WebSocket.OPEN);

  [newWindowBtn, renameBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !isTmuxActive;
    btn.classList.toggle('disabled', !isTmuxActive);
  });
}
