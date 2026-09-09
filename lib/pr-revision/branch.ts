import { Effect, Schema } from "effect";
import { type PullRequestMetadata } from "../github/pr.ts";
const unsafeHeadBranchNames = new Set([
  "main",
  "master",
  "develop",
  "development",
  "trunk",
  "release",
]);
export const validatePrBranchSafety = Effect.fnUntraced(function* (
  pr: PullRequestMetadata,
  repo: string,
) {
  if (pr.state !== "OPEN")
    return yield* new PrBranchError({
      message: `PR #${pr.number} must be open. Current state: ${pr.state}.`,
    });
  if (!pr.headRefName.trim())
    return yield* new PrBranchError({
      message: `PR #${pr.number} has an empty head branch name.`,
    });
  if (!pr.baseRefName.trim())
    return yield* new PrBranchError({
      message: `PR #${pr.number} has an empty base branch name.`,
    });
  if (pr.headRefName === pr.baseRefName) {
    return yield* new PrBranchError({
      message: `Refusing to revise PR #${pr.number}: head branch '${pr.headRefName}' matches base branch.`,
    });
  }
  if (unsafeHeadBranchNames.has(pr.headRefName)) {
    return yield* new PrBranchError({
      message: `Refusing to revise PR #${pr.number}: '${pr.headRefName}' is an unsafe shared/base branch name.`,
    });
  }
  if (pr.headRepository && pr.headRepository !== repo) {
    return yield* new PrBranchError({
      message: `PR #${pr.number} uses fork head repository '${pr.headRepository}'. Fork PR revision checkout/push is unsupported in v1.`,
    });
  }
  if (pr.baseRepository && pr.baseRepository !== repo) {
    return yield* new PrBranchError({
      message: `PR #${pr.number} base repository '${pr.baseRepository}' does not match target repo '${repo}'.`,
    });
  }
});
export class PrBranchError extends Schema.TaggedError<PrBranchError>()(
  "PrBranchError",
  { message: Schema.String },
) {}
