# Security policy

Do not commit LINE credentials or production webhook payloads. Store
`LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` only in a private systemd
environment file outside the repository.

All webhook requests must pass `x-line-signature` validation against the exact
raw request body before JSON parsing or event processing. Keep request and
response bodies, access tokens, channel secrets, reply tokens, and user IDs out
of logs.

If a credential is exposed, revoke or rotate it in the LINE Developers Console
before removing it from Git history or other stored records.
