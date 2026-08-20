import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(process.env.PORTAL_SITE_DIR || path.join(__dirname, "site"));
const DATA_DIR = path.resolve(process.env.PORTAL_DATA_DIR || path.join(__dirname, "data"));
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const COOKIE_NAME = "portal_admin";
const COOKIE_SECURE = process.env.PORTAL_COOKIE_SECURE !== "false";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const PASSWORD_MIN = 8;
const MAX_BODY_BYTES = 256 * 1024;
const scryptAsync = promisify(crypto.scrypt);

const DEFAULT_CONFIG = {
  title: "我的服务中心",
  subtitle: "一个入口，访问你的 NAS 与自建服务。",
  services: [
    { id: "fn", name: "飞牛 NAS", description: "文件管理与系统服务", href: "https://fn.myfu.cn:7999", icon: "storage", tone: "blue", enabled: true },
    { id: "v", name: "飞牛影视", description: "媒体库与影片播放", href: "https://v.myfu.cn:7999", icon: "play", tone: "violet", enabled: true },
    { id: "webdav", name: "WebDAV", description: "文件访问与播放器连接", href: "https://webdav.myfu.cn:7999", icon: "folder", tone: "orange", enabled: true },
    { id: "vd", name: "VideoDock", description: "视频服务与媒体工具", href: "https://vd.myfu.cn:7999", icon: "screen", tone: "green", enabled: true },
    { id: "gi", name: "GitHub 中文", description: "代码与项目浏览", href: "https://gi.myfu.cn:7999", icon: "code", tone: "slate", enabled: true },
  ],
};

const ICONS = new Set(["storage", "play", "folder", "screen", "code"]);
const TONES = new Set(["blue", "violet", "orange", "green", "slate"]);
const sessions = new Map();
const rateBuckets = new Map();
let config = structuredClone(DEFAULT_CONFIG);
let authRecord;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(value) {
  return JSON.stringify(value);
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = json(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function safeCookie(value) {
  return encodeURIComponent(value);
}

function parseCookies(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function setSessionCookie(res, token, maxAge = Math.floor(SESSION_IDLE_MS / 1000)) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${safeCookie(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function clientAddress(req) {
  return req.socket.remoteAddress || "unknown";
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.expiresAt <= now) {
    rateBuckets.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [hash, session] of sessions) {
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) sessions.delete(hash);
  }
}

function getSession(req) {
  cleanupSessions();
  const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
  if (!token || token.length < 32) return null;
  const hash = tokenHash(token);
  const session = sessions.get(hash);
  if (!session) return null;
  const now = Date.now();
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    sessions.delete(hash);
    return null;
  }
  session.idleExpiresAt = now + SESSION_IDLE_MS;
  return { token, hash, session };
}

function revokeSession(req) {
  const current = getSession(req);
  if (current) sessions.delete(current.hash);
}

function revokeAllSessions() {
  sessions.clear();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function validCsrf(req, session) {
  const token = req.headers["x-csrf-token"];
  if (typeof token !== "string" || token.length < 20) return false;
  const actual = Buffer.from(tokenHash(token), "utf8");
  const expected = Buffer.from(session.csrfHash, "utf8");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readBody(req) {
  const length = Number.parseInt(req.headers["content-length"] || "0", 10);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value, max, required = true) {
  if (typeof value !== "string") return false;
  if (!required && value === "") return true;
  return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPassword(value) {
  return typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validServiceUrl(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return false;
    if (url.hostname !== "myfu.cn" && !url.hostname.endsWith(".myfu.cn")) return false;
    return !url.port || url.port === "443" || url.port === "7999";
  } catch {
    return false;
  }
}

function validateConfig(value) {
  if (!isPlainObject(value)) throw new Error("invalid_config");
  if (!validText(value.title, 80) || !validText(value.subtitle, 160)) throw new Error("invalid_config");
  if (!Array.isArray(value.services) || value.services.length > 50) throw new Error("invalid_config");
  const ids = new Set();
  const services = value.services.map((service) => {
    if (!isPlainObject(service)) throw new Error("invalid_config");
    const allowedKeys = ["id", "name", "description", "href", "icon", "tone", "enabled"];
    if (Object.keys(service).some((key) => !allowedKeys.includes(key))) throw new Error("invalid_config");
    if (!validText(service.id, 40) || !/^[a-z0-9][a-z0-9_-]*$/u.test(service.id)) throw new Error("invalid_config");
    if (ids.has(service.id) || !validText(service.name, 60) || !validText(service.description, 160)) throw new Error("invalid_config");
    if (!validServiceUrl(service.href) || !ICONS.has(service.icon) || !TONES.has(service.tone) || typeof service.enabled !== "boolean") throw new Error("invalid_config");
    ids.add(service.id);
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      href: service.href,
      icon: service.icon,
      tone: service.tone,
      enabled: service.enabled,
    };
  });
  return { title: value.title, subtitle: value.subtitle, services };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return { version: 1, salt, hash: Buffer.from(derived).toString("hex"), N: 16384, r: 8, p: 1 };
}

async function verifyPassword(password, record) {
  if (!validPassword(password) || !record?.salt || !record?.hash) return false;
  try {
    const derived = await scryptAsync(password, record.salt, 64, { N: record.N || 16384, r: record.r || 8, p: record.p || 1, maxmem: 32 * 1024 * 1024 });
    const actual = Buffer.from(derived);
    const expected = Buffer.from(record.hash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function atomicWrite(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fsp.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${json(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
}

async function readJson(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function initialize() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const authPath = path.join(DATA_DIR, "auth.json");
  try {
    authRecord = await readJson(authPath);
    if (!authRecord?.hash || !authRecord?.salt) throw new Error("invalid_auth");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("auth_file_invalid");
    const initialPassword = process.env.PORTAL_ADMIN_PASSWORD;
    if (!validPassword(initialPassword)) throw new Error(`PORTAL_ADMIN_PASSWORD must be at least ${PASSWORD_MIN} characters on first start`);
    authRecord = await hashPassword(initialPassword);
    await atomicWrite(authPath, authRecord);
  }

  const configPath = path.join(DATA_DIR, "config.json");
  try {
    config = validateConfig(await readJson(configPath));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Portal config is invalid; using built-in defaults.");
    }
    config = clone(DEFAULT_CONFIG);
    await atomicWrite(configPath, config);
  }
}

function publicConfig() {
  return clone(config);
}

function requireAdmin(req, res) {
  const current = getSession(req);
  if (!current) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return current;
}

function requireWriteAccess(req, res) {
  const current = requireAdmin(req, res);
  if (!current) return null;
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: "origin_denied" });
    return null;
  }
  if (!validCsrf(req, current.session)) {
    sendJson(res, 403, { error: "csrf_invalid" });
    return null;
  }
  return current;
}

async function createSession(res) {
  const token = newToken(32);
  const csrfToken = newToken(24);
  const now = Date.now();
  sessions.set(tokenHash(token), {
    csrfHash: tokenHash(csrfToken),
    createdAt: now,
    idleExpiresAt: now + SESSION_IDLE_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
  });
  setSessionCookie(res, token);
  return csrfToken;
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/public/config" && req.method === "GET") {
    sendJson(res, 200, publicConfig());
    return true;
  }

  if (pathname === "/api/admin/login" && req.method === "POST") {
    if (!consumeRateLimit(`login:${clientAddress(req)}`, 10, 15 * 60 * 1000)) {
      sendJson(res, 429, { error: "too_many_attempts" }, { "Retry-After": "900" });
      return true;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: "origin_denied" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return true;
    }
    const valid = await verifyPassword(body.password, authRecord);
    if (!valid) {
      sendJson(res, 401, { error: "invalid_credentials" });
      return true;
    }
    const csrfToken = await createSession(res);
    sendJson(res, 200, { ok: true, csrfToken, config: publicConfig() });
    return true;
  }

  if (pathname === "/api/admin/session" && req.method === "GET") {
    const current = requireAdmin(req, res);
    if (!current) return true;
    const csrfToken = newToken(24);
    current.session.csrfHash = tokenHash(csrfToken);
    sendJson(res, 200, { ok: true, csrfToken, config: publicConfig() });
    return true;
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const current = requireWriteAccess(req, res);
    if (!current) return true;
    sessions.delete(current.hash);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/admin/config" && req.method === "GET") {
    const current = requireAdmin(req, res);
    if (!current) return true;
    sendJson(res, 200, publicConfig());
    return true;
  }

  if (pathname === "/api/admin/config" && req.method === "PUT") {
    const current = requireWriteAccess(req, res);
    if (!current) return true;
    if (!consumeRateLimit(`write:${clientAddress(req)}`, 60, 15 * 60 * 1000)) {
      sendJson(res, 429, { error: "too_many_attempts" }, { "Retry-After": "900" });
      return true;
    }
    try {
      const next = validateConfig(await readBody(req));
      await atomicWrite(path.join(DATA_DIR, "config.json"), next);
      config = next;
      sendJson(res, 200, publicConfig());
    } catch (error) {
      sendJson(res, error.message === "body_too_large" ? 413 : 400, { error: "invalid_config" });
    }
    return true;
  }

  if (pathname === "/api/admin/password" && req.method === "POST") {
    const current = requireWriteAccess(req, res);
    if (!current) return true;
    if (!consumeRateLimit(`password:${clientAddress(req)}`, 5, 15 * 60 * 1000)) {
      sendJson(res, 429, { error: "too_many_attempts" }, { "Retry-After": "900" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_request" });
      return true;
    }
    if (!validPassword(body.currentPassword) || !validPassword(body.newPassword) || body.newPassword !== body.confirmPassword || !(await verifyPassword(body.currentPassword, authRecord))) {
      sendJson(res, 400, { error: "password_change_failed" });
      return true;
    }
    authRecord = await hashPassword(body.newPassword);
    await atomicWrite(path.join(DATA_DIR, "auth.json"), authRecord);
    revokeAllSessions();
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  if (decoded.includes("\u0000")) {
    sendText(res, 400, "Bad request");
    return;
  }
  if (decoded === "/") decoded = "/index.html";
  if (decoded === "/admin" || decoded === "/admin/") decoded = "/admin.html";
  const target = path.resolve(SITE_DIR, `.${decoded}`);
  if (target !== SITE_DIR && !target.startsWith(`${SITE_DIR}${path.sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("not_file");
  } catch {
    sendText(res, 404, "Not found");
    return;
  }
  const extension = path.extname(target).toLowerCase();
  const headers = { "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=604800" };
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream", "Content-Length": stat.size, ...securityHeaders(), ...headers });
    res.end();
    return;
  }
  const content = await fsp.readFile(target);
  res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream", "Content-Length": content.length, ...securityHeaders(), ...headers });
  res.end(content);
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Length": 2, ...securityHeaders() });
      res.end();
    } else {
      sendText(res, 200, "ok\n");
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      if (await handleApi(req, res, url.pathname)) return;
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(`API request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
    return;
  }
  try {
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(`Static request failed: ${error.message}`);
    if (!res.headersSent) sendText(res, 500, "Internal server error");
  }
}

await initialize();
const server = http.createServer(requestHandler);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log(`Apple portal listening on ${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
