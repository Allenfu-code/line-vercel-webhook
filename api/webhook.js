const getRawBody = require("raw-body");
const line = require("@line/bot-sdk");

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS = 100;
const EVENT_CONCURRENCY = 4;
const MAX_REPLY_CHARACTERS = 5000;
const EVENT_ID_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_IDS = 2048;

function createEventDeduper(now = Date.now) {
  const seen = new Map();

  return function isDuplicate(eventId) {
    if (typeof eventId !== "string" || eventId.length === 0) {
      return false;
    }

    const current = now();
    for (const [id, timestamp] of seen) {
      if (current - timestamp <= EVENT_ID_TTL_MS) {
        break;
      }
      seen.delete(id);
    }

    if (seen.has(eventId)) {
      return true;
    }

    seen.set(eventId, current);
    while (seen.size > MAX_EVENT_IDS) {
      seen.delete(seen.keys().next().value);
    }
    return false;
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, consume));
}

function replyText(input) {
  return Array.from(`收到：${input}`).slice(0, MAX_REPLY_CHARACTERS).join("");
}

function applySecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function createHandler(options = {}) {
  const channelAccessToken =
    options.channelAccessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = options.channelSecret ?? process.env.LINE_CHANNEL_SECRET;
  const createClient =
    options.createClient ?? ((config) => new line.Client(config));
  const isDuplicateEvent =
    options.isDuplicateEvent ?? createEventDeduper(options.now);

  return async function webhook(req, res) {
    applySecurityHeaders(res);

    if (req.method === "GET") {
      return res.status(200).send("OK");
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    if (!channelAccessToken || !channelSecret) {
      return res.status(503).json({ ok: false, error: "service_unavailable" });
    }

    const signature = req.headers["x-line-signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const contentType = req.headers["content-type"];
    const mediaType =
      typeof contentType === "string"
        ? contentType.split(";", 1)[0].trim().toLowerCase()
        : "";
    if (mediaType !== "application/json") {
      return res.status(415).json({ ok: false, error: "unsupported_media_type" });
    }

    let rawBody;
    try {
      rawBody = await getRawBody(req, {
        length: req.headers["content-length"],
        limit: MAX_BODY_BYTES,
        encoding: false,
      });
    } catch (error) {
      const status = error?.type === "entity.too.large" ? 413 : 400;
      return res.status(status).json({
        ok: false,
        error: status === 413 ? "payload_too_large" : "invalid_body",
      });
    }

    if (!line.validateSignature(rawBody, channelSecret, signature)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }

    if (!Array.isArray(body.events)) {
      return res.status(400).json({ ok: false, error: "invalid_payload" });
    }
    if (body.events.length > MAX_EVENTS) {
      return res.status(400).json({ ok: false, error: "too_many_events" });
    }

    let client;
    try {
      client = createClient({ channelAccessToken, channelSecret });
    } catch {
      console.error("LINE webhook client initialization failed");
      return res.status(500).json({ ok: false, error: "internal_error" });
    }

    let failures = 0;
    await runWithConcurrency(
      body.events,
      EVENT_CONCURRENCY,
      async (event) => {
        if (
          event?.mode === "standby" ||
          event?.type !== "message" ||
          event.message?.type !== "text" ||
          typeof event.message.text !== "string" ||
          typeof event.replyToken !== "string" ||
          event.replyToken.length === 0 ||
          isDuplicateEvent(event.webhookEventId)
        ) {
          return;
        }

        try {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: replyText(event.message.text),
          });
        } catch {
          failures += 1;
        }
      }
    );

    if (failures > 0) {
      console.error("LINE webhook event processing completed with failures");
    }
    return res.status(200).json({ ok: true });
  };
}

const handler = createHandler();

module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.MAX_EVENTS = MAX_EVENTS;
module.exports.EVENT_CONCURRENCY = EVENT_CONCURRENCY;
module.exports.MAX_REPLY_CHARACTERS = MAX_REPLY_CHARACTERS;
