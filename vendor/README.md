# Vendored CLI

`augmentworks-cli-0.4.2.tgz` is the unmodified public npm tarball for [@augmentworks/cli version 0.4.2](https://www.npmjs.com/package/@augmentworks/cli/v/0.4.2). It contains the CLI, its offline packets, schemas, and demo fixtures. The Action verifies the npm SHA-512 integrity digest before extracting it into the runner’s temporary directory. It runs with the Action’s Node runtime and requires no separate CLI installation or npm download.

AugmentWorks distributes the CLI under Apache-2.0. The original license and bundled dependency notices are included in the archive as `package/LICENSE` and `package/THIRD_PARTY_NOTICES.md`.

## Updating the dependency

1. Read the release notes and verify the version and provenance on npm.
2. Run `npm view @augmentworks/cli@VERSION dist.integrity` and `npm pack @augmentworks/cli@VERSION --pack-destination vendor` at the Action root, substituting the exact release version.
3. Update the filename and expected digest in `src/cli.mjs`, this notice and the version test. Remove the previous archive.
4. Test both the packaged demo and the configured-target and hosted paths before releasing the Action.
