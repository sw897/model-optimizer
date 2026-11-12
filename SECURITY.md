# Security

Version 0.4.0 is an unreleased local preparation build. No public support window is established yet. Use the latest reviewed dependency lockfile and a maintained Node.js LTS runtime.

Report vulnerabilities through the hosting platform's private vulnerability reporting feature when available. If no private reporting channel is configured, ask the maintainer for one without disclosing exploit details in a public issue. Public vulnerability reporting must be configured before the first public release; no public security address is currently advertised.

Include the affected version, operating system and architecture, Node.js version, a minimal synthetic input, reproduction commands and impact. Avoid sending production models, credentials or personal data.

Models and images are untrusted parser inputs. File closure and path validation protect output boundaries but do not sandbox native codecs. Use an isolated process or container with appropriate resource limits when processing untrusted uploads. The CLI invokes a local Basis Universal executable and decodes images through Sharp.

Run `npm run audit:dependencies` for the complete dependency tree, including development tools. Audit results describe known advisories and do not replace input validation or codec regression tests. See [third-party notices](THIRD_PARTY_NOTICES.md) for native redistribution concerns.
