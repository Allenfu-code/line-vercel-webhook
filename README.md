# Secure LINE Webhook Reference

A standalone LINE Messaging API webhook reference for a Cloudflare
Tunnel-backed WSL service. It replies to text messages and demonstrates a
fail-closed webhook security flow.

## Verification status

The implementation is offline-verified by 23 tests, and its production
dependency audit currently reports no known vulnerabilities. This repository
is a reference service and test harness; it is **not** the active origin for my
current LINE bot. The live hostname terminates at Hermes Gateway's separately
configured LINE adapter, so this README does not claim a production deployment
that cannot be reproduced from this repository alone.

## Reference deployment architecture

```text
LINE Messaging API
        |
        | HTTPS + x-line-signature
        v
Cloudflare edge -> dedicated Tunnel -> 127.0.0.1:6210 -> Node.js handler
                                              |
                                              +-> LINE reply API
```

Only the exact webhook path is published. The origin and health endpoint stay
on loopback, while credentials live in a permission-restricted runtime file
outside the repository.

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

## Cloudflare deployment pattern

A LINE endpoint must be public because the platform cannot complete an
interactive login. Requests are authenticated with the LINE signature before
the payload is parsed or processed.

```text
https://your-line-subdomain.example/api/webhook
```

`npm start` runs the origin on `127.0.0.1:6210`; it must remain loopback-only
behind its dedicated Cloudflare Tunnel. It refuses to start unless both LINE
credentials are configured. Store them outside the repository in the private
systemd environment file `~/.config/line-webhook/line-webhook.env` with mode
`0600`:

```text
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
```

On the WSL host, enter them without terminal echo or shell-history exposure:

```bash
./scripts/configure-secrets.sh
```

Do not paste either value into an issue, pull request, chat, command argument,
or deployment log.

The origin exposes `GET /healthz` for local infrastructure checks and supports
both `GET` and `POST` on `/api/webhook`. The Tunnel publishes only the webhook
path; health and all unrelated paths remain private.

After deployment, use **Verify** in the LINE Developers Console. An unsigned
request must receive HTTP 401, while LINE's signed verification request must
succeed.

For production, add rate limiting at the edge and review logs without recording
message bodies, reply tokens, user IDs, or credentials.

The in-memory event-ID cache is a bounded defense against immediate duplicate
delivery, not durable cross-instance storage. A higher-volume implementation
should verify, enqueue, and acknowledge webhooks quickly, then use a durable
queue and datastore for idempotent asynchronous processing.

## References

- [LINE: Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

## License

This project is available under the [MIT License](LICENSE).
