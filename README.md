<div align="center"><a name="readme-top"></a>

<img src="https://github.com/WolfStarBot.png" width="15%" alt="Starly Logo">

# Starly

Your favourite Discord bot for Twitch stream notifications, part of WolfStar
Network.<br/>

[WolfStar Official Site][official-site] · [Support Server][discord-link] ·
[Feedback][github-issues-link]

<!-- SHIELD GROUP -->

[![][github-release-shield]][github-release-link]
[![][github-releasedate-shield]][github-releasedate-link]<br/>
[![][discord-shield]][discord-link]
[![][github-contributors-shield]][github-contributors-link]<br/>
[![][github-forks-shield]][github-forks-link]
[![][github-stars-shield]][github-stars-link]
[![][github-issues-shield]][github-issues-link]
[![][github-license-shield]][github-license-link]<br>
[![][pr-welcome-shield]][pr-welcome-link]

**Share Starly Repository**

[![][share-linkedin-shield]][share-linkedin-link]
[![][share-reddit-shield]][share-reddit-link]
[![][share-telegram-shield]][share-telegram-link]
[![][share-whatsapp-shield]][share-whatsapp-link]
[![][share-x-shield]][share-x-link]

<sup>Twitch stream notifications for your Discord server. Built for the WolfStar
Network.</sup>

</div>

<details>
<summary><kbd>Table of contents</kbd></summary>

#### TOC

- [👋🏻 Welcome to Starly](#-welcome-to-starly)
- [✨ Features](#-features)
- [🚀 Self-Hosting Starly Requirements](#-self-hosting-starly-requirements)
- [🛳 Self-Hosting Starly](#-self-hosting-starly)
- [🉑 Translating Starly](#-translating-starly)
- [⌨️ Local Development](#️-local-development)
- [💻 Online Development](#-online-development)
- [🤝 Contributing](#-contributing)
- [❤️ Sponsor](#️-sponsor)

<br/>

</details>

<div id="-welcome-to-starly">

## 👋🏻 Welcome to Starly

Starly is a Discord notification bot built with TypeScript that integrates with
Twitch EventSub to provide stream status notifications. It uses HTTP
interactions via Discord's HTTP-based bot architecture rather than a persistent
WebSocket connection.

</div>

<div id="-features">

## ✨ Features

- **Twitch Stream Notifications**: Receive real-time notifications in your
  Discord channels when Twitch streamers go online or offline.
- **EventSub Integration**: Uses Twitch EventSub webhooks for reliable,
  low-latency stream event delivery.
- **HTTP-Based Architecture**: Built on `@skyra/http-framework` (Fastify-based),
  handling Discord interactions via HTTP endpoints instead of a WebSocket
  gateway.
- **Custom Messages**: Configure custom notification messages per guild
  subscription.
- **Multi-Language Support**: Internationalization via
  `@skyra/http-framework-i18n` with support for multiple locales.
- **Rate Limiting**: Built-in notification drip control to prevent spam using
  `@sapphire/ratelimits`.

</div>

<div id="-self-hosting-starly-requirements">

## 🚀 Self-Hosting Starly Requirements

- **Node.js**: Starly is built on Node.js (v22+), so you will need to have
  Node.js installed.
- **PostgreSQL**: Starly uses PostgreSQL as its database via Prisma ORM.
- **Redis**: Starly uses Redis for caching.
- **Twitch Application**: A Twitch application with client ID and secret for
  EventSub integration.
- **Discord Bot Application**: A Discord bot application configured for HTTP
  interactions.

</div>

<div id="-self-hosting-starly">

## 🛳 Self-Hosting Starly

The developer team does not support the idea of other self-hosted instances of
Starly. The team prides itself on providing the best experience and support for
the end-users. As such, an offshoot or unaffiliated mirror of Starly may cause
ill effects on the reputation and image of the WolfStar Network. If you wish to
see new features implemented, please refer to the developing guidelines linked
above.

In addition, Starly was built with a dependence on many services which need
consistent maintenance and oversight in order to function and behave properly.
These include, but are not limited to:

- **PostgreSQL**: As database for guild subscriptions and Twitch subscription
  mappings.
- **Redis**: For caching and state management.
- **Twitch EventSub**: Requires a publicly accessible HTTPS endpoint for webhook
  delivery.
- Other external APIs, each requiring their own individual API keys.

</div>

<div id="-translating-starly">

## 🉑 Translating Starly <a href="https://translation.wolfstar.rocks" target="_blank"><img src="https://support.crowdin.com/assets/logos/crowdin-core-logo.png" align="right" width="30%"></a>

We use **Crowdin** to translate Starly's messages into different languages. If
you'd like to help by contributing new translations or improving existing ones,
[**click here**](https://translation.wolfstar.rocks). Thanks for any
contributions!

</div>

<div id="️-local-development">

## ⌨️ Local Development

Refer to [CONTRIBUTING.md][set-up - refer to contributing.md] for detailed setup
instructions.

</div>

<div id="-online-development" align="right">

## 💻 Online Development

Click any of the buttons below to start a new development environment to demo or
contribute to the codebase without having to install anything on your machine:

[![Open in VS Code](https://img.shields.io/badge/Open%20in-VS%20Code-blue?logo=visualstudiocode)](https://vscode.dev/github/wolfstar-project/staryl)
[![Open in GitHub1s](https://img.shields.io/badge/Open%20in-GitHub1s-blue?logo=github)](https://github1s.com/wolfstar-project/staryl)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/wolfstar-project/staryl)
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/wolfstar-project/staryl)
[![Edit in Codesandbox](https://codesandbox.io/static/img/play-codesandbox.svg)](https://codesandbox.io/s/github/wolfstar-project/staryl)
[![Open in Codeanywhere](https://codeanywhere.com/img/open-in-codeanywhere-btn.svg)](https://app.codeanywhere.com/#https://github.com/wolfstar-project/staryl)
[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/wolfstar-project/staryl)

</div>

<div id="️-contributing">

## 🤝 Contributing

Thank you to all the people who already contributed to Starly!

<a href="https://github.com/wolfstar-project/staryl/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=wolfstar-project/staryl" />
</a>

</div>

<div id="️-sponsor">

## ❤️ Sponsor

If you like Starly and want to support the project, consider making a donation.
Every contribution helps to maintain and improve the bot.

[![Support on Ko-fi](https://img.shields.io/badge/Support%20on%20Ko--fi-ff5e5b?style=for-the-badge&logo=ko-fi&logoColor=white)][ko-fi-link]
[![Support on Patreon](https://img.shields.io/badge/Support%20on%20Patreon-F96854?style=for-the-badge&logo=patreon&logoColor=white)][patreon-link]
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20on%20GitHub-ffcb47?style=for-the-badge&logo=github&logoColor=white)][github-sponsor-link]

Thank you for your support!

</div>

<!-- LINK GROUP -->

---

<div align="right">

[![][back-to-top]](#readme-top)

</div>

---

<summary><h4>📝 License</h4>

Copyright © 2024 [WolfStar][profile-link]. <br /> This project is
[MIT](./LICENSE) licensed.

<!-- LINK GROUP -->

[ko-fi-link]: https://ko-fi.com/redstar071
[patreon-link]: https://www.patreon.com/RedStar071
[github-sponsor-link]: https://github.com/sponsors/wolfstar-project
[back-to-top]:
  https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[discord-link]: https://discord.gg/gqAnRyUXG8
[discord-shield]:
  https://img.shields.io/discord/830481105261821952?color=5865F2&label=discord&labelColor=black&logo=discord&logoColor=white&style=flat-square
[github-contributors-link]:
  https://github.com/wolfstar-project/staryl/graphs/contributors
[github-contributors-shield]:
  https://img.shields.io/github/contributors/wolfstar-project/staryl?color=c4f042&labelColor=black&style=flat-square
[github-forks-link]: https://github.com/wolfstar-project/staryl/network/members
[github-forks-shield]:
  https://img.shields.io/github/forks/wolfstar-project/staryl?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/wolfstar-project/staryl/issues
[github-issues-shield]:
  https://img.shields.io/github/issues/wolfstar-project/staryl?color=ff80eb&labelColor=black&style=flat-square
[github-license-link]:
  https://github.com/wolfstar-project/staryl/blob/main/LICENSE
[github-license-shield]:
  https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square
[github-release-link]: https://github.com/wolfstar-project/staryl/releases
[github-release-shield]:
  https://img.shields.io/github/v/release/wolfstar-project/staryl?color=369eff&labelColor=black&logo=github&style=flat-square
[github-releasedate-link]: https://github.com/wolfstar-project/staryl/releases
[github-releasedate-shield]:
  https://img.shields.io/github/release-date/wolfstar-project/staryl?labelColor=black&style=flat-square
[github-stars-link]:
  https://github.com/wolfstar-project/staryl/network/stargazers
[github-stars-shield]:
  https://img.shields.io/github/stars/wolfstar-project/staryl?color=ffcb47&labelColor=black&style=flat-square
[official-site]: https://wolfstar.rocks
[pr-welcome-link]: https://github.com/wolfstar-project/staryl/pulls
[pr-welcome-shield]:
  https://img.shields.io/badge/🤯_pr_welcome-%E2%86%92-ffcb47?labelColor=black&style=for-the-badge
[profile-link]: https://github.com/wolfstar-project
[set-up - refer to contributing.md]:
  https://github.com/wolfstar-project/.github/blob/main/.github/CONTRIBUTING.md
[share-linkedin-link]: https://linkedin.com/feed
[share-linkedin-shield]:
  https://img.shields.io/badge/-share%20on%20linkedin-black?labelColor=black&logo=linkedin&logoColor=white&style=flat-square
[share-reddit-link]:
  https://www.reddit.com/submit?title=Check%20this%20GitHub%20repository%20out%20%F0%9F%A4%AF%20Starly%20-%20Twitch%20stream%20notifications%20for%20your%20Discord%20server.%20%23bot%20%23discord%20%23twitch&url=https%3A%2F%2Fgithub.com%2Fwolfstar-project%2Fstaryl
[share-reddit-shield]:
  https://img.shields.io/badge/-share%20on%20reddit-black?labelColor=black&logo=reddit&logoColor=white&style=flat-square
[share-telegram-link]:
  https://t.me/share/url?text=Check%20this%20GitHub%20repository%20out%20%F0%9F%A4%AF%20Starly%20-%20Twitch%20stream%20notifications%20for%20your%20Discord%20server.%20%23bot%20%23discord%20%23twitch&url=https%3A%2F%2Fgithub.com%2Fwolfstar-project%2Fstaryl
[share-telegram-shield]:
  https://img.shields.io/badge/-share%20on%20telegram-black?labelColor=black&logo=telegram&logoColor=white&style=flat-square
[share-whatsapp-link]:
  https://api.whatsapp.com/send?text=Check%20this%20GitHub%20repository%20out%20%F0%9F%A4%AF%20Starly%20-%20Twitch%20stream%20notifications%20for%20your%20Discord%20server.%20https%3A%2F%2Fgithub.com%2Fwolfstar-project%2Fstaryl%20%23bot%20%23discord%20%23twitch
[share-whatsapp-shield]:
  https://img.shields.io/badge/-share%20on%20whatsapp-black?labelColor=black&logo=whatsapp&logoColor=white&style=flat-square
[share-x-link]:
  https://x.com/intent/tweet?hashtags=bot%2Cdiscord%2Ctwitch&text=Check%20this%20GitHub%20repository%20out%20%F0%9F%A4%AF%20Starly%20-%20Twitch%20stream%20notifications%20for%20your%20Discord%20server.&url=https%3A%2F%2Fgithub.com%2Fwolfstar-project%2Fstaryl
[share-x-shield]:
  https://img.shields.io/badge/-share%20on%20x-black?labelColor=black&logo=x&logoColor=white&style=flat-square
