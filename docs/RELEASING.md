# Release process

AiArk uses Semantic Versioning. Releases in the `0.x` line are marked as GitHub pre-releases because the public interfaces and storage schema may still evolve.

## Automated release

1. Merge a pull request into `main` with a clean CI run.
2. Update `CHANGELOG.md` and the `version` in `package.json` and `package-lock.json`.
3. Create an annotated tag matching the package version exactly:

   ```bash
   git tag -a v0.2.0 -m "AiArk v0.2.0"
   git push origin v0.2.0
   ```

4. The Release workflow validates the tag and runs the complete test suite.
5. Native jobs build Windows x64, macOS arm64, macOS x64, and Linux x64 packages.
6. The publish job creates `SHA256SUMS.txt`, records build-provenance attestations, generates release notes, and uploads the files to GitHub Releases.

The workflow can be rerun manually for an existing tag. Existing release assets are replaced with artifacts rebuilt from that exact tag.

## Required release assets

- Windows x64 NSIS installer;
- Windows x64 portable executable;
- macOS arm64 DMG and ZIP;
- macOS x64 DMG and ZIP;
- Linux x64 AppImage and Debian package;
- `SHA256SUMS.txt`.

## Verification

Before announcing a release:

1. confirm every matrix job is green;
2. confirm the release is attached to the expected commit;
3. inspect the asset list for missing or duplicate names;
4. verify `sha256sum -c SHA256SUMS.txt` on downloaded assets;
5. launch at least one package on each supported operating system;
6. verify scanning and dry-run behavior with no disk writes;
7. record signing/notarization status in the release notes.

Do not move or recreate a published tag. If a release contains a defect, publish a new patch version.
