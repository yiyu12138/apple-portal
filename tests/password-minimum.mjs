import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(projectDir, "server.mjs");

test("accepts an eight-character administrator password on first start", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "apple-portal-password-"));
  const port = 20000 + Math.floor(Math.random() * 10000);
  let server;

  try {
    server = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PORTAL_ADMIN_PASSWORD: "aa112211",
        PORTAL_DATA_DIR: dataDir,
        PORTAL_COOKIE_SECURE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5_000);
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}: ${output}`));
      });
      server.stdout.on("data", () => {
        if (output.includes("Apple portal listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok\n");
  } finally {
    if (server && server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("admin interface accepts and describes eight-character passwords", async () => {
  const [html, script] = await Promise.all([
    readFile(path.join(projectDir, "site", "admin.html"), "utf8"),
    readFile(path.join(projectDir, "site", "admin.js"), "utf8"),
  ]);

  assert.equal((html.match(/minlength="8"/g) || []).length, 4);
  assert.match(html, /至少 8 个字符。/);
  assert.match(script, /newPassword\.length < 8/);
  assert.match(script, /新密码至少需要 8 个字符。/);
});
