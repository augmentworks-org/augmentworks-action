# Vendored CLI

`augmentworks-cli-0.4.2.tgz` is the unmodified public npm tarball for [@augmentworks/cli version 0.4.2](https://www.npmjs.com/package/@augmentworks/cli/v/0.4.2). It contains the CLI, its offline packets, schemas, and demo fixtures. The Action verifies the npm SHA-512 integrity digest before extracting it into the runner’s temporary directory. It runs with the Action’s Node runtime and requires no separate CLI installation or npm download.

Linked runs require the `--ci-admission` option added in [AugmentWorks CLI PR 113](https://github.com/augmentworks-org/augmentworks-cli/pull/113). For these runs, the Action verifies and extracts `augmentworks-cli-f4097e989d68.tgz`, built from the [merged CLI commit](https://github.com/augmentworks-org/augmentworks-cli/commit/f4097e989d68f54ecbb781d19343350b761922e8). That commit still reports version `0.4.2`. Its archive has a separate SHA-512 integrity digest:

```text
sha512-eP08CQ4JEREW8fp6KSiUnAVSY6ERUar030WJf4czio8K4FU7BU8pxLUpzQCV0QFk/xfLjIXgLCuoF4Fu9fq/2Q==
```

To verify the linked package, run `bash scripts/verify-linked-cli.sh` from the Action repository. The script fetches that exact commit, installs its locked dependencies, runs the upstream build, packs it, and compares the entire uncompressed tar stream with the vendored copy. The checked-in archive was built on Linux with Node 24.22.1 and npm 11.9.0.

AugmentWorks distributes both packages under Apache-2.0. The original license and bundled dependency notices are included in each archive as `package/LICENSE` and `package/THIRD_PARTY_NOTICES.md`.

## Updating the dependency

1. Read the release notes and verify the version and provenance on npm.
2. Run `npm view @augmentworks/cli@VERSION dist.integrity` and `npm pack @augmentworks/cli@VERSION --pack-destination vendor` at the Action root, substituting the exact release version.
3. Update the filename and expected digest in `src/cli.mjs`, this notice and the version test. Remove the previous archive.
4. Test both the packaged demo and the configured-target and hosted paths before releasing the Action.
