"use strict";

const http = require("node:http");

const webhookHandler = require("./api/webhook");

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 6210;
const PUBLIC_ORIGIN = "https://line-webhook.allenfuhome.com";

function applyOriginSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'"
  );
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
  return res;
}

function adaptResponse(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (payload) => sendJson(res, res.statusCode, payload);
  res.send = (payload) => {
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end(payload);
    return res;
  };
  return res;
}

function parsePort(value = process.env.PORT) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("PORT must be an integer between 1024 and 65535");
  }
  return port;
}

function hasRequiredCredentials(environment = process.env) {
  return Boolean(
    environment.LINE_CHANNEL_ACCESS_TOKEN && environment.LINE_CHANNEL_SECRET
  );
}

function getForwardedScheme(headers) {
  const visitor = headers["cf-visitor"];
  if (typeof visitor === "string") {
    try {
      const scheme = JSON.parse(visitor).scheme;
      if (scheme === "http" || scheme === "https") {
        return scheme;
      }
    } catch {
      return null;
    }
  }

  const forwardedProto = headers["x-forwarded-proto"];
  if (typeof forwardedProto !== "string") {
    return null;
  }
  const scheme = forwardedProto.trim().toLowerCase();
  return scheme === "http" || scheme === "https" ? scheme : null;
}

function createOriginServer(options = {}) {
  const handler = options.handler ?? webhookHandler;
  const server = http.createServer(
    { connectionsCheckingInterval: 1_000 },
    async (req, res) => {
      applyOriginSecurityHeaders(res);

      let requestUrl;
      try {
        requestUrl = new URL(req.url || "/", "http://origin.invalid");
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid_request" });
      }

      if (getForwardedScheme(req.headers) === "http") {
        const redirectUrl = new URL(PUBLIC_ORIGIN);
        redirectUrl.pathname = requestUrl.pathname;
        redirectUrl.search = requestUrl.search;
        res.statusCode = 308;
        res.setHeader("Location", redirectUrl.toString());
        res.end();
        return res;
      }

      const { pathname } = requestUrl;

      if (req.method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (pathname !== "/api/webhook") {
        return sendJson(res, 404, { ok: false, error: "not_found" });
      }

      adaptResponse(res);
      try {
        return await handler(req, res);
      } catch {
        console.error("LINE webhook origin request failed");
        if (res.headersSent) {
          res.destroy();
          return undefined;
        }
        return sendJson(res, 500, { ok: false, error: "internal_error" });
      }
    }
  );

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  return server;
}

function startOrigin(options = {}) {
  if (
    options.requireCredentials !== false &&
    !hasRequiredCredentials(options.environment)
  ) {
    throw new Error("LINE webhook origin configuration is incomplete");
  }
  const port = options.port ?? parsePort();
  const server = createOriginServer(options);
  server.listen(port, LOOPBACK_HOST, () => {
    console.log(`LINE webhook origin listening on ${LOOPBACK_HOST}:${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (require.main === module) {
  startOrigin();
}

module.exports = {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  PUBLIC_ORIGIN,
  createOriginServer,
  getForwardedScheme,
  hasRequiredCredentials,
  parsePort,
  startOrigin,
};
