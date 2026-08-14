const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const { test } = require("node:test");

const { createHandler, MAX_BODY_BYTES } = require("../api/webhook");
const {
  LOOPBACK_HOST,
  PUBLIC_ORIGIN,
  createOriginServer,
  getForwardedScheme,
  hasRequiredCredentials,
  parsePort,
  startOrigin,
} = require("../server");

async function listen(server) {
  server.listen(0, LOOPBACK_HOST);
  await once(server, "listening");
  const address = server.address();
  assert.equal(address.address, LOOPBACK_HOST);
  return `http://${LOOPBACK_HOST}:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

function rawRequest(origin, { body, chunks, headers = {} }) {
  const target = new URL("/api/webhook", origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      { method: "POST", headers },
      (response) => {
        const responseChunks = [];
        response.on("data", (chunk) => responseChunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(responseChunks).toString("utf8"),
          });
        });
      }
    );
    request.on("error", reject);
    for (const chunk of chunks ?? [body]) {
      request.write(chunk);
    }
    request.end();
  });
}

test("serves a minimal loopback health endpoint", async (t) => {
  const server = createOriginServer();
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/healthz`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("adapts native Node responses and rejects unsigned webhooks", async (t) => {
  const handler = createHandler({
    channelAccessToken: "test-access-token",
    channelSecret: "test-channel-secret",
    createClient: () => ({}),
  });
  const server = createOriginServer({ handler });
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/api/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [] }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "invalid_signature",
  });
});

test("does not expose unrelated origin paths", async (t) => {
  const server = createOriginServer();
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
});

test("redirects Cloudflare HTTP requests to the fixed HTTPS origin", async (t) => {
  const server = createOriginServer();
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/api/webhook?probe=1`, {
    method: "POST",
    headers: {
      "cf-visitor": JSON.stringify({ scheme: "http" }),
      "content-type": "application/json",
      host: "attacker.invalid",
    },
    body: JSON.stringify({ events: [] }),
    redirect: "manual",
  });

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    `${PUBLIC_ORIGIN}/api/webhook?probe=1`
  );
});

test("parses only recognized forwarded schemes", () => {
  assert.equal(getForwardedScheme({ "cf-visitor": '{"scheme":"https"}' }), "https");
  assert.equal(getForwardedScheme({ "x-forwarded-proto": "HTTP" }), "http");
  assert.equal(getForwardedScheme({ "cf-visitor": "not-json" }), null);
  assert.equal(getForwardedScheme({ "x-forwarded-proto": "javascript" }), null);
});

test("preserves exact signed bytes across native HTTP chunks", async (t) => {
  const channelSecret = "test-channel-secret";
  const handler = createHandler({
    channelAccessToken: "test-access-token",
    channelSecret,
    createClient: () => ({}),
  });
  const server = createOriginServer({ handler });
  t.after(() => close(server));
  const origin = await listen(server);
  const body = Buffer.from('{\r\n  "events": [], "text": "測試🙂"\r\n}');
  const signature = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  const response = await rawRequest(origin, {
    body,
    chunks: [body.subarray(0, 13), body.subarray(13, 29), body.subarray(29)],
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-line-signature": signature,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("enforces the body limit through the native HTTP adapter", async (t) => {
  const channelSecret = "test-channel-secret";
  const handler = createHandler({
    channelAccessToken: "test-access-token",
    channelSecret,
    createClient: () => ({}),
  });
  const server = createOriginServer({ handler });
  t.after(() => close(server));
  const origin = await listen(server);
  const body = Buffer.alloc(MAX_BODY_BYTES + 1, "x");
  const signature = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  const response = await rawRequest(origin, {
    body,
    headers: {
      "content-type": "application/json",
      "x-line-signature": signature,
    },
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: "payload_too_large",
  });
});

test("validates the configured origin port", () => {
  assert.equal(parsePort(undefined), 6210);
  assert.equal(parsePort("6211"), 6211);
  assert.throws(() => parsePort("80"), /PORT/);
  assert.throws(() => parsePort("not-a-port"), /PORT/);
});

test("refuses to start the production origin without credentials", () => {
  assert.equal(hasRequiredCredentials({}), false);
  assert.equal(
    hasRequiredCredentials({
      LINE_CHANNEL_ACCESS_TOKEN: "configured",
      LINE_CHANNEL_SECRET: "configured",
    }),
    true
  );
  assert.throws(
    () => startOrigin({ environment: {}, port: 6210 }),
    /configuration is incomplete/
  );
});
