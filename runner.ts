import { spawn } from "child_process";
import http from "http";

const PORT = Number(process.env.PORT) || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Memecoin Monitor is running\n");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Health server on port ${PORT}`);
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
