import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../state/DataProvider';
import { useProject } from '../ProjectEditor';
import { Button, Modal, Notice } from '../../components/ui';
import { IconAlert, IconLock } from '../../components/ui/icons';
import { claudeReplanIds, findPreset, planningInput, REFERENCE_IMAGE, usd } from '../../lib/pipeline';
import { getSegments } from '../../lib/project';
import type { AiStatus, AiUsageEntry, PlanEstimate, PlanReferences } from '../../../shared/pipeline/types';

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-signal,#d9ff3f)]" />
      <span>{children}</span>
    </label>
  );
}

/**
 * The only way a Claude run starts: the editor sees exactly what would be sent and what it could
 * cost (worked out locally, nothing sent yet), chooses any reference material, and confirms. Every
 * run asks; the first one is never sent without this confirmation.
 */
export function ClaudeRunDialog({ open, onClose, segmentId }: { open: boolean; onClose: () => void; segmentId?: string }) {
  const { project, pipeline } = useProject();
  const { presets } = useData();
  const navigate = useNavigate();
  const api = window.electronAPI;
  const preset = findPreset(project, presets);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [estimate, setEstimate] = useState<PlanEstimate | null>(null);
  const [history, setHistory] = useState<AiUsageEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendLinks, setSendLinks] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const links = useMemo(() => (preset?.referenceLinks ?? []).filter((l) => l.trim()), [preset]);
  const imageFiles = useMemo(() => (preset?.referenceFiles ?? []).filter((f) => REFERENCE_IMAGE.test(f)), [preset]);
  const videoFiles = useMemo(() => (preset?.referenceFiles ?? []).filter((f) => !REFERENCE_IMAGE.test(f)), [preset]);
  const allowReplan = useMemo(() => claudeReplanIds(project, segmentId), [project, segmentId]);
  const references: PlanReferences = useMemo(() => ({ notes: sendLinks ? links.map((l) => `Reference link (not opened, for its description only): ${l}`) : [], imagePaths: images }), [sendLinks, links, images]);

  // Re-estimate whenever the choice of what to send changes (local; nothing is sent).
  useEffect(() => {
    if (!open || !api) return;
    let live = true;
    setLoading(true);
    setError(null);
    (async () => {
      const st = await api.getAiStatus();
      if (!live) return;
      if (st.ok) setStatus(st.result);
      const usage = await api.getAiUsage(project.id);
      if (live && usage.ok) setHistory(usage.result.history ?? []);
      try {
        const r = await api.estimatePlan({ ...planningInput(project, presets), allowReplan, useModel: true, references });
        if (!live) return;
        if (r.ok) setEstimate(r.result);
        else {
          setEstimate(null);
          setError(r.error.message);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      if (live) setLoading(false);
    })();
    return () => {
      live = false;
    };
    // The project object changes on every edit; the request only depends on these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api, allowReplan, references, project.id, presets]);

  const rows = useMemo(() => {
    const ids = new Set(estimate?.segmentIds ?? []);
    return getSegments(project).filter((s) => ids.has(s.id));
  }, [estimate, project]);

  const confirm = async () => {
    onClose();
    await pipeline.generateWithClaude({ allowReplan, references });
  };

  const notReady = status && (status.provider !== 'anthropic' || !status.keyStored);
  const blocked = estimate?.blockedBy;
  const nothing = estimate && estimate.segments === 0;
  const spentHere = history.reduce((n, e) => n + (e.estimatedCost ?? 0), 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={segmentId ? 'Ask Claude about this segment' : 'Generate with Claude'}
      description="Nothing has been sent yet. Check what goes to Anthropic and what it could cost, then confirm."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {notReady ? (
            <Button variant="primary" onClick={() => navigate('/settings')}>
              Open Settings
            </Button>
          ) : (
            <Button variant="accent" data-testid="claude-confirm" disabled={loading || !estimate || Boolean(blocked) || Boolean(nothing)} onClick={() => void confirm()}>
              {estimate && !nothing ? `Send to Claude · up to ${usd(estimate.maxCost)}` : 'Send to Claude'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5 text-[13.5px]" data-testid="claude-dialog">
        {notReady && (
          <Notice tone="signal" icon={<IconLock size={16} />} title={status.provider !== 'anthropic' ? 'Claude is turned off' : 'No API key saved'}>
            {status.provider !== 'anthropic'
              ? 'Choose Anthropic Claude as the planning provider in Settings → Claude API. Local planning keeps working without it.'
              : 'Add your Anthropic API key in Settings → Claude API. It is stored encrypted on this computer.'}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" icon={<IconAlert size={16} />} title="Can’t prepare the request">
            {error}
          </Notice>
        )}
        {blocked && !notReady && (
          <Notice tone="danger" icon={<IconAlert size={16} />} title="This run would be refused" >
            <span data-testid="claude-blocked">{blocked}</span>
          </Notice>
        )}
        {nothing && (
          <Notice title="Nothing to send">
            Every row already has a Claude suggestion or a decision. Rows you add, change or reject are sent next time; to ask about one specific row, use Ask Claude in its Inspector.
          </Notice>
        )}

        {estimate && !nothing && (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-[12px] border border-line bg-surface-1 p-4 xl:grid-cols-4" data-testid="claude-estimate">
              <div>
                <p className="text-[12px] text-ink-3">Estimated cost</p>
                <p className="timecode text-[17px] text-ink">{usd(estimate.expectedCost)}</p>
                <p className="text-[12px] text-ink-3">up to {usd(estimate.maxCost)}</p>
              </div>
              <div>
                <p className="text-[12px] text-ink-3">Model</p>
                <p className="timecode text-ink">{estimate.model}</p>
                {!estimate.priced && <p className="text-[12px] text-warning">No price on file; estimate uses the dearest model.</p>}
              </div>
              <div>
                <p className="text-[12px] text-ink-3">Requests</p>
                <p className="timecode text-ink">
                  {estimate.requests - estimate.cachedRequests} to send
                  {estimate.cachedRequests > 0 && <span className="text-ink-3"> · {estimate.cachedRequests} from earlier answers (free)</span>}
                </p>
                <p className="text-[12px] text-ink-3">~{estimate.inputTokens.toLocaleString()} input tokens</p>
              </div>
              <div>
                <p className="text-[12px] text-ink-3">Spent so far</p>
                <p className="timecode text-ink">{usd(estimate.projectSpent)} this project</p>
                <p className="text-[12px] text-ink-3">
                  {usd(estimate.monthSpent)} this month{estimate.monthlyLimit !== undefined ? ` of ${usd(estimate.monthlyLimit)}` : ''}
                  {estimate.budget.hardLimit !== undefined ? ` · project limit ${usd(estimate.budget.hardLimit)}` : ''}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-medium text-ink">Sent to Anthropic</p>
              <ul className="ml-4 list-disc space-y-1 text-ink-2">
                <li>
                  {rows.length} transcript row(s) with their timing and editor instructions
                  {segmentId ? '' : ' (rows planned locally and not yet approved, plus new, changed and rejected rows)'}
                </li>
                <li>The creative brief and branding notes of “{preset?.name ?? project.presetName}”, its brand colours and font names, and this project’s notes</li>
                {links.length > 0 && (
                  <li>
                    <Check id="claude-links" checked={sendLinks} onChange={setSendLinks}>
                      {links.length} reference link(s), as text only (Claude doesn’t open them)
                    </Check>
                  </li>
                )}
                {imageFiles.map((f) => (
                  <li key={f}>
                    <Check id={`claude-img-${base(f)}`} checked={images.includes(f)} onChange={(v) => setImages((cur) => (v ? [...cur, f] : cur.filter((x) => x !== f)))}>
                      Reference image {base(f)} (adds roughly 1,600 input tokens)
                    </Check>
                  </li>
                ))}
              </ul>
              <p className="font-medium text-ink">Never sent</p>
              <ul className="ml-4 list-disc space-y-1 text-ink-3">
                <li>Your source video and audio{videoFiles.length ? `, and the ${videoFiles.length} reference video(s) in the preset` : ''}</li>
                <li>Other projects, and anything on this computer you didn’t choose above</li>
              </ul>
              {rows.length > 0 && (
                <details className="mt-1 rounded-[10px] border border-line bg-surface-1 px-3 py-2">
                  <summary className="cursor-pointer text-[13px] text-ink-2">Show the {rows.length} row(s)</summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[12.5px] text-ink-3">
                    {rows.map((r) => (
                      <li key={r.id} className="truncate">
                        {r.transcript}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <p className="text-[12px] leading-relaxed text-ink-3">
              Billed to your Anthropic account. Estimates come from Edissistant’s price table ({estimate.pricingVersion}), not from Anthropic. Claude’s answer is checked before it’s used, it never runs code, and nothing is approved for you. A failed request is not retried automatically.
            </p>
          </>
        )}

        {history.length > 0 && (
          <details className="rounded-[10px] border border-line bg-surface-1 px-3 py-2" data-testid="claude-history">
            <summary className="cursor-pointer text-[13px] text-ink-2">
              Claude usage for this project: {history.length} request(s), {usd(spentHere)}
            </summary>
            <table className="mt-2 w-full text-left text-[12.5px]">
              <tbody className="divide-y divide-line text-ink-3">
                {history
                  .slice(-10)
                  .reverse()
                  .map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td className="py-1">{new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td className="timecode py-1">{e.model}</td>
                      <td className="timecode py-1">{e.segments} row(s)</td>
                      <td className="timecode py-1">
                        {(e.inputTokens + e.cacheReadInputTokens + e.cacheCreationInputTokens).toLocaleString()} / {e.outputTokens.toLocaleString()} tokens
                      </td>
                      <td className="timecode py-1 text-ink-2">{usd(e.estimatedCost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Modal>
  );
}
