import { spawn } from "child_process";
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

function serveDashboard(req: http.IncomingMessage, res: http.ServerResponse) {
  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Memecoin Monitor is running\n");
    return;
  }

  if (urlPath === "/" || urlPath === "/dashboard" || urlPath === "/dashboard/") {
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
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  const index = path.join(DASH, "index.html");
  fs.readFile(index, (err, data) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Memecoin Monitor is running\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer(serveDashboard);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Dashboard + health on port ${PORT}`);
});

console.log("Launching experiment suite (listener + treatment engine)...\n");

const listener = spawn("npx", ["tsx", "index.ts"], { stdio: "inherit" });
const tracker = spawn("npx", ["tsx", "tracker.ts"], { stdio: "inherit" });

listener.on("close", (code) => {
  console.error(`[CRITICAL] Listener exited with code ${code}`);
});
tracker.on("close", (code) => {
  console.error(`[CRITICAL] Tracker exited with code ${code}`);
});
