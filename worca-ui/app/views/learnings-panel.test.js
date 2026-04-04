import { describe, expect, it } from 'vitest';
import {
  importanceBadge,
  learningsSectionView,
  observationPrompt,
  suggestionPrompt,
} from './learnings-panel.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (typeof v === 'boolean') result += '';
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
      // unsafeHTML directives, functions, etc. — skip
    }
  });
  return result;
}

const SAMPLE_OUTPUT = {
  run_summary: {
    termination: 'success',
    total_iterations: 5,
    test_fix_loops: 2,
    review_fix_loops: 1,
    plan_restarts: 0,
  },
  observations: [
    {
      category: 'test_loop',
      importance: 'high',
      description: 'Repeated test failures in auth module',
      evidence: 'Tests failed 3 times before passing',
      occurrences: 3,
    },
    {
      category: 'planning',
      importance: 'medium',
      description: 'Plan missed edge case',
      evidence: 'Auth edge case discovered during implementation',
      occurrences: 1,
    },
  ],
  suggestions: [
    {
      target: 'prompt:tester',
      description: 'Add auth edge case coverage guidance',
      rationale: 'Would prevent repeated test-fix loops',
    },
  ],
  recurring_patterns: {
    cross_bead: [
      {
        pattern: 'Missing imports',
        affected_beads: ['bead-1', 'bead-2'],
        frequency: 4,
      },
    ],
    test_fix_loops: [
      {
        pattern: 'Type mismatch in API calls',
        loop_iterations: 3,
        resolved: true,
      },
    ],
    review_fix_loops: [],
  },
};

/** Wrap output in a completed learnStage object */
function completedStage(output, overrides = {}) {
  return {
    status: 'completed',
    started_at: '2026-03-19T10:00:00.000Z',
    completed_at: '2026-03-19T10:04:30.000Z',
    iterations: [
      {
        number: 1,
        output,
        started_at: '2026-03-19T10:00:00.000Z',
        completed_at: '2026-03-19T10:04:30.000Z',
        turns: 12,
        cost_usd: 0.85,
        duration_api_ms: 210000,
      },
    ],
    ...overrides,
  };
}

describe('learningsSectionView', () => {
  describe('empty state', () => {
    it('renders empty state when no learnStage data', () => {
      const html = renderToString(
        learningsSectionView(null, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-section');
      expect(html).toContain('learnings-empty');
      expect(html).toContain('Learning analysis has not been run');
      expect(html).toContain('Run Learning Analysis');
    });

    it('renders empty state for undefined learnStage', () => {
      const html = renderToString(
        learningsSectionView(undefined, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-empty');
    });

    it('renders empty state for skipped status', () => {
      const html = renderToString(
        learningsSectionView({ status: 'skipped' }, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-empty');
      expect(html).toContain('Run Learning Analysis');
    });
  });

  describe('in_progress state', () => {
    it('renders spinner and progress message when status is in_progress', () => {
      const stage = {
        status: 'in_progress',
        started_at: new Date().toISOString(),
      };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-in-progress');
      expect(html).toContain('Learning analysis in progress');
      expect(html).not.toContain('learnings-empty');
    });

    it('shows timing strip with Started label during in_progress', () => {
      const stage = {
        status: 'in_progress',
        started_at: '2026-03-19T10:00:00.000Z',
      };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('timing-strip');
      expect(html).toContain('Started:');
      expect(html).not.toContain('Finished:');
    });

    it('renders pending state same as in_progress', () => {
      const stage = { status: 'pending' };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-in-progress');
    });

    it('shows Analyzing badge in header', () => {
      const stage = {
        status: 'in_progress',
        started_at: new Date().toISOString(),
      };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('Analyzing');
    });

    it('shows stalled message when in_progress for over 15 minutes', () => {
      const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const stage = { status: 'in_progress', started_at: old };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('appears to have stalled');
      expect(html).toContain('Retry');
    });
  });

  describe('error state', () => {
    it('renders error message and retry button', () => {
      const stage = { status: 'error', error: 'API timeout' };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-error');
      expect(html).toContain('Learning analysis failed');
      expect(html).toContain('API timeout');
      expect(html).toContain('Retry Learning Analysis');
    });

    it('shows Error badge in header', () => {
      const stage = { status: 'error', error: 'crash' };
      const html = renderToString(
        learningsSectionView(stage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('Error');
    });
  });

  describe('with completed learnings data', () => {
    it('renders learnings-section wrapper', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('learnings-section');
      expect(html).not.toContain('learnings-empty');
    });

    it('renders header with observation count', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('learnings-header');
      expect(html).toContain('Learnings');
      expect(html).toContain('learnings-count');
    });

    it('renders run summary strip', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('learnings-summary-strip');
      expect(html).toContain('success');
      expect(html).toContain('5');
    });

    it('renders observations table with rows', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('Observations');
      expect(html).toContain('learnings-table-header');
      expect(html).toContain('learnings-table-row');
      expect(html).toContain('Repeated test failures in auth module');
      expect(html).toContain('test_loop');
      expect(html).toContain('high');
    });

    it('renders suggestions table with rows', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('Suggestions');
      expect(html).toContain('prompt:tester');
      expect(html).toContain('Add auth edge case coverage guidance');
      expect(html).toContain('Would prevent repeated test-fix loops');
    });

    it('renders recurring patterns section', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('Recurring Patterns');
      expect(html).toContain('Cross-Bead');
      expect(html).toContain('Missing imports');
      expect(html).toContain('Test-Fix Loops');
      expect(html).toContain('Type mismatch in API calls');
    });

    it('does not render empty recurring pattern sections', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).not.toContain('Review-Fix Loops');
    });

    it('renders timing strip with started, finished, duration', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('timing-strip');
      expect(html).toContain('Started:');
      expect(html).toContain('Finished:');
      expect(html).toContain('Duration:');
    });

    it('renders stage meta with turns and cost', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('stage-info-strip');
      expect(html).toContain('Turns:');
      expect(html).toContain('12');
      expect(html).toContain('Cost:');
      expect(html).toContain('$0.85');
      expect(html).toContain('API Duration:');
    });

    it('renders re-run button after completed results', () => {
      const html = renderToString(
        learningsSectionView(completedStage(SAMPLE_OUTPUT), {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('learnings-rerun');
      expect(html).toContain('Re-run Analysis');
    });
  });

  describe('edge cases', () => {
    it('handles learnings with no observations', () => {
      const data = { ...SAMPLE_OUTPUT, observations: [] };
      const html = renderToString(
        learningsSectionView(completedStage(data), { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-count');
    });

    it('handles learnings with no suggestions', () => {
      const data = { ...SAMPLE_OUTPUT, suggestions: [] };
      const html = renderToString(
        learningsSectionView(completedStage(data), { onRunLearn: () => {} }),
      );
      expect(html).toContain('Suggestions');
    });

    it('handles missing recurring_patterns', () => {
      const data = { ...SAMPLE_OUTPUT, recurring_patterns: undefined };
      const html = renderToString(
        learningsSectionView(completedStage(data), { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-section');
      expect(html).not.toContain('Recurring Patterns');
    });

    it('defaults occurrences to 1 when missing', () => {
      const data = {
        ...SAMPLE_OUTPUT,
        observations: [
          {
            category: 'test_loop',
            importance: 'low',
            description: 'x',
            evidence: 'y',
          },
        ],
      };
      const html = renderToString(
        learningsSectionView(completedStage(data), { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-table-row');
    });
  });
});

describe('importanceBadge', () => {
  it('returns danger for critical', () => {
    expect(importanceBadge('critical')).toBe('danger');
  });

  it('returns warning for high', () => {
    expect(importanceBadge('high')).toBe('warning');
  });

  it('returns primary for medium', () => {
    expect(importanceBadge('medium')).toBe('primary');
  });

  it('returns neutral for low', () => {
    expect(importanceBadge('low')).toBe('neutral');
  });

  it('returns neutral for unknown', () => {
    expect(importanceBadge('unknown')).toBe('neutral');
  });
});

describe('observationPrompt', () => {
  it('includes observation details in the prompt', () => {
    const obs = {
      category: 'test_loop',
      importance: 'high',
      description: 'Repeated failures',
      evidence: 'Failed 3 times',
      occurrences: 3,
    };
    const prompt = observationPrompt(obs);
    expect(prompt).toContain('test_loop');
    expect(prompt).toContain('high');
    expect(prompt).toContain('Repeated failures');
    expect(prompt).toContain('Failed 3 times');
    expect(prompt).toContain('3');
    expect(prompt).toContain('root cause');
  });

  it('defaults occurrences to 1', () => {
    const obs = {
      category: 'planning',
      importance: 'low',
      description: 'x',
      evidence: 'y',
    };
    const prompt = observationPrompt(obs);
    expect(prompt).toContain('1');
  });
});

describe('suggestionPrompt', () => {
  it('includes suggestion details in the prompt', () => {
    const s = {
      target: 'prompt:tester',
      description: 'Add edge case guidance',
      rationale: 'Prevents loops',
    };
    const prompt = suggestionPrompt(s);
    expect(prompt).toContain('prompt:tester');
    expect(prompt).toContain('Add edge case guidance');
    expect(prompt).toContain('Prevents loops');
    expect(prompt).toContain('Locate the target');
  });
});

describe('copy buttons in rendered output', () => {
  it('renders copy button in observations table', () => {
    const html = renderToString(
      learningsSectionView(completedStage(SAMPLE_OUTPUT), {
        onRunLearn: () => {},
      }),
    );
    expect(html).toContain('learnings-copy-btn');
    expect(html).toContain('Copy investigation prompt');
  });

  it('renders copy button in suggestions table', () => {
    const html = renderToString(
      learningsSectionView(completedStage(SAMPLE_OUTPUT), {
        onRunLearn: () => {},
      }),
    );
    expect(html).toContain('Copy implementation prompt');
  });
});
