# Guild API

The guild API lets another service read and change the notifications of one
server. The WolfStar.rocks dashboard is its first caller: its Social module
lists, adds and removes subscriptions through these routes, and never reads
Staryl's database.

The routes are on the plugin API port (`API_PORT`), next to the Twitch and
YouTube webhooks.

## Credential

Set `GUILD_API_SECRET`. A caller sends it on every request:

```http
Authorization: Bearer <GUILD_API_SECRET>
```

- If the variable is not set, every route answers `503 guild-api-disabled`.
- If the token is missing or wrong, the route answers `401 unauthorized`.
- The secret is the only credential. Its holder acts for every server. The
  caller must check that its member may manage the server before it calls.
- A caller can name the member it acts for in `x-actor-id` (a Discord user id).
  Staryl writes the id in its log and trusts it for nothing.

## Routes

`:guild`, `:channel` are Discord ids. `:source` is the `sourceId` of a
subscription.

| Method   | Path                                            | Does                                       |
| -------- | ----------------------------------------------- | ------------------------------------------ |
| `GET`    | `/guilds/:guild/notifications`                  | Reads the state of the server              |
| `PATCH`  | `/guilds/:guild/notifications`                  | Turns the server's notifications on or off |
| `POST`   | `/guilds/:guild/subscriptions`                  | Adds a subscription                        |
| `DELETE` | `/guilds/:guild/subscriptions/:channel/:source` | Removes a subscription                     |

### State

`GET /guilds/:guild/notifications` answers:

```jsonc
{
	"installed": true, // Staryl is a member of the server
	"enabled": true, // the switch of the server's notifications
	"limits": {
		"subscriptions": 25,
		"xAccounts": 2,
		"messageLength": 200,
		"targetLength": 500,
	},
	"providers": [{ "name": "Rss", "configured": true, "manageable": true }],
	"subscriptions": [
		{
			"provider": "Rss",
			"sourceId": "5",
			"channelId": "800000000000000001",
			"displayName": "Example feed",
			"target": "https://example.com/feed.xml", // the canonical form of what is followed
			"message": null,
			"filters": ["includeKeywords"], // the filters that are not at their default
			"health": "active", // active, failing, rateLimited, targetUnavailable, authFailed, unavailable
			"deliveryError": null, // GuildUnavailable, ChannelNotFound, MissingPermissions, SendFailed
			"manageable": true,
			"createdAt": "2026-11-01T10:00:00.000Z",
			"lastCheckedAt": "2026-11-02T10:00:00.000Z",
		},
	],
	"twitch": [
		{
			"streamerId": "123",
			"streamerName": "CoolStreamer", // null when Twitch does not answer
			"channelId": "800000000000000001",
			"type": "StreamOnline",
			"message": "Live!",
			"revoked": false,
		},
	],
}
```

- `installed` is `false` only when Discord answers 403 or 404 for the server. A
  Discord outage does not read as "Staryl was removed".
- `health` is the value `/subscriptions <provider> show` reports. `unavailable`
  means the provider's credentials are not configured.
- `twitch` lists the Twitch live subscriptions. The guild API does not change
  them.

### Switch

`PATCH /guilds/:guild/notifications` takes `{ "enabled": false }` and answers
`{ "enabled": false, "previous": true }`. `previous` is the value before the
request, so a caller can tell a change from a repeat.

The switch is `guild.notifications_enabled`. A server without a row is on.

- Off stops every notification of the server: the poller posts nothing for its
  subscriptions, and the Twitch listeners skip it.
- Off deletes nothing. The subscriptions, their filters and their messages stay.
- While the switch is off, the poller counts new items as seen. When the switch
  goes back on, the server gets only what is published after that.
- `/settings` shows a line when the switch is off. The commands still work, so a
  member can prepare subscriptions while the notifications are off.

### Add

`POST /guilds/:guild/subscriptions` takes:

```json
{
	"provider": "Rss",
	"target": "https://example.com/feed.xml",
	"channelId": "800000000000000001",
	"message": "New post!"
}
```

It runs the same code as `/subscriptions <provider> add`, without filters. It
answers `201` with `{ "subscription", "subscriptions" }`: the new subscription,
and the server's full list.

The route checks the channel first: it must be a text or announcement channel of
the server, and Staryl must have View Channel, Send Messages and Embed Links
there.

### Remove

`DELETE /guilds/:guild/subscriptions/:channel/:source` answers `200` with
`{ "removed", "subscriptions" }`: the subscription it removed, and the list the
server has left.

## Not manageable providers

Instagram and TikTok follow an account its owner connected. The connection
starts from a link that only `/subscriptions <provider> connect` gives. The
guild API lists their subscriptions with `"manageable": false` and answers
`422 provider-not-manageable` to an add or a remove.

## Errors

Every error is `{ "error": "<code>" }`. The caller owns the sentence it shows
for a code.

| Status | Code                      | Means                                                    |
| ------ | ------------------------- | -------------------------------------------------------- |
| 400    | `invalid-guild`           | `:guild` is not a Discord id                             |
| 400    | `invalid-body`            | The body has the wrong shape, or a field is over a limit |
| 400    | `invalid-subscription`    | `:channel` or `:source` is not an id                     |
| 401    | `unauthorized`            | The token is missing or wrong                            |
| 404    | `subscription-not-found`  | The server has no such subscription                      |
| 409    | `duplicate`               | The channel already follows the target                   |
| 409    | `guild-unavailable`       | Staryl cannot read the server. It is probably not in it  |
| 422    | `channel-not-found`       | The channel is not in the server                         |
| 422    | `channel-not-supported`   | The channel is not a text or announcement channel        |
| 422    | `missing-permissions`     | Staryl cannot post in the channel                        |
| 422    | `provider-not-configured` | Staryl has no credentials for the provider               |
| 422    | `provider-not-manageable` | The provider needs a connected account                   |
| 422    | `limit-reached`           | The server has its maximum of subscriptions              |
| 422    | `x-limit-reached`         | The server has its maximum of X accounts                 |
| 422    | `target-invalid`          | The target is not something the provider can read        |
| 422    | `target-not-found`        | The provider has no such account or feed                 |
| 422    | `target-blocked`          | The target is not allowed                                |
| 422    | `target-unsupported`      | The provider cannot follow this kind of target           |
| 422    | `target-unreachable`      | The provider did not answer. Try again later             |
| 500    | `database`                | Staryl could not read or write its database              |
| 503    | `guild-api-disabled`      | `GUILD_API_SECRET` is not set                            |

## Adding a route

- Put it under `src/routes/guilds/[guild]/`. Start `run()` with
  `authorizeGuildRequest(request, response)` and return when it answers `null`.
- Give the file a name no other route file has. A piece is stored under its file
  name, and a second route with the same name unloads the first.
- Answer an error with `response.error(status, code)`, and add the code to the
  table above.
- Keep the logic in `#social/*` or `#twitch/*`, where the commands already call
  it. A route only checks its input, calls that code and maps the result.
