# Releasing

For maintainers. Back to the [README](../README.md).

For maintainers. Releases are published by GitHub Actions (`.github/workflows/release.yml`) when a version tag is pushed: no npm token is stored anywhere, and the package carries provenance (which commit and workflow built it).

1. Move the CHANGELOG's *Unreleased* notes under `## X.Y.Z (date)` with a one-line intro, and bump `version` in every `package.json` (and the lockfile: `npm install --package-lock-only`).
2. Check the package locally:

   ```bash
   npm run release
   ```

   ```bash
   node scripts/smoke-package.mjs
   ```

3. Commit "Release X.Y.Z", tag it, and push both:

   ```bash
   git tag vX.Y.Z
   ```

   ```bash
   git push origin main vX.Y.Z
   ```

The workflow then:
- checks that the tag matches every `package.json` and that the CHANGELOG has the section;
- runs the tests, then builds and test-installs the package;
- publishes it to npm, installs it back from npm and runs it;
- creates the GitHub release with that CHANGELOG section as its notes.

Running it again for the same tag skips what's already done. CI runs step 2 on every push too.

**Once**: on npmjs.com, the package's *Settings → Trusted publishing* must name GitHub Actions with this repository and the workflow file `release.yml`. Without it the publish step fails with a 404; set it up and re-run the job.

To publish by hand instead: `npm publish ./release` after `npm login`, then `node scripts/smoke-package.mjs --from-npm`, then `gh release create vX.Y.Z --notes "$(node scripts/release-notes.mjs X.Y.Z)"`.
