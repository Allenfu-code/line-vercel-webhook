# Secure LINE Webhook on Vercel

A small LINE Messaging API webhook for Vercel Functions. It replies to text
messages and demonstrates a fail-closed webhook security flow.

## Security design

The handler reads the exact raw request body, verifies `x-line-signature` with
the LINE SDK, and only then parses JSON or calls the Messaging API. It also:

- rejects missing, invalid, or tampered signatures;
- limits request bodies to 1 MiB;
- limits batch size and outbound concurrency;
- deduplicates event IDs within a warm function instance;
- applies a five-second outbound LINE API timeout;
- requires JSON requests;
- keeps credentials and webhook payloads out of logs;
- returns generic client-facing errors; and
- sends `no-store`, restrictive CSP, and MIME-sniffing protection headers.

See [SECURITY.md](SECURITY.md) for the disclosure and credential-handling
policy.

## Local verification

Requirements: Node.js 22.

```bash
npm ci
npm test
npm audit --omit=dev
```

The test suite covers valid signatures, missing signatures, body tampering,
oversized requests, malformed JSON, generic error responses, and the health
endpoint. Tests use placeholder credentials and never call LINE.

## Deploying to Vercel

Set these as encrypted Vercel environment variables. Never commit their values.

```text
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
```

Deploy `api/webhook.js`, then use **Verify** in the LINE Developers Console.
An unsigned request must receive HTTP 401, while LINE's signed verification
request must succeed.

For production, add rate limiting at the edge and review logs without recording
message bodies, reply tokens, user IDs, or credentials.

The in-memory event-ID cache is a bounded defense against immediate duplicate
delivery, not durable cross-instance storage. A higher-volume implementation
should verify, enqueue, and acknowledge webhooks quickly, then use a durable
queue and datastore for idempotent asynchronous processing.

## References

- [LINE: Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Vercel: Raw request bodies](https://vercel.com/kb/guide/how-do-i-get-the-raw-body-of-a-serverless-function)
