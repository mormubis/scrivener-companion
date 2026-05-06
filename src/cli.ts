import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { paths, ensureDirs } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!fs.existsSync(paths.pid)) return null;
  const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function cleanStaleFiles(): void {
  if (fs.existsSync(paths.pid)) fs.unlinkSync(paths.pid);
  if (fs.existsSync(paths.sock)) fs.unlinkSync(paths.sock);
}

function healthCheck(): Promise<{ status: string; state: string } | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: paths.sock, path: "/health", method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(`already running (PID ${existingPid})`);
    process.exit(1);
  }

  // Clean up stale files from previous crash
  cleanStaleFiles();
  ensureDirs();

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();
  console.log(`started (PID ${child.pid})`);
  process.exit(0);
}

async function stop(): Promise<void> {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    cleanStaleFiles();
    console.log("not running");
    process.exit(0);
  }

  process.kill(pid, "SIGTERM");
  const exited = await waitForExit(pid, 10000);

  if (!exited) {
    console.error(`PID ${pid} did not exit in 10s, sending SIGKILL`);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 5000);
  }

  cleanStaleFiles();
  console.log("stopped");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

async function status(): Promise<void> {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    console.log("stopped");
    process.exit(0);
  }

  const health = await healthCheck();
  if (health) {
    console.log(`running (${health.state})`);
  } else {
    console.log("running (starting)");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === "--serve") {
  // Daemon mode — import and run the server
  import("./server.js");
} else if (command === "start") {
  start();
} else if (command === "stop") {
  stop();
} else if (command === "restart") {
  restart();
} else if (command === "status") {
  status();
} else {
  console.error("usage: scrivener-companion <start|stop|restart|status>");
  process.exit(1);
}
