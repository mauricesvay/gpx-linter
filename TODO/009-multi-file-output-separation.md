---
finding_id: 9
category: should_fix
severity: low
component: src/cli.ts
status: open
tags:
  - cli
  - output
  - ux
---

# Multi-File Summary Printed to Stderr While Findings Go to Stdout

## What this is

`runCheck` iterates over files, tracking the highest exit code. For multi-file, it prints a summary to stderr.

## Problem

The summary goes to stderr while findings go to stdout. If a user pipes stdout to a file, they get a mixed output: findings in the file, summary on the terminal. The exit code is correct, but the output separation is confusing.

## Fix

Print the multi-file summary to stdout (after all findings) or to a separate stream.

## If we skip it

Minor UX confusion. Users piping output get no summary in their file.
