import { spawn } from "child_process";

console.log("🚀 Launching MemeCoin Monitoring Suite...\n");

// Start Telegram Listener
const listener = spawn("npx", ["tsx", "index.ts"], { stdio: "inherit" });

// Start Performance Tracker
const tracker = spawn("npx", ["tsx", "tracker.ts"], { stdio: "inherit" });

listener.on("close", (code) => {
  console.error(`[CRITICAL] Listener exited with code ${code}`);
});

tracker.on("close", (code) => {
  console.error(`[CRITICAL] Tracker exited with code ${code}`);
});

