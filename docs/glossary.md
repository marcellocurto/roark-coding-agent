---
title: Glossary
summary: Definitions for common Roark terms.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Agent Phase

A workflow step that calls the Pi coding-agent SDK, such as planning, implementation, review, or fix.

## Artifact

A durable file written under `.roark/runs` that records workflow input, output, decisions, validation, or status.

## Attempt

One run of Roark for one issue. Attempts are numbered and stored under `.roark/runs/issue/<issue>/attempts/<attempt>/`.

## Autorun

The one-shot label-gated workflow invoked by `roark auto`.

## Control Checkout

The local repository checkout where `roark` is invoked and where `.roark/config.json` and `.roark/runs` live.

## Draft Pull Request

The PR Roark opens after readiness and verification pass. Roark leaves it as draft for human review.

## Fix Pass

An iteration where Roark applies reviewer findings after implementation and then reruns review.

## Issue Branch

The Git branch used for one issue, normally `roark/issue-<number>`.

## Managed Workspace

An isolated clone where Roark runs the agent and verification away from the control checkout.

## Readiness Gate

The gate that checks `readiness.md` for `ready-for-pr`.

## Revision

A Roark run against an existing pull request through `roark revise-pr`.

## Skip Label

A GitHub label that prevents `roark auto` from selecting an issue.

## Verification Gate

The gate that runs the configured shell command and requires exit code `0`.

## Workflow Skill

A Roark-resolved skill used for a controlled workflow path, such as `github-issue-create`, without falling back to ambient global Pi skills.
