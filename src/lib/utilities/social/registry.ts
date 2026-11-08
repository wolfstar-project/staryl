import type { SocialProviderName } from "#lib/setup/prisma";
import type { SocialProvider } from "#social/provider";
import { socialDelivery } from "#social/notifications";
import { SocialPoller } from "#social/poller";
import { createBlueskyProvider } from "#social/providers/bluesky";
import { createMastodonProvider } from "#social/providers/mastodon";
import { createRedditProvider } from "#social/providers/reddit";
import { createRssProvider } from "#social/providers/rss";
import {
	createTwitchClipsProvider,
	createTwitchVideosProvider,
} from "#social/providers/twitch";
import { createXProvider } from "#social/providers/x";
import { createYouTubeProvider } from "#social/providers/youtube";
import { createSocialStore } from "#social/store";
import { container } from "@wolfstar/http-framework";

/** Every integration. Adding one here is what exposes it to `/subscriptions social add`. */
export const SocialProviders: readonly SocialProvider[] = [
	createRssProvider(),
	createRedditProvider(),
	createBlueskyProvider(),
	createMastodonProvider(),
	createYouTubeProvider(),
	createTwitchVideosProvider(),
	createTwitchClipsProvider(),
	createXProvider(),
];

export function getSocialProvider(name: SocialProviderName) {
	return SocialProviders.find((provider) => provider.name === name);
}

export function startSocialPoller() {
	const poller = new SocialPoller({
		providers: SocialProviders,
		store: createSocialStore(container.prisma),
		delivery: socialDelivery,
		logger: container.logger,
	});
	poller.start();
	return poller;
}
