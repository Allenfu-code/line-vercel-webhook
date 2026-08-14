const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { Readable } = require("node:stream");
const { test } = require("node:test");

const {
  createHandler,
  EVENT_CONCURRENCY,
  MAX_BODY_BYTES,
  MAX_EVENTS,
  MAX_REPLY_CHARACTERS,
} = require("../api/webhook");

const CHANNEL_SECRET = "test-channel-secret";
const CHANNEL_ACCESS_TOKEN = "test-access-token";

function sign(body) {
  return createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");
}

function request(body = "", overrides = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const chunks = overrides.chunks ?? (raw.length ? [raw] : []);
  const req = Readable.from(chunks);
  req.method = overrides.method || "POST";
  req.headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(raw.length),
    "x-line-signature": sign(raw),
    ...overrides.headers,
  };
  if (overrides.omitContentLength) {
    delete req.headers["content-length"];
  }
  return req;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function handlerWith(client) {
  return createHandler({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
    createClient: () => client,
  });
}

function textEvent(overrides = {}) {
  return {
    type: "message",
    mode: "active",
    webhookEventId: "01H810YECXQQZ37VAXPF6H9E6T",
    replyToken: "reply-token",
    message: { type: "text", text: "hello" },
    ...overrides,
  };
}

test("accepts a correctly signed webhook and replies to text messages", async () => {
  const calls = [];
  const handler = handlerWith({
    replyMessage: async (...args) => calls.push(args),
  });
  const body = JSON.stringify({ events: [textEvent()] });
  const res = response();

  await handler(request(body), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls, [
    ["reply-token", { type: "text", text: "收到：hello" }],
  ]);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("rejects a missing signature before processing events", async () => {
  let clientCreated = false;
  const handler = createHandler({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
    createClient: () => {
      clientCreated = true;
      return {};
    },
  });
  const body = JSON.stringify({ events: [] });
  const res = response();

  await handler(
    request(body, { headers: { "x-line-signature": undefined } }),
    res
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: "invalid_signature" });
  assert.equal(clientCreated, false);
});

test("rejects a valid signature when the raw body is changed", async () => {
  const original = JSON.stringify({ events: [] });
  const tampered = JSON.stringify({ events: [{ type: "follow" }] });
  const res = response();

  await handlerWith({})(
    request(tampered, {
      headers: { "x-line-signature": sign(original) },
    }),
    res
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: "invalid_signature" });
});

test("rejects an oversized body", async () => {
  const body = "x".repeat(MAX_BODY_BYTES + 1);
  const res = response();

  await handlerWith({})(request(body), res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { ok: false, error: "payload_too_large" });
});

test("rejects malformed JSON after signature verification", async () => {
  const body = "{not-json";
  const res = response();

  await handlerWith({})(request(body), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_json" });
});

test("rejects a signed non-object payload", async () => {
  const body = "null";
  const res = response();

  await handlerWith({})(request(body), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_payload" });
});

test("isolates event failures and does not expose or log error details", async () => {
  const handler = handlerWith({
    replyMessage: async () => {
      throw new Error("secret upstream response");
    },
  });
  const body = JSON.stringify({ events: [textEvent()] });
  const res = response();
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    await handler(request(body), res);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(logs, [
    ["LINE webhook event processing completed with failures"],
  ]);
  assert.equal(JSON.stringify(logs).includes("secret upstream response"), false);
});

test("rejects JSON-like media types", async () => {
  const body = JSON.stringify({ events: [] });
  const res = response();

  await handlerWith({})(
    request(body, { headers: { "content-type": "application/jsonp" } }),
    res
  );

  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.body, { ok: false, error: "unsupported_media_type" });
});

test("preserves exact multi-chunk UTF-8 bytes without Content-Length", async () => {
  const raw = Buffer.from('{\r\n  "events": [], "text": "測試🙂"\r\n}');
  const res = response();

  await handlerWith({})(
    request(raw, {
      chunks: [raw.subarray(0, 17), raw.subarray(17, 31), raw.subarray(31)],
      omitContentLength: true,
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("limits the number of events in one signed payload", async () => {
  const body = JSON.stringify({ events: Array(MAX_EVENTS + 1).fill({}) });
  const res = response();

  await handlerWith({})(request(body), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "too_many_events" });
});

test("deduplicates webhookEventId within a warm function instance", async () => {
  let replies = 0;
  const handler = handlerWith({
    replyMessage: async () => {
      replies += 1;
    },
  });
  const body = JSON.stringify({ events: [textEvent()] });

  await handler(request(body), response());
  await handler(request(body), response());

  assert.equal(replies, 1);
});

test("bounds outbound concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const handler = handlerWith({
    replyMessage: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    },
  });
  const events = Array.from({ length: EVENT_CONCURRENCY * 2 }, (_, index) =>
    textEvent({
      webhookEventId: `event-${index}`,
      replyToken: `reply-${index}`,
    })
  );
  const body = JSON.stringify({ events });

  await handler(request(body), response());

  assert.equal(maxActive, EVENT_CONCURRENCY);
});

test("truncates replies to the LINE text limit", async () => {
  let reply;
  const handler = handlerWith({
    replyMessage: async (_token, message) => {
      reply = message.text;
    },
  });
  const body = JSON.stringify({
    events: [textEvent({ message: { type: "text", text: "a".repeat(6000) } })],
  });

  await handler(request(body), response());

  assert.equal(Array.from(reply).length, MAX_REPLY_CHARACTERS);
  assert.equal(reply.startsWith("收到："), true);
});

test("returns a minimal health response for GET", async () => {
  const handler = createHandler();
  const res = response();

  await handler(request("", { method: "GET" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  assert.equal(res.headers["strict-transport-security"], "max-age=31536000");
});
