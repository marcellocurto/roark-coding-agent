# Verification

## Command
`bun run check`

## Exit Code
1

## Stdout (tail)
```

/Users/marcellocurto/.roark/workspaces/marcellocurto-roark-coding-agent/pr-94/lib/autorun/continue.test.ts
  224:7   error  Async method 'prepareCloneWorkspace' has no 'await' expression                                          @typescript-eslint/require-await
  241:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  241:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression
  243:7   error  Async method 'runner' has no 'await' expression                                                         @typescript-eslint/require-await
  249:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  249:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression

/Users/marcellocurto/.roark/workspaces/marcellocurto-roark-coding-agent/pr-94/lib/autorun/discovery.test.ts
  423:7   error  Async method 'assertCleanAutorunGit' has no 'await' expression                                          @typescript-eslint/require-await
  433:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  433:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression
  436:7   error  Async method 'assertCleanAutorunGit' has no 'await' expression                                          @typescript-eslint/require-await
  437:7   error  Async method 'prepareCloneWorkspace' has no 'await' expression                                          @typescript-eslint/require-await
  443:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  443:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression

/Users/marcellocurto/.roark/workspaces/marcellocurto-roark-coding-agent/pr-94/lib/autorun/workspace.test.ts
  101:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  101:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression
  102:5   error  Unexpected `await` of a non-Promise (non-"Thenable") value                                              @typescript-eslint/await-thenable
  102:11  error  Placing a void expression inside another expression is forbidden. Move it to its own statement instead  @typescript-eslint/no-confusing-void-expression

✖ 17 problems (17 errors, 0 warnings)


```

## Stderr (tail)
```
$ bun run typecheck && bun run lint && bun test
$ tsc --noEmit
$ eslint . --cache --cache-strategy content --cache-location .eslintcache
error: script "lint" exited with code 1
error: script "check" exited with code 1

```
