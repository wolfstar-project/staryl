import type { Nullish } from "@sapphire/utilities";
import { isNullishOrEmpty } from "@sapphire/utilities";

// oxlint-disable-next-line regexp/no-dupe-disjunctions
export const anyMentionRegExp = /<(#[!&]?|#)(\d{17,19})>/g;
export const hereOrEveryoneMentionRegExp = /#(?:here|everyone)/;
/**
 * Extracts mentions from a body of text.
 * #remark Preserves the mentions in the content, if you want to remove them use `cleanMentions`.
 * #param input The input to extract mentions from.
 */
export function extractDetailedMentions(
  input: string | Nullish,
): DetailedMentionExtractionResult {
  const users = new Set<string>();
  const roles = new Set<string>();
  const channels = new Set<string>();
  const parse = [] as MessageMentionTypes[];

  if (isNullishOrEmpty(input)) {
    return { users, roles, channels, parse };
  }

  let result: RegExpExecArray | null;
  // oxlint-disable-next-line no-cond-assign
  while ((result = anyMentionRegExp.exec(input)) !== null) {
    switch (result[1]) {
      case "#":
        channels.add(result[2]);
        continue;
      case "#!": {
        users.add(result[2]);
        continue;
      }
      case "#&": {
        roles.add(result[2]);
        continue;
      }
    }
  }

  if (hereOrEveryoneMentionRegExp.test(input)) parse.push("everyone");

  return { users, roles, channels, parse };
}

export interface DetailedMentionExtractionResult {
  users: ReadonlySet<string>;
  roles: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  parse: MessageMentionTypes[];
}

type MessageMentionTypes = "users" | "roles" | "everyone";
