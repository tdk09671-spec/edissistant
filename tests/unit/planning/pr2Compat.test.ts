// Validates adapter output with PR #2's own validator (src/shared/animation/validate.ts). On a branch
// without PR #2 this is skipped; once PR #2 is merged (or in a trial merge) it runs automatically.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { applyEditorAction, buildStyleProfile, CreativePlanner, planToAnimationSpecs, toSequenceSpec, type AdapterResult } from '../../../src/shared/planning';
import { NOW, now, preset, profile, transcript } from './helpers';

const validatorPath = path.resolve(__dirname, '../../../src/shared/animation/validate.ts');
const hasPr2 = fs.existsSync(validatorPath);

type Validate = (input: unknown) => { ok: boolean; issues?: { path: string; message: string }[] };

async function specsFor(client: 'northwind' | 'lumen', video: 'video-a' | 'video-b', overFootage = false): Promise<AdapterResult[]> {
  const prof = overFootage ? buildStyleProfile({ preset: preset(client), overrides: { background: 'over-footage' } }, NOW) : profile(client);
  const segments = transcript(video).map((s) => ({ ...s, speaker: s.speaker ?? 'Maya Chen' }));
  const { plan } = await new CreativePlanner().plan({ projectId: video, profile: prof, segments }, { now });
  const approved = { ...plan, segments: plan.segments.map((s) => applyEditorAction(s, { type: 'approve' }, NOW)) };
  return planToAnimationSpecs(approved, segments, prof, { width: 1920, height: 1080, fps: 29.97 });
}

describe.skipIf(!hasPr2)('PR #2 compatibility (runs when PR #2 is present)', () => {
  it('every renderable spec passes PR #2 validateAnimationSpec, and sequences pass validateSequence', async () => {
    const mod = (await import(/* @vite-ignore */ validatorPath)) as { validateAnimationSpec: Validate; validateSequence: Validate };
    let checked = 0;
    for (const [client, video, over] of [['northwind', 'video-a', false], ['northwind', 'video-b', false], ['lumen', 'video-a', false], ['northwind', 'video-a', true]] as const) {
      const results = await specsFor(client, video, over);
      for (const r of results) {
        if (r.status !== 'renderable') continue;
        const v = mod.validateAnimationSpec(r.spec);
        expect(v.issues ?? [], `${client}/${video}/${r.segmentId} (${r.conceptId})`).toEqual([]);
        checked++;
      }
      const seq = mod.validateSequence(toSequenceSpec(video, results, { width: 1920, height: 1080, fps: 29.97 }));
      expect(seq.issues ?? []).toEqual([]);
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('every renderable concept in the library validates (one synthetic segment each)', async () => {
    const mod = (await import(/* @vite-ignore */ validatorPath)) as { validateAnimationSpec: Validate };
    const { adaptSegment, CONCEPTS } = await import('../../../src/shared/planning');
    const text = 'First we listen, then we prototype, and finally we ship: revenue grew from $2 million to $9 million, 85% compared to agencies?';
    const params = {
      headline: 'revenue grew from $2 million to $9 million',
      values: [{ value: 2e6, unit: 'currency' as const, label: '$2 million' }, { value: 85, unit: 'percent' as const, label: '85%' }],
      items: ['we listen', 'we prototype', 'we ship'],
    };
    const words = text.split(' ').map((w, i) => ({ text: w, start: 10 + i * 0.2, end: 10 + i * 0.2 + 0.18 }));
    for (const c of CONCEPTS) {
      const r = adaptSegment({ segmentId: `c-${c.id}`, start: 10, end: 16, text, speaker: 'Maya Chen', words, conceptId: c.id, visualMode: c.visualMode, params, transition: 'slide', status: 'approved' }, profile(), { width: 1920, height: 1080, fps: 25 });
      if (r.status !== 'renderable') {
        expect(['no-graphic', 'unsupported']).toContain(r.status);
        continue;
      }
      expect(mod.validateAnimationSpec(r.spec).issues ?? [], c.id).toEqual([]);
    }
  });
});
