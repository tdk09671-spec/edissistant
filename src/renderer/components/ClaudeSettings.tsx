import { useCallback, useEffect, useState } from 'react';
import { useData } from '../state/DataProvider';
import { isElectron } from '../lib/project';
import { usd } from '../lib/pipeline';
import { Badge, Button, Field, Input, Notice, SegmentedControl, SettingRow, useToast } from './ui';
import { IconAlert, IconCheckCircle, IconLock } from './ui/icons';
import type { AiConfig, AiConfigUpdate, AiProvider, AiStatus, AiUsage, PipelineResult } from '../../shared/pipeline/types';
import type { SecretStatus } from '../types';

/** Amount field (USD) that saves on blur; empty means "no limit". */
function MoneyInput({ id, value, onCommit, placeholder }: { id: string; value: number | undefined; onCommit: (v: number | null) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const t = draft.trim().replace(/^\$/, '');
    if (t === (value === undefined ? '' : String(value))) return;
    if (!t) return onCommit(null);
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[13px] text-ink-3">$</span>
      <Input
        id={id}
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="timecode pl-7"
      />
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Settings → Claude API: provider, key (stored encrypted by the main process; the renderer only ever
 * learns whether one is stored), connection test, model, spending limits and usage.
 */
export function ClaudeSettings() {
  const api = window.electronAPI;
  const toast = useToast();
  const { projects } = useData();
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    const [sec, st, cfg, use] = await Promise.all([api.getSecretStatus(), api.getAiStatus(), api.getAiConfig(), api.getAiUsage()]);
    setSecrets(sec);
    if (st.ok) setStatus(st.result);
    if (cfg.ok) {
      setConfig(cfg.result);
      setConfigError(null);
    } else setConfigError(cfg.error.message);
    if (use.ok) setUsage(use.result);
  }, [api]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  if (!isElectron || !api) {
    return (
      <div className="pb-5">
        <Notice icon={<IconLock size={16} />}>Claude and secure key storage are only available in the desktop app.</Notice>
      </div>
    );
  }

  const report = <T,>(r: PipelineResult<T>, failure: string): T | null => {
    if (r.ok) return r.result;
    toast(failure, { tone: 'error', description: r.error.message });
    return null;
  };

  const setProvider = async (provider: AiProvider) => {
    const s = report(await api.setAiProvider(provider), 'Couldn’t change the provider');
    if (s) setStatus(s);
  };

  const storeKey = async () => {
    if (!apiKey.trim()) return;
    setSavingKey(true);
    try {
      await api.setSecret('claudeApiKey', apiKey.trim());
      setApiKey('');
      setEditingKey(false);
      toast('API key stored securely', { description: 'Test the connection to check it.' });
    } catch (err) {
      // Electron prefixes handler errors with "Error invoking remote method…"; keep the reason only.
      const reason = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      toast('Couldn’t store the API key', { tone: 'error', description: reason });
    }
    setSavingKey(false);
    await refresh();
  };

  const removeKey = async () => {
    await api.deleteSecret('claudeApiKey');
    toast('API key removed', { description: 'It was deleted from this computer’s encrypted storage.' });
    await refresh();
  };

  const test = async () => {
    setTesting(true);
    const r = report(await api.testAiConnection(), 'Connection test failed');
    setTesting(false);
    if (r) await refresh();
  };

  const update = async (patch: AiConfigUpdate) => {
    const c = report(await api.setAiConfig(patch), 'Couldn’t save the Claude settings');
    if (c) setConfig(c);
    await refresh();
  };

  const keyLooksOdd = apiKey.trim().length > 0 && !apiKey.trim().startsWith('sk-ant-');
  const provider = status?.provider ?? 'local';
  const last = status?.lastTest ?? null;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <SettingRow
        title="Planning provider"
        description="Local planning is free and never leaves this computer. With Anthropic Claude, nothing is sent until you click Generate with Claude in a project and confirm what goes out."
      >
        <SegmentedControl
          label="Planning provider"
          size="sm"
          value={provider}
          onChange={setProvider}
          options={[
            { value: 'local', label: 'Local only' },
            { value: 'anthropic', label: 'Anthropic Claude' },
          ]}
        />
      </SettingRow>

      <div className="flex flex-col gap-5 py-5">
        {secrets && !secrets.encryptionAvailable ? (
          <Notice tone="danger" icon={<IconLock size={16} />} title="Secure storage unavailable">
            This system doesn’t provide OS credential encryption, so Edissistant won’t store an API key rather than saving it in plain text.
          </Notice>
        ) : secrets?.claudeApiKey && !editingKey ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-[11px] bg-success/12 text-success">
                <IconLock size={18} />
              </span>
              <div>
                <p className="text-sm font-medium text-ink">API key stored securely</p>
                <p className="text-[12.5px] text-ink-3">Encrypted with this computer’s credential protection. It is never shown again.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditingKey(true)}>
                Replace
              </Button>
              <Button size="sm" variant="danger" onClick={removeKey}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void storeKey();
            }}
          >
            <Field
              label="Anthropic API key"
              htmlFor="s-apikey"
              hint={keyLooksOdd ? 'Anthropic keys usually start with sk-ant-. Double-check before saving.' : 'Create one in the Anthropic Console under API keys. Usage is billed to your Anthropic account.'}
            >
              <div className="flex gap-2">
                <Input
                  id="s-apikey"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-…"
                  className="timecode min-w-0 flex-1"
                />
                <Button type="submit" variant="primary" loading={savingKey} disabled={!apiKey.trim()}>
                  Save key
                </Button>
                {editingKey && (
                  <Button variant="ghost" onClick={() => setEditingKey(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </Field>
          </form>
        )}
      </div>

      <SettingRow title="Connection" description="Checks the saved key and model with Anthropic. Free: no tokens are used.">
        <div className="flex flex-wrap items-center justify-end gap-3" data-testid="claude-connection">
          {!secrets?.claudeApiKey ? (
            <Badge tone="outline">No key</Badge>
          ) : !last ? (
            <Badge tone="neutral">Not tested</Badge>
          ) : last.ok ? (
            <Badge tone="success" dot>
              Connected · {last.displayName ?? last.model}
            </Badge>
          ) : (
            <Badge tone="danger" dot>
              Failed
            </Badge>
          )}
          <Button size="sm" variant="secondary" loading={testing} disabled={!secrets?.claudeApiKey} onClick={test}>
            Test connection
          </Button>
        </div>
      </SettingRow>
      {last && !last.ok && secrets?.claudeApiKey && (
        <div className="py-4">
          <Notice tone="danger" icon={<IconAlert size={16} />} title="The last test failed">
            {last.message} <span className="text-ink-3">({when(last.at)})</span>
          </Notice>
        </div>
      )}
      {last?.ok && (
        <p className="py-3 text-[12.5px] text-ink-3">
          <IconCheckCircle size={14} className="mr-1.5 inline text-success" />
          Checked {when(last.at)}.
        </p>
      )}

      {configError ? (
        <div className="py-5">
          <Notice tone="danger" icon={<IconAlert size={16} />} title="Planning settings file is invalid">
            {configError}
          </Notice>
        </div>
      ) : (
        config && (
          <>
            <div className="grid grid-cols-1 gap-5 py-5 xl:grid-cols-2">
              <Field
                label="Model"
                htmlFor="s-model"
                hint={`Default ${config.defaultModel}. Prices are known for ${config.knownModels.join(', ')}. Another model id works too; estimates then assume the most expensive price.`}
              >
                <ModelInput value={config.model} options={config.knownModels} onCommit={(model) => update({ model: model || null })} />
              </Field>
            </div>
            <div className="flex flex-col gap-4 py-5">
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <Field label="Warn at (per project)" htmlFor="s-soft" hint="Shown before and after a run once a project reaches it; nothing is refused.">
                  <MoneyInput id="s-soft" value={config.softLimit} placeholder="No warning" onCommit={(v) => update({ softLimit: v })} />
                </Field>
                <Field label="Project limit (each project)" htmlFor="s-hard" hint="A run that could take one project past it is refused before anything is sent.">
                  <MoneyInput id="s-hard" value={config.hardLimit} placeholder="No limit" onCommit={(v) => update({ hardLimit: v })} />
                </Field>
                <Field label="Monthly limit (all projects)" htmlFor="s-monthly" hint="Total for all projects per calendar month (UTC). A run that could pass it is refused.">
                  <MoneyInput id="s-monthly" value={config.monthlyLimit} placeholder="No limit" onCommit={(v) => update({ monthlyLimit: v })} />
                </Field>
              </div>
              <Notice icon={<IconAlert size={16} />} title="These are Edissistant’s limits, not Anthropic billing caps">
                They are checked on this computer against estimates from token counts and the price table ({config.pricingVersion}). To cap what Anthropic can charge, set a spend limit in the Anthropic Console as well.
              </Notice>
            </div>
          </>
        )
      )}

      <div className="flex flex-col gap-3 pt-5" data-testid="claude-usage">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-ink">Usage</p>
          {usage && (
            <p className="text-[13px] text-ink-2">
              This month, all projects: <span className="timecode text-ink">{usd(usage.monthSpent)}</span>
              {usage.monthlyLimit !== undefined && <span className="text-ink-3"> of your {usd(usage.monthlyLimit)} monthly limit</span>}
            </p>
          )}
        </div>
        {usage && usage.projects.length > 0 ? (
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-ink-3">
              <tr>
                <th className="py-1.5 font-medium">Project</th>
                <th className="py-1.5 font-medium">Requests</th>
                <th className="py-1.5 font-medium">Input tokens</th>
                <th className="py-1.5 font-medium">Output tokens</th>
                <th className="py-1.5 font-medium">Calculated cost</th>
                <th className="py-1.5 font-medium">Last run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usage.projects.map((p) => (
                <tr key={p.projectId}>
                  <td className="py-2 text-ink">{name(p.projectId)}</td>
                  <td className="timecode py-2 text-ink-2">{p.calls}</td>
                  <td className="timecode py-2 text-ink-2">{p.inputTokens.toLocaleString()}</td>
                  <td className="timecode py-2 text-ink-2">{p.outputTokens.toLocaleString()}</td>
                  <td className="timecode py-2 text-ink">
                    {usd(p.estimatedCost)}
                    {config?.softLimit !== undefined && p.estimatedCost >= config.softLimit && (
                      <Badge tone="warning" className="ml-2">
                        Past {usd(config.softLimit)} warning
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 text-ink-3">{p.lastAt ? when(p.lastAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[13px] text-ink-3">No Claude requests yet.</p>
        )}
        {usage && <p className="text-[12px] text-ink-3">{usage.disclaimer}</p>}
      </div>
    </>
  );
}

function ModelInput({ value, options, onCommit }: { value: string; options: string[]; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <>
      <Input
        id="s-model"
        list="s-model-options"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="timecode"
      />
      <datalist id="s-model-options">
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}
