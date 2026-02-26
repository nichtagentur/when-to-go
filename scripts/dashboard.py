#!/usr/bin/env python3
"""
Real-time web dashboard for the email-editor service.
Shows live logs, queue progress, and service health at http://localhost:8080
"""

import json
import subprocess
import threading
import queue
import time
from pathlib import Path
from datetime import datetime
from flask import Flask, Response, jsonify, render_template_string

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = 8080
PROJECT_DIR = Path.home() / "Projects" / "when-to-go"
QUEUE_FILE = PROJECT_DIR / "data" / "queue.json"
SERVICE_NAME = "email-editor"

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def get_service_status():
    """Get systemd service status info."""
    try:
        result = subprocess.run(
            ["systemctl", "--user", "show", SERVICE_NAME,
             "--property=ActiveState,SubState,ExecMainStartTimestamp"],
            capture_output=True, text=True, timeout=5
        )
        props = {}
        for line in result.stdout.strip().split("\n"):
            if "=" in line:
                key, val = line.split("=", 1)
                props[key] = val

        active = props.get("ActiveState", "unknown")
        sub = props.get("SubState", "unknown")
        started = props.get("ExecMainStartTimestamp", "")

        return {
            "running": active == "active",
            "state": f"{active} ({sub})",
            "started": started,
        }
    except Exception as e:
        return {"running": False, "state": f"error: {e}", "started": ""}


def get_queue_stats():
    """Read queue.json and return tier breakdown."""
    try:
        data = json.loads(QUEUE_FILE.read_text())
    except Exception:
        return {"tiers": {}, "total": 0}

    tiers = {}
    for item in data:
        t = item.get("tier", 0)
        s = item.get("status", "pending")
        if t not in tiers:
            tiers[t] = {"generated": 0, "pending": 0, "error": 0, "total": 0}
        tiers[t][s] = tiers[t].get(s, 0) + 1
        tiers[t]["total"] += 1

    total_gen = sum(t["generated"] for t in tiers.values())
    total_all = sum(t["total"] for t in tiers.values())

    return {
        "tiers": {str(k): v for k, v in sorted(tiers.items())},
        "total_generated": total_gen,
        "total": total_all,
    }


def get_recent_commits():
    """Get last 5 git commits from the project."""
    try:
        result = subprocess.run(
            ["git", "-C", str(PROJECT_DIR), "log", "--oneline", "-5",
             "--format=%h|%s|%cr"],
            capture_output=True, text=True, timeout=5
        )
        commits = []
        for line in result.stdout.strip().split("\n"):
            if "|" in line:
                parts = line.split("|", 2)
                commits.append({
                    "hash": parts[0],
                    "message": parts[1],
                    "time": parts[2],
                })
        return commits
    except Exception:
        return []


# ---------------------------------------------------------------------------
# SSE log streaming
# ---------------------------------------------------------------------------

def log_stream_generator():
    """Yield SSE events by tailing journalctl for the email-editor service."""
    proc = subprocess.Popen(
        ["journalctl", "--user", "-u", SERVICE_NAME, "-f", "--no-pager",
         "-n", "50", "-o", "short-iso"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    try:
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip()
            if line:
                # Determine log level for color coding
                level = "info"
                if "WARNING" in line:
                    level = "warning"
                elif "ERROR" in line or "CRITICAL" in line:
                    level = "error"
                elif "DEBUG" in line:
                    level = "debug"

                data = json.dumps({"line": line, "level": level})
                yield f"data: {data}\n\n"
    finally:
        proc.terminate()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/stream")
def stream():
    """SSE endpoint -- streams live log lines to the browser."""
    return Response(
        log_stream_generator(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )


@app.route("/api/status")
def api_status():
    """JSON endpoint -- service status, queue summary, recent commits."""
    return jsonify({
        "service": get_service_status(),
        "queue": get_queue_stats(),
        "commits": get_recent_commits(),
        "timestamp": datetime.now().isoformat(),
    })


@app.route("/api/queue")
def api_queue():
    """JSON endpoint -- full queue breakdown."""
    return jsonify(get_queue_stats())


@app.route("/")
def index():
    """Serve the dashboard page with all HTML/CSS/JS inline."""
    return render_template_string(DASHBOARD_HTML)


# ---------------------------------------------------------------------------
# Inline dashboard HTML
# ---------------------------------------------------------------------------

DASHBOARD_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Email Editor Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0f1117;
    color: #c9d1d9;
    min-height: 100vh;
  }

  header {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  header h1 {
    font-size: 18px;
    font-weight: 600;
    color: #e6edf3;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
  }

  .status-badge.running { background: #0d1f0d; color: #3fb950; border: 1px solid #238636; }
  .status-badge.stopped { background: #2d1215; color: #f85149; border: 1px solid #da3633; }
  .status-badge .dot {
    width: 8px; height: 8px; border-radius: 50%;
    animation: pulse 2s infinite;
  }
  .status-badge.running .dot { background: #3fb950; }
  .status-badge.stopped .dot { background: #f85149; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 380px;
    grid-template-rows: auto 1fr;
    gap: 16px;
    padding: 16px 24px;
    height: calc(100vh - 65px);
  }

  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    overflow: hidden;
  }

  .card-header {
    padding: 12px 16px;
    border-bottom: 1px solid #30363d;
    font-size: 13px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* -- Log panel -- */
  .log-panel { grid-column: 1; grid-row: 1 / 3; display: flex; flex-direction: column; }
  .log-panel .card-header { display: flex; justify-content: space-between; align-items: center; }

  #log-container {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12.5px;
    line-height: 1.6;
  }

  #log-container::-webkit-scrollbar { width: 6px; }
  #log-container::-webkit-scrollbar-track { background: transparent; }
  #log-container::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .log-line {
    padding: 1px 16px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .log-line:hover { background: #1c2128; }
  .log-line.info { color: #8cc265; }
  .log-line.warning { color: #e5c07b; }
  .log-line.error { color: #f47067; }
  .log-line.debug { color: #6cb6ff; }

  .log-count {
    font-size: 11px;
    color: #484f58;
    font-weight: 400;
  }

  /* -- Queue panel -- */
  .queue-panel { grid-column: 2; grid-row: 1; }

  .tier-row {
    padding: 14px 16px;
    border-bottom: 1px solid #21262d;
  }
  .tier-row:last-child { border-bottom: none; }

  .tier-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .tier-label .name { color: #e6edf3; font-weight: 500; }
  .tier-label .count { color: #8b949e; }

  .progress-bar {
    height: 8px;
    background: #21262d;
    border-radius: 4px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.6s ease;
  }
  .tier-1 .progress-fill { background: linear-gradient(90deg, #3fb950, #56d364); }
  .tier-2 .progress-fill { background: linear-gradient(90deg, #1f6feb, #58a6ff); }
  .tier-3 .progress-fill { background: linear-gradient(90deg, #8957e5, #bc8cff); }

  .tier-detail {
    display: flex;
    gap: 16px;
    margin-top: 6px;
    font-size: 11px;
    color: #6e7681;
  }

  .total-bar {
    padding: 14px 16px;
    border-top: 1px solid #30363d;
    background: #0d1117;
  }
  .total-bar .tier-label .name { color: #8b949e; }
  .total-bar .progress-fill { background: linear-gradient(90deg, #da3633, #f78166, #3fb950); }

  /* -- Activity panel -- */
  .activity-panel { grid-column: 2; grid-row: 2; display: flex; flex-direction: column; }

  .commit-list { flex: 1; overflow-y: auto; }

  .commit-row {
    padding: 10px 16px;
    border-bottom: 1px solid #21262d;
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .commit-row:last-child { border-bottom: none; }

  .commit-hash {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #58a6ff;
    background: #0d1117;
    padding: 2px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .commit-msg {
    font-size: 13px;
    color: #c9d1d9;
    flex: 1;
    line-height: 1.4;
  }
  .commit-time {
    font-size: 11px;
    color: #484f58;
    flex-shrink: 0;
  }

  /* Connection status */
  .connection-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
  }
  .connection-status.connected { color: #3fb950; }
  .connection-status.disconnected { color: #f85149; }
</style>
</head>
<body>

<header>
  <h1>Email Editor -- Live Dashboard</h1>
  <div>
    <span class="connection-status" id="conn-status">connecting...</span>
    <span class="status-badge stopped" id="service-badge">
      <span class="dot"></span>
      <span id="service-state">checking...</span>
    </span>
  </div>
</header>

<div class="grid">
  <!-- Live Logs -->
  <div class="card log-panel">
    <div class="card-header">
      Live Logs
      <span class="log-count" id="log-count">0 lines</span>
    </div>
    <div id="log-container"></div>
  </div>

  <!-- Queue Progress -->
  <div class="card queue-panel">
    <div class="card-header">Queue Progress</div>
    <div id="queue-tiers"></div>
    <div class="total-bar" id="total-bar"></div>
  </div>

  <!-- Recent Activity -->
  <div class="card activity-panel">
    <div class="card-header">Recent Activity</div>
    <div class="commit-list" id="commit-list"></div>
  </div>
</div>

<script>
  // -- Log streaming via SSE --
  const logContainer = document.getElementById('log-container');
  const logCount = document.getElementById('log-count');
  const connStatus = document.getElementById('conn-status');
  let lineCount = 0;
  const MAX_LINES = 500;

  function startLogStream() {
    const source = new EventSource('/stream');

    source.onopen = () => {
      connStatus.textContent = 'connected';
      connStatus.className = 'connection-status connected';
    };

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const div = document.createElement('div');
      div.className = 'log-line ' + data.level;
      div.textContent = data.line;
      logContainer.appendChild(div);
      lineCount++;

      // Trim old lines to prevent memory bloat
      while (logContainer.children.length > MAX_LINES) {
        logContainer.removeChild(logContainer.firstChild);
      }

      logCount.textContent = lineCount + ' lines';

      // Auto-scroll if near bottom
      const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 80;
      if (atBottom) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    };

    source.onerror = () => {
      connStatus.textContent = 'disconnected';
      connStatus.className = 'connection-status disconnected';
    };
  }

  // -- Poll status + queue every 5s --
  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      // Service badge
      const badge = document.getElementById('service-badge');
      const stateEl = document.getElementById('service-state');
      if (data.service.running) {
        badge.className = 'status-badge running';
        stateEl.textContent = 'Running';
      } else {
        badge.className = 'status-badge stopped';
        stateEl.textContent = data.service.state || 'Stopped';
      }

      // Queue tiers
      renderQueue(data.queue);

      // Commits
      renderCommits(data.commits);
    } catch (e) {
      console.error('Status fetch failed:', e);
    }
  }

  function renderQueue(q) {
    const container = document.getElementById('queue-tiers');
    const totalBar = document.getElementById('total-bar');
    let html = '';

    for (const [tier, stats] of Object.entries(q.tiers || {})) {
      const pct = stats.total > 0 ? Math.round((stats.generated / stats.total) * 100) : 0;
      html += `
        <div class="tier-row tier-${tier}">
          <div class="tier-label">
            <span class="name">Tier ${tier}</span>
            <span class="count">${stats.generated} / ${stats.total}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${pct}%"></div>
          </div>
          <div class="tier-detail">
            <span>${pct}% complete</span>
            <span>${stats.pending} pending</span>
            ${stats.error > 0 ? `<span style="color:#f47067">${stats.error} errors</span>` : ''}
          </div>
        </div>`;
    }
    container.innerHTML = html;

    // Total
    const totalPct = q.total > 0 ? Math.round((q.total_generated / q.total) * 100) : 0;
    totalBar.innerHTML = `
      <div class="tier-label">
        <span class="name">Total</span>
        <span class="count">${q.total_generated} / ${q.total}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${totalPct}%"></div>
      </div>`;
  }

  function renderCommits(commits) {
    const container = document.getElementById('commit-list');
    if (!commits || commits.length === 0) {
      container.innerHTML = '<div style="padding:16px;color:#484f58">No recent commits</div>';
      return;
    }
    container.innerHTML = commits.map(c => `
      <div class="commit-row">
        <span class="commit-hash">${c.hash}</span>
        <span class="commit-msg">${c.message}</span>
        <span class="commit-time">${c.time}</span>
      </div>`).join('');
  }

  // Start everything
  startLogStream();
  refreshStatus();
  setInterval(refreshStatus, 5000);
</script>

</body>
</html>
"""

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"Dashboard starting on http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
