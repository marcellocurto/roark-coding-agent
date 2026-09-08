# Repository contract

Roark is a versioned, distributable CLI package. It is not one-off automation for the current machine.

- Implement built-in behavior in this repository and include required runtime resources in the published package.
- Never make default or required behavior depend on home-directory paths, sibling repositories, or ambient machine-local skills, prompts, or extensions.
- Resolve packaged resources relative to Roark's installed module location. Do not resolve them from the invoking user's filesystem layout or assume the target repository contains Roark's own runtime resources.
- If a bundled skill references supporting files, vendor the complete skill directory and preserve required licensing and attribution.
- Update `package.json` package contents and packaging verification whenever a new runtime resource directory is added.
- Treat machine-local integrations as explicit optional configuration only. They must not silently replace or define portable defaults.

Before proposing a design, check it against global installation, CI, server, and managed-workspace execution. A design that works only in the current checkout or on the current machine is invalid.

## Effect reference

- Before writing Effect code, read `repos/effect/LLMS.md`, then inspect the relevant examples, source, and tests in `repos/effect/`.
- This is a read-only upstream reference pinned to our installed Effect version. See `repos/README.md` for its provenance and update procedure.
- Do not edit the vendored source unless explicitly updating it. Import from normal package dependencies, never from `repos/`.
- Keep the reference aligned with the Effect dependencies when upgrading. Prefer its version-specific APIs and patterns over recalled examples from other Effect versions.
- The reference supports development of Roark itself. It is excluded from Roark's checks and published package and must not become a runtime dependency.

## Proportional implementation scope

- Match the solution's scale to the actual requirement. Keep simple work simple, and execute genuinely large work at the scale needed to complete it correctly.
- Use the simplest complete architecture proportional to the requirement and repository constraints. Every changed file or new abstraction must have a concrete reason to exist.
- When asked to improve prompts or agent behavior, modify the existing specialized prompts first. Do not introduce runtime enforcement or new workflow infrastructure unless explicitly requested or demonstrably required by an existing contract.
- Proceed autonomously through broad changes when the request or repository evidence requires them, and record the rationale. Do not stop or ask for permission merely because the work is large; ask only when unresolved ambiguity would materially change behavior, contracts, data semantics, security, scope, or authority.

## Module and abstraction boundaries

- Give each module a clear responsibility. A small module with one export is useful when it handles a domain rule, cleanup, validation, an integration, or workflow coordination that callers should not need to understand. File length and export count alone do not decide where code belongs.
- Do not create a file just to forward a call, rename an operation, or wrap it in `runApplicationPromise`. Put trivial runtime conversion at the existing imperative entry point. Keep native workflow modules independent of the application runtime.
- Keep necessary integration behavior, such as cancellation, resource cleanup, or error translation, with the integration that needs it. Extract an adapter when it handles that work for callers; avoid per-operation forwarding files or collections of unrelated wrappers.
- Before removing or keeping an adapter, check who uses it and what contract it protects. Remove it if neither callers nor a required contract need it. If an old production API remains only because tests still use it, update those tests to call the native operations while checking the same behavior. Keep test fixtures in test code. Do not remove a useful internal module merely because only tests call it.
- When fixing one adapter, check for the same problem elsewhere in the affected code. Update callers and remove the old path together when the task covers them and they can move together. If compatibility requires a gradual rollout, explain when the temporary adapter can be removed. Keep useful modules even when combining files would reduce the file count.
