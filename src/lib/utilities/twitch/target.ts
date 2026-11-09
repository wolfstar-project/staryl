const TwitchLoginPattern =
	/^(?:(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/)?(\w{3,25})\/?$/i;

export function parseTwitchLogin(input: string): string | null {
	return TwitchLoginPattern.exec(input.trim())?.[1]?.toLowerCase() ?? null;
}
