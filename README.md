# mend

One command-line tool that applies the edits AI models write, in four formats, to a tree of text files. Node 22, standard library only. Run as `node main.ts [options] [PATCH]` with the working directory as the root of the tree.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`SPEC.md` (in the kit) is the whole contract. The four formats are unified diffs (with wrong line numbers tolerated), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. Edits are found at the first of three matching tiers — exact, trailing whitespace ignored, then leading and trailing whitespace ignored (with re-indentation) — and either every edit is applied or none is, so a failed patch changes nothing. `--check` reports what would change without writing; `--strict` matches exactly.

## Files

- `main.ts`: the CLI.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts the exit code, stdout and files.
- `check.ts`: the practice set on your own machine (`node check.ts <practice.json>`). Practice score: 1000 (100 of 100 checks).
- `LICENSE`: MIT.

## A check

One run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. Standard error is never compared. Each run has 10 seconds.
