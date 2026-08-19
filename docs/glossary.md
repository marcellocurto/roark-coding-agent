---
title: Glossary
summary: Definitions for common Roark terms.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-08-19T07:58:25Z
---

## Agent phase

A workflow step that calls the Pi coding-agent SDK, such as planning, implementation, review, or fix.

## Artifact

A durable file written under `.roark/runs` that records workflow input, output, decisions, validation, or status.

## Attempt

One run of Roark for one issue. Attempts are numbered and stored under `.roark/runs/issue/<issue>/attempts/<attempt>/`.

## Autorun

The one-shot label-gated workflow invoked by `roark auto`.

## Control checkout

The local repository checkout where `roark` is invoked and where `.roark/config.json` and `.roark/runs` live.

## Pull request

The PR Roark opens after readiness and verification pass.

## Fix pass

An iteration where Roark applies reviewer findings after implementation and then reruns review.

## Issue branch

The Git branch used for one issue, normally `roark/issue-<number>`.

## Invocation

One execution of the Roark CLI, from command start until Roark returns control to its caller, regardless of the command or outcome.

## Managed workspace

An isolated clone where Roark runs the agent and verification away from the control checkout.

## Readiness gate

The gate that checks whether `readiness.json` has `"status": "ready-for-pr"`.

## PR review generation

One immutable local `review-pr` result under `review-<n>`, covering a pinned PR head without changing it.

## Revision

A mutation-authorized Roark run that addresses existing pull-request feedback through `roark revise-pr`.

## Skip label

A GitHub label that prevents `roark auto` from selecting an issue.

## Verification gate

The gate that runs the configured shell command and requires exit code `0`.
