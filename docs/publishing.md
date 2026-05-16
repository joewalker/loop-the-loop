# Publishing

Before publishing, update the package version in `package.json`, then run:

```sh
pnpm format
pnpm tsc
pnpm test
pnpm lint
pnpm pack --dry-run
```

`pnpm pack --dry-run` runs the package build through `prepack` and prints the files that would be published.

Publish from a clean worktree:

```sh
pnpm publish
```
