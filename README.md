# companion-module-behringer-xair-kc

KartChaser's private fork of the Midas MR / Behringer XR (XAir) Companion module, with live meter (dBFS)
feedbacks and variables. Sister module of `companion-module-behringer-x32-kc`.

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Development

```sh
corepack enable
yarn install
yarn lint
yarn dist   # builds behringer-xair-kc-<version>.tgz for import into Companion
```

Pushing a `v*` tag that matches `package.json`'s version publishes a GitHub release with the package attached.
