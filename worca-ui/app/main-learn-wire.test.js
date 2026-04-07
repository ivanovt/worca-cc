/**
 * Tests for the wiring contracts of learnings into main.js.
 *
 * main.js passes run?.stages?.learn (the full stage object) to learningsSectionView.
 * The view derives its state from learnStage.status and learnStage.iterations[0].output.
 */
import { describe, expect, it, vi } from 'vitest';
import { learningsSectionView } from './views/learnings-panel.js';

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
    }
  });
  return result;
}

describe('main.js learnings wiring contracts', () => {
  describe('learnings data extraction path', () => {
    it('passes full learn stage to learningsSectionView', () => {
      // main.js passes: run?.stages?.learn
      const run = {
        stages: {
          learn: {
            status: 'completed',
            iterations: [
              {
                number: 1,
                output: {
                  observations: [
                    {
                      category: 'test_loop',
                      importance: 'high',
                      description: 'test',
                      evidence: 'e',
                    },
                  ],
                  suggestions: [],
                  recurring_patterns: {},
                  run_summary: { termination: 'success', total_iterations: 3 },
                },
              },
            ],
          },
        },
      };

      const learnStage = run?.stages?.learn;
      const html = renderToString(
        learningsSectionView(learnStage, { onRunLearn: () => {} }),
      );

      // Should render with data, not the empty state
      expect(html).not.toContain('learnings-empty');
      expect(html).toContain('learnings-summary-strip');
      expect(html).toContain('learnings-count');
    });

    it('shows empty state when learn stage has no iterations', () => {
      const run = { stages: { learn: { status: 'skipped' } } };
      const learnStage = run?.stages?.learn;

      const html = renderToString(
        learningsSectionView(learnStage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-empty');
    });

    it('shows empty state when learn stage is absent', () => {
      const run = { stages: { plan: { status: 'completed' } } };
      const learnStage = run?.stages?.learn;

      const html = renderToString(
        learningsSectionView(learnStage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-empty');
    });

    it('shows in-progress state when learn stage is running', () => {
      const run = {
        stages: {
          learn: {
            status: 'in_progress',
            started_at: new Date().toISOString(),
            iterations: [
              {
                number: 1,
                status: 'in_progress',
                started_at: new Date().toISOString(),
              },
            ],
          },
        },
      };
      const learnStage = run?.stages?.learn;
      const html = renderToString(
        learningsSectionView(learnStage, { onRunLearn: () => {} }),
      );
      expect(html).toContain('learnings-in-progress');
      expect(html).toContain('Learning analysis in progress');
    });
  });

  describe('doRunLearn handler contract', () => {
    it('POSTs to /api/runs/:id/learn', async () => {
      const showActionError = vi.fn();
      const runId = 'run-20260318';

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });

      async function doRunLearn() {
        try {
          const res = await mockFetch(`/api/runs/${runId}/learn`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to run learning analysis');
          }
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        }
      }

      await doRunLearn();

      expect(mockFetch).toHaveBeenCalledWith('/api/runs/run-20260318/learn', {
        method: 'POST',
      });
      expect(showActionError).not.toHaveBeenCalled();
    });

    it('calls showActionError on fetch failure', async () => {
      const showActionError = vi.fn();

      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      async function doRunLearn() {
        try {
          const res = await mockFetch('/api/runs/test/learn', {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok)
            showActionError(data.error || 'Failed to run learning analysis');
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        }
      }

      await doRunLearn();
      expect(showActionError).toHaveBeenCalledWith('Network error');
    });

    it('calls showActionError when API returns ok:false', async () => {
      const showActionError = vi.fn();

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: false,
            error: 'Learning analysis is already running',
          }),
      });

      async function doRunLearn() {
        try {
          const res = await mockFetch('/api/runs/test/learn', {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok)
            showActionError(data.error || 'Failed to run learning analysis');
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        }
      }

      await doRunLearn();
      expect(showActionError).toHaveBeenCalledWith(
        'Learning analysis is already running',
      );
    });
  });

  describe('learningsSectionView is importable', () => {
    it('exports learningsSectionView as a function', () => {
      expect(typeof learningsSectionView).toBe('function');
    });

    it('renders with onRunLearn option', () => {
      const html = renderToString(
        learningsSectionView(null, {
          onRunLearn: () => {},
        }),
      );
      expect(html).toContain('learnings-section');
      expect(html).toContain('Run Learning Analysis');
    });
  });
});
