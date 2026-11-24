# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adelbudi88-crypto/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adelbudi88-crypto/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads each one exactly as
`SPEC.md` says, finds the lines the model meant even when its whitespace and indentation
drifted, and changes every file or nothing at all.

## Run it

Node 22, standard library only, nothing to install:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it
  is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, no file created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## What it does

- **Matching in three tiers** — exact, then trailing whitespace ignored, then both ends
  ignored with re-indentation from the file's own leading whitespace. A context line is
  always written as the file's own matched line, never the patch's.
- **Unified diffs** — wrong line numbers are forgiven: a hunk takes the occurrence nearest
  to its `@@` line, adjusted for earlier hunks; empty hunks insert; `\ No newline at end of
  file` controls the final line break; creates, deletes and moves are handled, and a move
  prints as `R <old> -> <new>`.
- **SEARCH/REPLACE blocks** — the path is the nearest line before the block; a block whose
  old lines occur twice is `ambiguous`.
- **V4A patches** — anchors, a cursor that moves past each chunk, and `*** End of File`
  chunks that must end at the file's last line.
- **JSON edits** — one array or JSON Lines; `create`, `str_replace` (exact, overlapping
  occurrences counted) and `insert`, with CRLF files round-tripped.
- **All or nothing** — edits apply in order to the tree as earlier edits left it; a failed
  edit changes nothing and the edits after it still run, so every failure is reported; when
  any edit failed, no file is written.

## Output and exit codes

- Exit 0: one line per changed path (`A`/`D`/`M`, or `R <old> -> <new>` for a move), then
  `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`.
- Exit 2: exactly one line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` with the patch line number.

## Files

- `main.ts` — the CLI, a fresh implementation of `SPEC.md`.
- `runner.ts` — the kit's runner, kept as it is; in a trial it reads the checks from the
  environment and runs `main.ts` on each one.

## Verification

- Practice set (100 checks, `program/generator/practice.json` in the kit): **100/100**.
- A further 157 hand-written edge checks, one per sentence of `SPEC.md` (CRLF vs LF,
  `--check`, `--strict`, usage errors, ambiguous/no-match, unsafe paths, empty-O inserts,
  nearest-hunk selection, `\ No newline`, re-indentation, V4A anchors/cursor/end-of-file,
  moves, JSON Lines faults, overlapping `str_replace`, `insert_line` bounds, stdin patches,
  the `--` separator): **157/157**.
