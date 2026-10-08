# braces 3.0.4 (local patch)

`micromatch/braces` 3.0.3 is the latest published release and is affected by [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (stack exhaustion on deeply nested patterns). The advisory has no patched version. [micromatch/braces#72](https://github.com/micromatch/braces/pull/72) adds a nesting limit of 100 and was closed without a release.

This directory is that patch, versioned `3.0.4` so it sits outside the vulnerable range `<=3.0.3`. The root `package.json` overrides every `braces` dependency to this copy. Ordinary glob patterns used by Tailwind and `fast-glob` stay well under the limit.
