import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuardPayload,
  decisionFromGuardResponse,
  extractKlaatCommand,
} from './hol-guard-before-tool.mjs';

test('extracts run_command command from Klaat tool_args', () => {
  assert.equal(extractKlaatCommand({
    event: 'before_tool',
    tool_name: 'run_command',
    tool_args: JSON.stringify({ command: 'git status --short' }),
  }), 'git status --short');
});

test('ignores unrelated hook events defensively', () => {
  assert.equal(extractKlaatCommand({ event: 'after_tool', tool_name: 'run_command', tool_args: '{}' }), null);
});

test('fails closed on malformed run_command input', () => {
  assert.throws(() => extractKlaatCommand({
    event: 'before_tool',
    tool_name: 'run_command',
    tool_args: '{',
  }));
});

test('builds complete PreToolUse command envelope', () => {
  assert.deepEqual(
    buildGuardPayload({ session_id: 's1', project_root: '/repo' }, 'pwd'),
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      session_id: 's1',
      cwd: '/repo',
    },
  );
});

test('allows authoritative native allow and policy warning decisions', () => {
  assert.equal(decisionFromGuardResponse({
    policy_action: 'allow',
    reason_code: 'native_exact_safe_command',
    hookSpecificOutput: { permissionDecision: 'allow' },
  }).allow, true);
  assert.equal(decisionFromGuardResponse({
    policy_action: 'warn',
    reason_code: 'native_policy_warning',
    hookSpecificOutput: { permissionDecision: 'allow' },
  }).allow, true);
});

test('fails closed on unavailable and non-authoritative warn decisions', () => {
  for (const reason_code of [
    'native_pre_tool_unavailable',
    'native_policy_not_ready',
    'native_hook_worker_unavailable',
    'harness_not_managed',
    'future_unknown_warning',
  ]) {
    assert.equal(decisionFromGuardResponse({
      policy_action: 'warn',
      reason_code,
      reason: 'Guard did not complete an authoritative review.',
      hookSpecificOutput: { permissionDecision: 'allow' },
    }).allow, false, reason_code);
  }
});

test('blocks review, block, malformed, and missing-reason responses', () => {
  for (const response of [
    { policy_action: 'review', reason_code: 'native_command_review_required', hookSpecificOutput: { permissionDecision: 'deny' } },
    { policy_action: 'block', reason_code: 'native_destructive_command', hookSpecificOutput: { permissionDecision: 'deny' } },
    { policy_action: 'allow', hookSpecificOutput: { permissionDecision: 'allow' } },
    {},
  ]) {
    assert.equal(decisionFromGuardResponse(response).allow, false);
  }
});
