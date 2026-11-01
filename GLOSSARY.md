# Glossary

Canonical vocabulary for Staryl. Every user-visible string, command name, doc
heading and exported name uses these terms.

## Map

| Term                | Table / code                            | Cardinality                                    | Customer word     |
| ------------------- | --------------------------------------- | ---------------------------------------------- | ----------------- |
| Social Provider     | `SocialProvider`, `#social/providers/*` | 1 per integration, listed in `SocialProviders` | "provider"        |
| Target              | `social_source.target`                  | Source 1—1 Target (unique with the provider)   | "target"          |
| Source              | `social_source`                         | Provider 1—N Source                            | "feed or account" |
| Subscription        | `guild_social_subscription`             | Source 1—N Subscription, per guild and channel | "subscription"    |
| Item                | `SocialItem`, not stored                | Source 1—N Item, ids kept on each Subscription | "item"            |
| Twitch Subscription | `twitch_subscriptions`                  | Streamer and type 1—1 row (unique)             | "subscription"    |
| Guild Subscription  | `guild_subscription`                    | Twitch Subscription 1—N Guild Subscription     | "subscription"    |

Collisions

- "subscription": a Twitch Subscription mirrors an EventSub subscription on
  Twitch's side, a Guild Subscription and a Subscription are what a server set
  up. Members only ever see the last two.

## Terms

### Social Provider

**Is:** one integration with an outside service, implementing `SocialProvider`.
**Use for:** code, docs and the `provider` option of
`/subscriptions social add`. **Never:** integration, connector, plugin (the last
one means a framework plugin here). **Casing:** `Social Provider` in prose,
`SocialProvider` in code, `provider` in commands.

### Target

**Is:** what a member typed, resolved to its canonical form: a feed URL, a
handle, a channel id. **Use for:** the `target` option and
`SocialSource.target`. **Never:** handle, url, identifier, as a generic name for
it. **Casing:** `target` everywhere.

### Source

**Is:** one followed feed or account, checked once however many servers follow
it. **Use for:** `SocialSource`, the `source` command option. **Never:** feed
(as a generic name), account (as a generic name), channel (that is Discord's).
**Casing:** `Source` in prose, `source` in identifiers.

### Subscription

**Is:** one Discord channel following one Source, with its own filters and
message. **Use for:** `GuildSocialSubscription` and the commands under
`/subscriptions`. **Never:** follow, link, watch (as nouns). **Casing:**
`Subscription` in prose, `subscription` in identifiers.

### Item

**Is:** one post, video or article a Source published. **Use for:**
`SocialItem`, deduplication, filters. **Never:** post, entry, content, as the
generic name. A provider may say "post" or "video" in its own copy. **Casing:**
`Item` in prose, `item` in identifiers.

## Banned

| Never       | Use instead                  | Why                                             |
| ----------- | ---------------------------- | ----------------------------------------------- |
| integration | Social Provider              | The issues use it, the code settled on provider |
| dashboard   | `/subscriptions social show` | Staryl has no dashboard, only slash commands    |

## Open questions

Naming calls this file does not settle. Resolve one, fold the answer in, delete
the entry.

1. **Should "provider" stay a word members see?** Discord shows it as an option
   name on `/subscriptions social add`.
   - Keep it, it matches the code and needs no mapping.
   - Rename the option to `platform`, friendlier, but one more word to keep in
     sync.
