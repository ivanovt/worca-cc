import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock lit-html since it requires DOM APIs that aren't present here.
vi.mock('lit-html', () => ({
  html: () => null,
  nothing: null,
}));
vi.mock('lit-html/directives/unsafe-html.js', () => ({
  unsafeHTML: () => null,
}));
vi.mock('lit-html/directives/ref.js', () => ({
  ref: () => null,
}));
vi.mock('../utils/icons.js', () => ({
  iconSvg: () => '',
  FileText: 'FileText',
  Sparkles: 'Sparkles',
  Circle: 'Circle',
  CircleAlert: 'CircleAlert',
  CircleCheck: 'CircleCheck',
  CircleSlash: 'CircleSlash',
  Loader: 'Loader',
  Pause: 'Pause',
}));

function createDocStub() {
  const elements = {};
  return {
    getElementById: vi.fn((id) => elements[id] || null),
    _set(id, value) {
      elements[id] = { value, id };
    },
    _clear() {
      for (const k of Object.keys(elements)) delete elements[k];
    },
  };
}

describe('Template advisor — Suggest button flow', () => {
  let origFetch;
  let mod;
  let docStub;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    docStub = createDocStub();
    globalThis.document = docStub;
    vi.resetModules();
    vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
    vi.doMock('lit-html/directives/ref.js', () => ({ ref: () => null }));
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: () => null,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '',
      FileText: 'FileText',
      Sparkles: 'Sparkles',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));
    mod = await import('./new-run.js');
    mod.resetNewRunState({
      templates: [
        {
          id: 'bugfix',
          name: 'Bugfix',
          tier: 'builtin',
          description: 'Fast bug fix',
          config: {},
        },
        {
          id: 'feature',
          name: 'Feature',
          tier: 'builtin',
          description: 'Full feature pipeline',
          config: {},
        },
      ],
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    docStub._clear();
  });

  describe('readAdvisorInputs', () => {
    it('reads the prompt textarea when sourceType is none', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', '  fix the bug  ');
      const out = mod.readAdvisorInputs();
      expect(out).toEqual({ sourceType: 'none', sourceValue: 'fix the bug' });
    });

    it('reads the source-value input when sourceType is github-issue', async () => {
      mod.resetNewRunState({ sourceType: 'source' });
      docStub._set('new-run-source-value', 'gh:issue:42');
      const out = mod.readAdvisorInputs();
      expect(out).toEqual({ sourceType: 'source', sourceValue: 'gh:issue:42' });
    });

    it('reads the source-value input when sourceType is pr', async () => {
      mod.resetNewRunState({ sourceType: 'pr' });
      docStub._set('new-run-source-value', 'gh:pr:99');
      const out = mod.readAdvisorInputs();
      expect(out.sourceValue).toBe('gh:pr:99');
    });

    it('reads the source-value input when sourceType is spec', async () => {
      mod.resetNewRunState({ sourceType: 'spec' });
      docStub._set('new-run-source-value', 'docs/spec.md');
      const out = mod.readAdvisorInputs();
      expect(out.sourceValue).toBe('docs/spec.md');
    });
  });

  describe('requestTemplateAdvice', () => {
    it('shows error state when prompt is empty', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      // no prompt set
      await mod.requestTemplateAdvice({ projectId: 'p1' });
      expect(mod.advisorStatus).toBe('error');
      expect(mod.advisorDialogOpen).toBe(true);
      expect(mod.advisorError).toMatch(/prompt/i);
    });

    it('shows error state when source value is empty', async () => {
      mod.resetNewRunState({ sourceType: 'source' });
      // no source value set
      await mod.requestTemplateAdvice({ projectId: 'p1' });
      expect(mod.advisorStatus).toBe('error');
      expect(mod.advisorError).toMatch(/github issue/i);
    });

    it('posts to the project-scoped endpoint on success', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'bugfix',
            rationale: 'bug language',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await mod.requestTemplateAdvice({ projectId: 'p1' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/p1/templates/advise');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.sourceType).toBe('none');
      expect(body.sourceValue).toBe('Fix the bug');
      expect(mod.advisorStatus).toBe('ready');
      expect(mod.advisorAdvice.template_id).toBe('bugfix');
      expect(mod.advisorDialogOpen).toBe(true);
    });

    it('posts to the global endpoint when no projectId is provided', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'bugfix',
            rationale: 'x',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await mod.requestTemplateAdvice({});
      expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/templates/advise');
    });

    it('surfaces server errors in advisorError', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: 'claude exited 1' }),
      });
      await mod.requestTemplateAdvice({ projectId: 'p1' });
      expect(mod.advisorStatus).toBe('error');
      expect(mod.advisorError).toMatch(/claude exited 1/);
    });

    it('handles fetch rejecting outright', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'x');
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
      await mod.requestTemplateAdvice({ projectId: 'p1' });
      expect(mod.advisorStatus).toBe('error');
      expect(mod.advisorError).toMatch(/network down/);
    });

    it('paints the loading frame before awaiting the network call', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      let resolveFetch;
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const rerender = vi.fn();
      const pending = mod.requestTemplateAdvice({
        projectId: 'p1',
        rerender,
      });
      // Loading state and dialog visibility must be set synchronously, and
      // rerender must have been called before any await unblocks.
      expect(mod.advisorStatus).toBe('loading');
      expect(mod.advisorDialogOpen).toBe(true);
      expect(rerender).toHaveBeenCalled();
      const callsBeforeResolve = rerender.mock.calls.length;
      // Resolve the fetch so the awaiting code runs and stamps the result.
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'bugfix',
            rationale: 'x',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await pending;
      expect(mod.advisorStatus).toBe('ready');
      expect(rerender.mock.calls.length).toBeGreaterThan(callsBeforeResolve);
    });

    it('passes an AbortSignal so dismissAdvisor can cancel the call', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      let capturedInit;
      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        capturedInit = init;
        return new Promise(() => {});
      });
      mod.requestTemplateAdvice({ projectId: 'p1', rerender: () => {} });
      expect(capturedInit?.signal).toBeDefined();
      expect(capturedInit.signal.aborted).toBe(false);
      mod.dismissAdvisor();
      expect(capturedInit.signal.aborted).toBe(true);
    });

    it('ignores a late response after dismissAdvisor was called', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      let resolveFetch;
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const pending = mod.requestTemplateAdvice({
        projectId: 'p1',
        rerender: () => {},
      });
      mod.dismissAdvisor();
      expect(mod.advisorStatus).toBe('idle');
      // A late response arrives — it must NOT flip state back to 'ready'.
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'bugfix',
            rationale: 'late',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await pending;
      expect(mod.advisorStatus).toBe('idle');
      expect(mod.advisorAdvice).toBeNull();
      expect(mod.advisorDialogOpen).toBe(false);
    });

    it('a fresh Suggest click supersedes the previous in-flight call', async () => {
      mod.resetNewRunState({ sourceType: 'none' });
      docStub._set('new-run-prompt', 'Fix the bug');
      let firstResolve;
      let secondResolve;
      const responses = [
        new Promise((resolve) => {
          firstResolve = resolve;
        }),
        new Promise((resolve) => {
          secondResolve = resolve;
        }),
      ];
      let call = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => responses[call++]);
      const first = mod.requestTemplateAdvice({
        projectId: 'p1',
        rerender: () => {},
      });
      const second = mod.requestTemplateAdvice({
        projectId: 'p1',
        rerender: () => {},
      });
      // Resolve the SECOND call first with feature, then the stale first call.
      secondResolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'feature',
            rationale: 'second wins',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await second;
      expect(mod.advisorAdvice.template_id).toBe('feature');
      // Now the stale first call resolves — it MUST be discarded.
      firstResolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          advice: {
            template_id: 'bugfix',
            rationale: 'first (stale)',
            confidence: 'high',
            alternatives: [],
          },
        }),
      });
      await first;
      expect(mod.advisorAdvice.template_id).toBe('feature');
    });
  });

  describe('applyAdvisorRecommendation', () => {
    it('sets selectedTemplate when the id is in the catalog', async () => {
      mod.resetNewRunState({
        templates: [
          { id: 'bugfix', name: 'Bugfix', tier: 'builtin', config: {} },
        ],
        advisorDialogOpen: true,
      });
      const applied = mod.applyAdvisorRecommendation('bugfix');
      expect(applied).toBe(true);
      expect(mod.selectedTemplate).toBe('bugfix');
      expect(mod.advisorDialogOpen).toBe(false);
    });

    it('refuses to apply an unknown template id', async () => {
      mod.resetNewRunState({
        templates: [
          { id: 'bugfix', name: 'Bugfix', tier: 'builtin', config: {} },
        ],
        advisorDialogOpen: true,
        selectedTemplate: 'default',
      });
      const applied = mod.applyAdvisorRecommendation('ghost');
      expect(applied).toBe(false);
      expect(mod.selectedTemplate).toBe('default');
      expect(mod.advisorDialogOpen).toBe(true);
    });
  });

  describe('dismissAdvisor', () => {
    it('closes the dialog and clears errors', async () => {
      mod.resetNewRunState({
        advisorDialogOpen: true,
        advisorStatus: 'error',
        advisorError: 'boom',
      });
      mod.dismissAdvisor();
      expect(mod.advisorDialogOpen).toBe(false);
      expect(mod.advisorStatus).toBe('idle');
      expect(mod.advisorError).toBe('');
    });

    it('keeps ready state on close so reopen shows the last result', async () => {
      mod.resetNewRunState({
        advisorDialogOpen: true,
        advisorStatus: 'ready',
        advisorAdvice: {
          template_id: 'bugfix',
          rationale: 'x',
          confidence: 'high',
          alternatives: [],
        },
      });
      mod.dismissAdvisor();
      expect(mod.advisorDialogOpen).toBe(false);
      expect(mod.advisorStatus).toBe('ready');
      expect(mod.advisorAdvice).not.toBeNull();
    });
  });
});
