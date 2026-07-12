# Repository contract

Roark is a versioned, distributable CLI package. It is not one-off automation for the current machine.

- Implement built-in behavior in this repository and include required runtime resources in the published package.
- Never make default or required behavior depend on home-directory paths, sibling repositories, or ambient machine-local skills, prompts, or extensions.
- Resolve packaged resources relative to Roark's installed module location. Do not resolve them from the invoking user's filesystem layout or assume the target repository contains Roark's own runtime resources.
- If a bundled skill references supporting files, vendor the complete skill directory and preserve required licensing and attribution.
- Update `package.json` package contents and packaging verification whenever a new runtime resource directory is added.
- Treat machine-local integrations as explicit optional configuration only. They must not silently replace or define portable defaults.

Before proposing a design, check it against global installation, CI, server, and managed-workspace execution. A design that works only in the current checkout or on the current machine is invalid.
