# HOL Guard `before_tool` adapter packet

Status: owned-fork implementation and tests prepared. This is not an upstream integration or a release artifact.

## Why this maps cleanly

Klaat Code sends a JSON object to `before_tool` hooks. For a `run_command` call, the relevant fields are:

- `event`: `before_tool`
- `project_root`: current project root
- `tool_name`: `run_command`
- `tool_args`: the raw JSON argument string passed to the tool

Klaat Code blocks a tool call when the hook exits with status `2` or writes a JSON object such as:

```json
{"decision":"block","reason":"..."}
```

HOL Guard already has native pre-tool authority for command decisions. The supported native request is a versioned `PreToolUse` envelope whose `tool_input.command` contains the command string. The Rust runtime owns the security decision. The adapter transports and renders that result rather than reimplementing Guard policy in Klaat Code.

## Prepared adapter behavior

The owned fork contains `scripts/hol-guard-before-tool.mjs`. For `tool_name == "run_command"` it:

1. Parses `tool_args` as JSON.
2. Extracts the non-empty `command` string. Missing or malformed command input fails closed.
3. Constructs a Guard `PreToolUse` request with the current project as `cwd`.
4. Sends the complete request through `hol-guard hook --harness codex --json`, with the workspace when available, so Guard's native hook authority remains the decision owner.
5. Allows an authoritative native `allow` decision, or the explicit `native_policy_warning` allow-with-warning result.
6. Fails closed when native review is unavailable or not ready, including `native_pre_tool_unavailable`, `native_policy_not_ready`, worker/daemon availability failures, unmanaged-harness passthrough, unknown warning results, malformed output, timeout, missing Guard, review, reapproval, sandbox-required, or block.

The adapter does not use `hol-guard command explain` as enforcement authority.

## Validation completed

The exact owned branch was downloaded into an independent Linux sandbox and validated with Node 20 and Bun 1.4.2.

The following checks pass:

- `node --check scripts/hol-guard-before-tool.mjs`
- `node --test scripts/hol-guard-before-tool.test.mjs`, 7/7 focused tests
- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run build`

The focused tests cover command extraction, unrelated hook pass-through, malformed `tool_args`, complete `PreToolUse` envelope construction, authoritative allow and policy-warning handling, unavailable native review, unknown warnings, review/block responses, and malformed/missing-reason responses.

## Real HOL Guard 3.4.2 availability test

A clean isolated Python environment installed the published `hol-guard==3.4.2` package successfully.

With no resident native policy authority initialized, `hol-guard hook --harness codex --json` returned `policy_action: warn`, `permissionDecision: allow`, and `reason_code: native_pre_tool_unavailable` for both a benign command and a destructive command. That response means Guard could not complete the native decision. It is not execution proof.

The first adapter version treated a generic `warn` plus `permissionDecision: allow` as sufficient and therefore would have allowed that unavailable state. The owned-fork adapter now rejects Guard availability and not-ready reason codes and rejects unknown warning results. Re-running the adapter against the same real 3.4.2 runtime now emits Klaat's block result for both test commands while Guard authority is unavailable.

This closes the unavailable-runtime fail-open defect. It does not yet prove the final authoritative allow/deny path.

## Remaining real-runtime gate

The implementation is not ready for upstream submission until an isolated managed Guard runtime can produce authoritative native decisions for these cases:

| Case | Expected result |
| --- | --- |
| `pwd` | Klaat Code command proceeds after authoritative Guard allow |
| `git status --short` | Klaat Code command proceeds after authoritative Guard allow |
| `rm -rf /` | Klaat Code command is blocked |
| `shred ~/.ssh/id_ed25519` | Klaat Code command is blocked |
| malformed `tool_args` | fail closed |
| Guard runtime unavailable | fail closed |

The deny-path test must prove that the target command is not executed.

An isolated `hol-guard install codex` attempt in the validation sandbox did not establish that authority because Guard rejected the sandbox interpreter as writable by another user. No real user installation was modified. A clean authoritative setup remains required before upstream submission.

## Candidate hook configuration

The adapter should remain project-local until there is a stable shipped integration surface:

```json
{
  "before_tool": [
    {
      "matcher": "run_command",
      "command": "node ./scripts/hol-guard-before-tool.mjs"
    }
  ]
}
```

The current upstream README example points at `./scripts/guard-shell.sh`, but that helper is not present in the repository. This owned-fork candidate supplies the missing executable behavior without changing Klaat's hook semantics.

## Upstream gate

Before any upstream PR:

- revalidate the current Klaat Code upstream head, hook payload, block semantics, contribution guidance, and queue ownership;
- revalidate HOL Guard's current native hook entry point;
- keep Klaat Code typecheck/build plus focused adapter tests green;
- prove one authoritative allow path and one authoritative deny path with the real Guard runtime, including target command non-execution on deny;
- confirm the contribution still fits current Distribution WIP and maintainer-conversion gates.

Until those gates pass, this remains owned-fork preparation and carries no strict outcome value.
