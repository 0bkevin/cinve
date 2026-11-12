# Contributing

By participating, you agree to the [code of conduct](CODE_OF_CONDUCT.md). For
large changes, open an issue first. For vulnerabilities, follow
[`SECURITY.md`](SECURITY.md).

## Set up

Requires Node.js 22 or later and a local PostgreSQL (`initdb` and `pg_ctl`), or
a disposable database in `TEST_DATABASE_URL`. Never use a production database.

```sh
npm ci
npm run check
npm test
npm run build
```

`npm run smoke` queries the real cinemas; it's optional.

[`AGENTS.md`](AGENTS.md) maps where each part of the code lives and the rules
every change must follow. `test/` mirrors `src/`: for example,
`test/http/client.test.ts` tests `src/http/client.ts`, and
`test/providers/cinex-venues.test.ts` tests `src/providers/cinex/venues.ts`.

## Pull requests

- One problem per pull request, with tests if behavior changes.
- Update the documentation if the public interface changes.
- Explain what it solves and how you tested it; add a screenshot if the website
  changes.
- Don't include passwords, cookies, tokens or personal data, including in
  fixtures.

## Cinema adapter changes

- Distinguish an empty response from a failure.
- Validate IDs, amounts and links before returning them.
- Mark as `partial` anything you can't interpret with certainty.
- Never present an unknown seat as free.
- Test both the normal and the degraded case.

By contributing, you agree to license your code under the [MIT license](LICENSE).
