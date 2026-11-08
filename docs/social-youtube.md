# YouTube notifications

Configure `YOUTUBE_API_KEY`, `YOUTUBE_WEBSUB_SECRET` and the public HTTPS
`YOUTUBE_WEBSUB_CALLBACK` (`/youtube/websub`). Add a channel ID or handle with
`/subscriptions social add`. The baseline is saved before asking the hub to
verify the source. Pushes are signature checked and only wake the shared poller;
the feed plus Data API v3 supply the notification data.

Scheduled checks maintain WebSub leases and do not read videos. Requests ask for
24 hours at most, store the hub's actual grant, and renew with one hour to
spare. An unconfirmed subscription is retried on the next maintenance check. Hub
failures appear in source health; there is no polling fallback.

Public Data API v3 does not identify Shorts. The `shorts` filter approximates
this with videos up to three minutes, so it can include short landscape videos.
It is not a guarantee of YouTube's Shorts classification. Keywords apply to the
Data API title and description. Removed/non-public videos are not delivered.
