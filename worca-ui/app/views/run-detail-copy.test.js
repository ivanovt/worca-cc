import { describe, expect, it } from 'vitest';
import { _stageToJson } from './run-detail.js';

// The stage "Copy" button serializes via _stageToJson. It must stay in sync
// with everything the stage section renders, so the copied JSON is the full
// stage record — effort, graphify, token usage, dispatch, classification,
// structured output, and the preflight graphify fields.
describe('_stageToJson — stage Copy payload completeness', () => {
  const stage = {
    status: 'completed',
    started_at: '2026-05-23T10:00:00Z',
    completed_at: '2026-05-23T10:05:00Z',
    token_usage: { input_tokens: 100, output_tokens: 50 },
    task_progress: '2/3 beads',
    skipped: false,
    plan_file: 'docs/plans/x.md',
    graphify_status: 'ready',
    graphify_report_path: '/cache/ast/r/sha/graphify/GRAPH_REPORT.md',
    iterations: [
      {
        number: 1,
        status: 'completed',
        outcome: 'success',
        turns: 5,
        cost_usd: 0.42,
        effort: { level: 'high', source: 'explicit' },
        graphify_invocations: 2,
        token_usage: { input_tokens: 100, output_tokens: 50 },
        classification: { category: 'infra_transient', retriable: true },
        dispatch_events: [
          {
            type: 'pipeline.hook.dispatch_allowed',
            section: 'skills',
            candidate: 'review',
          },
        ],
        output: { approach: 'layered' },
      },
    ],
  };

  it('includes every per-iteration field the section renders', () => {
    const it = _stageToJson('plan', stage, 'planner', 'opus', null)
      .iterations[0];
    expect(it.effort).toEqual({ level: 'high', source: 'explicit' });
    expect(it.graphify_invocations).toBe(2);
    expect(it.token_usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(it.dispatch_events).toHaveLength(1);
    expect(it.classification).toBeTruthy();
    expect(it.output).toEqual({ approach: 'layered' });
  });

  it('includes stage-level token usage, task progress, and preflight graphify fields', () => {
    const json = _stageToJson('preflight', stage, 'planner', 'opus', null);
    expect(json.token_usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(json.task_progress).toBe('2/3 beads');
    expect(json.plan_file).toBe('docs/plans/x.md');
    expect(json.graphify_status).toBe('ready');
    expect(json.graphify_report_path).toContain('GRAPH_REPORT.md');
  });

  it('preserves a real graphify_invocations: 0 (does not drop the zero count)', () => {
    const s = {
      status: 'completed',
      iterations: [{ number: 1, status: 'completed', graphify_invocations: 0 }],
    };
    const it = _stageToJson('test', s, 'tester', 'sonnet', null).iterations[0];
    expect(it.graphify_invocations).toBe(0);
  });

  it('omits absent optional fields (clean payload)', () => {
    const s = {
      status: 'completed',
      iterations: [{ number: 1, status: 'completed' }],
    };
    const json = _stageToJson('test', s, 'tester', 'sonnet', null);
    const it = json.iterations[0];
    expect(it.effort).toBeUndefined();
    expect(it.graphify_invocations).toBeUndefined();
    expect(it.token_usage).toBeUndefined();
    expect(it.output).toBeUndefined();
    expect(json.graphify_status).toBeUndefined();
    expect(json.task_progress).toBeUndefined();
  });
});
