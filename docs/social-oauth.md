# Owner-connected social accounts

Instagram uses the Instagram API with Instagram Login, not Basic Display or a
scraper. Only the owner of a professional business/creator account can authorize
it; arbitrary public accounts and consumer accounts cannot be followed.
Configure the Meta app's Instagram Login and approved `instagram_business_basic`
permission. Register the exact HTTPS `INSTAGRAM_REDIRECT_URI` (the bot's
`/social/instagram/callback` route).

A server manager runs `/subscriptions social connect` with a provider and
destination. The private reply contains a ten-minute authorization link. The
callback checks their current Manage Server permission, exchanges the code
server-side and baselines the account before linking it. Use
`/subscriptions social show` for connection health, `test` for a preview and
`remove` to stop delivery. Reconnect to repair a revoked grant. Use `add` on the
returned guild-scoped target to set keyword filters or link another channel in
the same server. The account cannot be linked from a different server.

Set a stable `SOCIAL_TOKEN_KEY` to 32 random bytes encoded as 64 hexadecimal
characters. Tokens are AES-256-GCM encrypted in `SocialConnection`; protect and
back up that key. Losing it requires reconnection. Credentials are never stored
in poller JSON or replies. Schema changes require `pnpm prisma:generate` and
`pnpm exec prisma db push`.

Instagram long-lived tokens are refreshed seven days before their returned
expiry (normally 60 days). Revocation, expiry and API failure go through the
existing source health/backoff and do not stop other providers. Removing a
Discord subscription stops checks; remove the app in Instagram to revoke its
grant as well. Stored connections are retained to allow reconnection and can be
removed by the operator.

Reference:
https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/
