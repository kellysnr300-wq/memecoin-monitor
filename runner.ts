import { spawn, ChildProcess } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";

const PORT = Number(process.env.PORT) || 10000;
const DASH = path.join(process.cwd(), "dashboard");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serveDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  let urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Memecoin Monitor is running\n");
    return;
  }

  if (
    urlPath === "/" ||
    urlPath === "/dashboard" ||
    urlPath === "/dashboard/"
  ) {
    urlPath = "/dashboard/index.html";
  }

  if (urlPath.startsWith("/dashboard/")) {
    const rel = urlPath.replace(/^\/dashboard\//, "");
    const file = path.normalize(path.join(DASH, rel));

    if (!file.startsWith(DASH)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(file);

      res.writeHead(200, {
        "Content-Type":
          MIME[ext] || "application/octet-stream",
      });

      res.end(data);
    });

    return;
  }

  const index = path.join(DASH, "index.html");

  fs.readFile(index, (err, data) => {
    if (err) {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Memecoin Monitor is running\n");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
    });

    res.end(data);
  });
}

const server = http.createServer(serveDashboard);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Dashboard + health on port ${PORT}`);
});

console.log(
  "Launching experiment suite (listener + treatment engine)..."
);

let shuttingDown = false;

function startWorker(name: string, file: string) {
  if (shuttingDown) return;

  console.log(`[WORKER] Starting ${name}: ${file}`);

  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", file],
    {
      stdio: "inherit",
      env: process.env,
    }
  );

  child.on("error", (err) => {
    console.error(
      `[WORKER] ${name} process error:`,
      err.message
    );
  });

  child.on("close", (code, signal) => {
    if (shuttingDown) return;

    console.error(
      `[WORKER] ${name} exited`,
      `code=${code}`,
      `signal=${signal || "none"}`
    );

    console.log(
      `[WORKER] Restarting ${name} in 3 seconds...`
    );

    setTimeout(() => {
      startWorker(name, file);
    }, 3000);
  });

  return child;
}

const listener = startWorker("Telegram listener", "index.ts");
const tracker = startWorker("Treatment tracker", "tracker.ts");

function shutdown(signal: string) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`[RUNNER] ${signal} received. Shutting down...`);

  for (const child of [listener, tracker]) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
