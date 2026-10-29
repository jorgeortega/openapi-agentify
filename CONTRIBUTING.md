# Contributing

Thanks for helping. Bug reports, fixes, docs and new framework adapters are all
welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree
  on the approach.
- Security problems: don't open an issue; see [SECURITY.md](SECURITY.md).
- By contributing you agree that your contribution is licensed under the
  [MIT License](LICENSE), and you follow the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22.13 or newer.

```bash
git clone https://github.com/jorgeortega/openapi-agentify
cd openapi-agentify
npm install
npm run build       # dist/ (the Next.js example and the e2e test use it)
npm run typecheck
npm test
```

`AGENTIFY_NEXT_E2E=1 npm test` also runs the Next.js example under a real
`next build` and `next start` (slow).

Run the example API on any framework: `npm run demo:hono` (or `demo:express`,
`demo:fastify`, `demo:next`), then open `http://localhost:3000/agent`.

## Pull requests

- One logical change per pull request, with a test that fails without it.
- Keep the public API stable: `docs/extending.md` is a contract other packages
  build on. If a change alters a hook, say so in the pull request.
- Behaviour that differs between frameworks needs a test on all four
  (`test/helpers.ts` has `FRAMEWORKS` and `start()`).
- The readiness rules are scored against `test/fixtures/readiness`; a rule
  change updates those fixtures in the same pull request.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased".
- Commit messages: a short imperative subject (`fix: …`, `feat: …`, `docs: …`).

## Code style

TypeScript, strict, ES modules, two-space indentation, semicolons, double
quotes. Comments say why, not what.
