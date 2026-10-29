# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to
**info@latitude10.tech** (the contact in
[latitude10.tech/.well-known/security.txt](https://latitude10.tech/.well-known/security.txt)),
not in a public issue or pull request.

Include what you found, the version (or commit) affected, and the steps or a
proof of concept to reproduce it. We'll reply as soon as we can, keep you
updated while we work on a fix, and credit you in the release notes unless
you'd rather we didn't.

## Supported versions

Fixes go into the latest release. Until 1.0, that's the latest `0.x`.

## Scope

In scope: this package's code (the middleware, the MCP endpoint, in-process
dispatch, the adapters, the discovery documents, the readiness check and the
CLI). Of particular interest: anything that lets a caller reach a route,
credential or header the configuration doesn't give them, forge an
`X-Agentify-*` header, get around `Origin` checks on `/mcp`, or make
validation take more than linear time.

Out of scope: vulnerabilities in your own API's auth (Agentify forwards
credentials; your API decides), and in dependencies (report those upstream;
tell us if Agentify's use of them makes it exploitable).
