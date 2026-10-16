const crypto = require("node:crypto");


const parseCookies = (header) => {
  const raw = typeof header === "string" ? header : "";
  if (!raw.trim()) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
};

/** Constant-time string comparison to prevent timing attacks. */
const safeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

const LOGIN_PATH = "/__studio-login";
const MAX_LOGIN_BODY = 4096;

/** Verify a password against "scrypt:<saltHex>:<hashHex>" (Node/Python scrypt defaults N=16384,r=8,p=1). */
const verifyPassword = (password, stored) => {
  const [scheme, saltHex, hashHex] = String(stored).split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== 32) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

/** Only same-site absolute paths are valid post-login redirects. */
const safeNextPath = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/";

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Simple in-memory rate limiter for auth attempts. */
const createRateLimiter = (maxAttempts = 10, windowMs = 60_000) => {
  const attempts = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now - entry.start > windowMs) attempts.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    isLimited(ip) {
      const entry = attempts.get(ip);
      if (!entry) return false;
      return entry.count >= maxAttempts;
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now - entry.start > windowMs) {
        attempts.set(ip, { count: 1, start: now });
        return;
      }
      entry.count++;
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
};

/**
 * Resolve client IP for rate limiting.
 * When TRUSTED_PROXY=1 is set, the first value of X-Forwarded-For is used.
 * Only set TRUSTED_PROXY=1 when this server sits behind a reverse proxy that
 * you control (nginx, Caddy, Vercel edge). Without it, X-Forwarded-For is
 * ignored to prevent spoofing by direct clients.
 */
const resolveClientIp = (req) => {
  if (process.env.TRUSTED_PROXY === "1") {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || "unknown";
};

function createAccessGate(options) {
  const token = String(options?.token ?? "").trim();
  const cookieName = String(options?.cookieName ?? "studio_access").trim() || "studio_access";

  const enabled = Boolean(token);
  const rateLimiter = createRateLimiter(10, 60_000);
  // Optional username/password login (password stored as "scrypt:<saltHex>:<hashHex>").
  const loginUser = String(options?.loginUser ?? "").trim();
  const loginPasswordHash = String(options?.loginPasswordHash ?? "").trim();
  const loginEnabled = Boolean(loginUser && loginPasswordHash);

  const getAuthState = (req) => {
    if (!enabled) return { authorized: true, limited: false };
    const ip = resolveClientIp(req);
    const cookieHeader = req.headers?.cookie;
    const cookies = parseCookies(cookieHeader);
    const authorized = safeCompare(cookies[cookieName] || "", token);
    if (authorized) {
      rateLimiter.reset(ip);
      return { authorized: true, limited: false };
    }
    if (rateLimiter.isLimited(ip)) {
      return { authorized: false, limited: true };
    }
    rateLimiter.recordFailure(ip);
    return { authorized: false, limited: rateLimiter.isLimited(ip) };
  };

  // Login via ?token=... (bookmarkable URL or the login form): set the cookie, redirect to a clean URL.
  const tryTokenLogin = (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const supplied = url.searchParams.get("token");
    if (supplied === null || url.pathname.startsWith("/api/")) return false;
    if (!safeCompare(supplied, token)) return false; // failure already counted by getAuthState
    rateLimiter.reset(resolveClientIp(req));
    url.searchParams.delete("token");
    res.statusCode = 303;
    setSessionCookie(res);
    res.setHeader("Location", url.pathname + url.search);
    res.end();
    return true;
  };

  const setSessionCookie = (res) => {
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
    );
  };

  const sendLoginPage = (res, statusCode, message, next) => {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const field = "padding:8px;font:inherit";
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claw3D login</title>` +
        `<form method="post" action="${LOGIN_PATH}" style="font:16px system-ui,sans-serif;max-width:320px;margin:20vh auto;padding:0 16px;display:grid;gap:10px">` +
        `<strong>${message}</strong>` +
        `<input type="hidden" name="next" value="${escapeHtml(next)}">` +
        `<label for="username">Username</label>` +
        `<input id="username" name="username" autocomplete="username" required autofocus style="${field}">` +
        `<label for="password">Password</label>` +
        `<input id="password" name="password" type="password" autocomplete="current-password" required style="${field}">` +
        `<button style="${field}">Sign in</button></form>`
    );
  };

  const handleLoginPost = (req, res) => {
    const ip = resolveClientIp(req);
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      body += chunk;
      if (body.length > MAX_LOGIN_BODY) {
        aborted = true;
        res.statusCode = 413;
        res.end("Login request too large.");
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      const form = new URLSearchParams(body);
      const next = safeNextPath(form.get("next"));
      if (rateLimiter.isLimited(ip)) {
        sendLoginPage(res, 429, "Too many failed attempts. Wait a minute and retry.", next);
        return;
      }
      // Evaluate both checks so a wrong username costs the same as a wrong password.
      const userOk = safeCompare(form.get("username") ?? "", loginUser);
      const passwordOk = verifyPassword(form.get("password") ?? "", loginPasswordHash);
      if (!userOk || !passwordOk) {
        rateLimiter.recordFailure(ip);
        sendLoginPage(res, 401, "Invalid username or password.", next);
        return;
      }
      rateLimiter.reset(ip);
      setSessionCookie(res);
      res.statusCode = 303;
      res.setHeader("Location", next);
      res.end();
    });
  };

  const handleHttp = (req, res) => {
    if (!enabled) return false;
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (loginEnabled && req.method === "POST" && requestUrl.pathname === LOGIN_PATH) {
      handleLoginPost(req, res);
      return true;
    }
    const auth = getAuthState(req);
    if (!auth.authorized && !auth.limited && tryTokenLogin(req, res)) return true;
    if (!auth.authorized) {
      const statusCode = auth.limited ? 429 : 401;
      if (String(req.url || "/").startsWith("/api/")) {
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: auth.limited
              ? "Too many failed studio access attempts. Wait a minute and retry."
              : "Studio access token required. Send the configured Studio access cookie and retry.",
          })
        );
      } else if (loginEnabled) {
        requestUrl.searchParams.delete("token");
        sendLoginPage(
          res,
          statusCode,
          auth.limited ? "Too many failed attempts. Wait a minute and retry." : "Sign in to Claw3D",
          requestUrl.pathname + requestUrl.search
        );
      } else {
        const message = auth.limited
          ? "Too many failed attempts. Wait a minute and retry."
          : new URL(req.url || "/", "http://localhost").searchParams.has("token")
            ? "Invalid access token."
            : "Enter the studio access token.";
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claw3D login</title>` +
            `<form method="get" style="font:16px system-ui,sans-serif;max-width:320px;margin:20vh auto;padding:0 16px;display:grid;gap:10px">` +
            `<label for="token">${message}</label>` +
            `<input id="token" name="token" type="password" autocomplete="current-password" required autofocus style="padding:8px;font:inherit">` +
            `<button style="padding:8px;font:inherit">Enter</button></form>`
        );
      }
      return true;
    }
    return false;
  };

  const allowUpgrade = (req) => {
    if (!enabled) return true;
    return getAuthState(req).authorized;
  };

  return { enabled, handleHttp, allowUpgrade };
}

module.exports = { createAccessGate };
