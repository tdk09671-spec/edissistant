import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useData } from '../state/DataProvider';
import { frameRates, resolutions } from '../lib/catalog';
import { isElectron } from '../lib/project';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  LoadingState,
  Notice,
  PageHeader,
  Select,
  SettingRow,
  Toggle,
  Tooltip,
  UnavailableBadge,
  cn,
  useToast,
} from '../components/ui';
import {
  IconBolt,
  IconCheckCircle,
  IconCpu,
  IconFilm,
  IconFolder,
  IconHardDrive,
  IconInfo,
  IconKey,
  IconLock,
  IconSliders,
} from '../components/ui/icons';
import type { AppInfo, AppSettings, SecretStatus } from '../types';

const sections = [
  { id: 'general', label: 'General', icon: IconSliders },
  { id: 'claude', label: 'Claude API', icon: IconKey },
  { id: 'local-ai', label: 'Local AI', icon: IconCpu },
  { id: 'media', label: 'Media & rendering', icon: IconFilm },
  { id: 'storage', label: 'Storage', icon: IconHardDrive },
  { id: 'performance', label: 'Performance', icon: IconBolt },
  { id: 'about', label: 'About', icon: IconInfo },
];

function Section({ id, title, description, badge, children }: { id: string; title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id={`${id}-title`} className="text-[17px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {badge}
      </div>
      {description && <p className="-mt-2 mb-4 max-w-2xl text-[13.5px] leading-relaxed text-ink-3">{description}</p>}
      <Card padding="md" className="divide-y divide-line">
        {children}
      </Card>
    </section>
  );
}

/** Text input that saves when it loses focus (or on Enter) rather than on every keystroke. */
function CommitInput({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export default function Settings() {
  const { settings, saveSettings, loading } = useData();
  const toast = useToast();
  const api = window.electronAPI;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [activeSection, setActiveSection] = useState('general');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api?.getAppInfo().then(setInfo).catch(() => undefined);
    api?.getSecretStatus().then(setSecrets).catch(() => undefined);
  }, [api]);

  // Highlight the section in view
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { root, rootMargin: '0px 0px -65% 0px' }
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [loading]);

  const set = (patch: Partial<AppSettings>) => saveSettings((s) => ({ ...s, ...patch }));
  const setLocalAI = (patch: Partial<AppSettings['localAI']>) => saveSettings((s) => ({ ...s, localAI: { ...s.localAI, ...patch } }));

  const storeKey = async () => {
    if (!api || !apiKey.trim()) return;
    setSavingKey(true);
    try {
      await api.setSecret('claudeApiKey', apiKey.trim());
      setSecrets(await api.getSecretStatus());
      setApiKey('');
      setEditingKey(false);
      toast('API key stored securely');
    } catch (err) {
      toast('Could not store API key', { tone: 'error', description: err instanceof Error ? err.message : String(err) });
    }
    setSavingKey(false);
  };

  const removeKey = async () => {
    if (!api) return;
    await api.deleteSecret('claudeApiKey');
    setSecrets(await api.getSecretStatus());
    toast('API key removed');
  };

  const browseFolder = async (current: string, apply: (path: string) => void) => {
    const folder = await api?.openDirectory({ defaultPath: current || info?.videosPath });
    if (folder) apply(folder);
  };

  if (loading) return <LoadingState label="Loading settings…" />;

  const keyLooksOdd = apiKey.trim().length > 0 && !apiKey.trim().startsWith('sk-ant-');
  const restartNeeded = info && info.hardwareAcceleration !== settings.hardwareAcceleration;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-8 pt-10 pb-24 xl:px-12 xl:pt-12">
        <PageHeader
          eyebrow="Preferences"
          title="Settings"
          description="Changes are saved automatically and stored on this computer."
          actions={
            <span className="flex items-center gap-2 text-[13px] text-ink-3">
              <IconCheckCircle size={16} className="text-success" /> All changes saved
            </span>
          }
        />

        <div className="mt-12 grid grid-cols-[200px_minmax(0,1fr)] gap-10 xl:grid-cols-[220px_minmax(0,1fr)] xl:gap-14">
          <nav aria-label="Settings sections" className="sticky top-0 self-start">
            <ul className="flex flex-col gap-1">
              {sections.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: settings.reduceMotion ? 'auto' : 'smooth', block: 'start' })}
                    className={cn(
                      'flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[13.5px] font-medium transition-colors',
                      activeSection === s.id ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
                    )}
                  >
                    <s.icon size={17} className="shrink-0" />
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-12">
            <Section id="general" title="General">
              <SettingRow title="Auto-save projects" description="Save project changes as you work. When off, use Save or Ctrl+S, and you’ll be asked before leaving with unsaved changes." htmlFor="s-autosave">
                <Toggle id="s-autosave" label="Auto-save projects" checked={settings.autoSave} onChange={(autoSave) => set({ autoSave })} />
              </SettingRow>
              <SettingRow title="Confirm before deleting" description="Ask before deleting projects and presets." htmlFor="s-confirm">
                <Toggle id="s-confirm" label="Confirm before deleting" checked={settings.confirmBeforeDelete} onChange={(confirmBeforeDelete) => set({ confirmBeforeDelete })} />
              </SettingRow>
            </Section>

            <Section
              id="claude"
              title="Claude API"
              description="Used for AI planning and segment suggestions once they are integrated. Your key is encrypted with the operating system’s credential protection and is never written to a plain-text file."
              badge={<UnavailableBadge>Planning not yet integrated</UnavailableBadge>}
            >
              <div className="flex flex-col gap-5 pb-5">
                {!isElectron ? (
                  <Notice icon={<IconLock size={16} />}>Secure key storage is only available in the desktop app.</Notice>
                ) : secrets && !secrets.encryptionAvailable ? (
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
                        <p className="timecode text-[12.5px] text-ink-3">sk-ant-••••••••••••</p>
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
                      storeKey();
                    }}
                  >
                    <Field label="API key" htmlFor="s-apikey" hint={keyLooksOdd ? 'Anthropic keys usually start with sk-ant-. Double-check before saving.' : 'Find it in the Claude Console under API keys.'}>
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
              <SettingRow title="Connection test" description="Checks the key against the API. Arrives together with AI planning.">
                <Tooltip content="Not available in this build">
                  <span tabIndex={0}>
                    <Button size="sm" variant="secondary" disabled>
                      Test connection
                    </Button>
                  </span>
                </Tooltip>
              </SettingRow>
            </Section>

            <Section
              id="local-ai"
              title="Local AI provider"
              description="Optional on-device models for offline work. Saved for later — Edissistant doesn’t contact this endpoint yet."
              badge={<UnavailableBadge>Not yet integrated</UnavailableBadge>}
            >
              <SettingRow title="Use a local model" description="Prefer the local provider when it is available." htmlFor="s-local">
                <Toggle id="s-local" label="Use a local model" checked={settings.localAI.enabled} onChange={(enabled) => setLocalAI({ enabled })} />
              </SettingRow>
              <div className={cn('grid grid-cols-1 gap-5 pt-5 xl:grid-cols-3', !settings.localAI.enabled && 'opacity-50')}>
                <Field label="Provider" htmlFor="s-provider">
                  <Select
                    id="s-provider"
                    disabled={!settings.localAI.enabled}
                    value={settings.localAI.provider}
                    onChange={(e) => {
                      const provider = e.target.value as AppSettings['localAI']['provider'];
                      const endpoint = provider === 'ollama' ? 'http://localhost:11434' : provider === 'lm-studio' ? 'http://localhost:1234/v1' : settings.localAI.endpoint;
                      setLocalAI({ provider, endpoint });
                    }}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lm-studio">LM Studio</option>
                    <option value="custom">Custom (OpenAI-compatible)</option>
                  </Select>
                </Field>
                <Field label="Endpoint" htmlFor="s-endpoint">
                  <CommitInput id="s-endpoint" disabled={!settings.localAI.enabled} value={settings.localAI.endpoint} onCommit={(endpoint) => setLocalAI({ endpoint })} className="timecode" />
                </Field>
                <Field label="Model" htmlFor="s-model">
                  <CommitInput id="s-model" disabled={!settings.localAI.enabled} value={settings.localAI.model} onCommit={(model) => setLocalAI({ model })} placeholder="e.g. llama3.1:8b" />
                </Field>
              </div>
            </Section>

            <Section id="media" title="Media & rendering" description="Defaults for new projects. Each project can override them on its Export tab.">
              <div className="grid grid-cols-1 gap-5 pb-5 xl:grid-cols-2">
                <Field label="Default resolution" htmlFor="s-res">
                  <Select id="s-res" value={settings.defaultResolution} onChange={(e) => set({ defaultResolution: e.target.value })}>
                    {resolutions.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label} — {r.detail}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Default frame rate" htmlFor="s-fps" hint="Used for timecodes and frame stepping.">
                  <Select id="s-fps" value={settings.defaultFrameRate} onChange={(e) => set({ defaultFrameRate: e.target.value })}>
                    {frameRates.map((r) => (
                      <option key={r} value={r}>
                        {r} fps
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="pt-5">
                <Field label="FFmpeg location" optional htmlFor="s-ffmpeg" action={<UnavailableBadge>Used by the render engine</UnavailableBadge>} hint="Leave empty to auto-detect once rendering is available.">
                  <div className="flex gap-2">
                    <CommitInput id="s-ffmpeg" value={settings.ffmpegPath} onCommit={(ffmpegPath) => set({ ffmpegPath })} placeholder="e.g. C:\ffmpeg\bin\ffmpeg.exe" className="timecode min-w-0 flex-1" />
                    <Button
                      variant="secondary"
                      disabled={!isElectron}
                      onClick={async () => {
                        const [file] = (await api?.openFiles({ title: 'Locate FFmpeg' })) ?? [];
                        if (file) set({ ffmpegPath: file });
                      }}
                    >
                      Browse…
                    </Button>
                  </div>
                </Field>
              </div>
            </Section>

            <Section id="storage" title="Storage">
              <div className="flex flex-col gap-2 pb-5">
                <p className="text-sm font-medium text-ink">App data</p>
                <p className="text-[13px] leading-relaxed text-ink-3">
                  Presets, projects and settings are stored as JSON with an automatic backup of the previous save. The API key is kept separately, encrypted.
                </p>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={info?.userDataPath ?? '—'} leading={<IconFolder size={16} />} className="timecode min-w-0 flex-1" aria-label="App data folder" />
                  <Button variant="secondary" disabled={!info} onClick={() => info && api?.openFolder(info.userDataPath)}>
                    Open
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-2 pt-5">
                <p className="text-sm font-medium text-ink">Default output folder</p>
                <p className="text-[13px] text-ink-3">Where exports go unless a project chooses another destination.</p>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={settings.outputDirectory} placeholder={info ? `${info.videosPath}` : 'Not set'} leading={<IconFolder size={16} />} className="timecode min-w-0 flex-1" aria-label="Default output folder" />
                  <Button variant="secondary" disabled={!isElectron} onClick={() => browseFolder(settings.outputDirectory, (outputDirectory) => set({ outputDirectory }))}>
                    Browse…
                  </Button>
                  {settings.outputDirectory && (
                    <Button variant="ghost" onClick={() => set({ outputDirectory: '' })}>
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </Section>

            <Section id="performance" title="Performance">
              <SettingRow
                title={
                  <span className="flex items-center gap-2">
                    Hardware acceleration {restartNeeded && <Badge tone="signal">Restart required</Badge>}
                  </span>
                }
                description="Use the GPU for video decoding and interface rendering. Turn off if playback flickers or shows artefacts."
                htmlFor="s-hw"
              >
                <Toggle id="s-hw" label="Hardware acceleration" checked={settings.hardwareAcceleration} onChange={(hardwareAcceleration) => set({ hardwareAcceleration })} />
              </SettingRow>
              <SettingRow title="Reduce motion" description="Minimise interface animations and transitions." htmlFor="s-motion">
                <Toggle id="s-motion" label="Reduce motion" checked={settings.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
              </SettingRow>
            </Section>

            <section id="about" aria-labelledby="about-title" className="scroll-mt-8">
              <h2 id="about-title" className="mb-4 text-[17px] font-semibold tracking-[-0.015em] text-ink">
                About
              </h2>
              <Card padding="lg" className="flex flex-wrap items-center justify-between gap-8">
                <div className="flex items-center gap-4">
                  <div className="flex size-14 items-center justify-center rounded-[14px] bg-ink text-[24px] font-bold tracking-[-0.04em] text-canvas">E</div>
                  <div>
                    <p className="text-[19px] font-semibold tracking-[-0.02em] text-ink">Edissistant</p>
                    <p className="mt-0.5 text-[13.5px] text-ink-3">For an editor, by an editor.</p>
                  </div>
                </div>
                <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-[13px]">
                  {[
                    ['Version', info?.version ?? '0.1.0'],
                    ['Electron', info?.electron ?? '—'],
                    ['Chromium', info?.chrome ?? '—'],
                    ['Node', info?.node ?? '—'],
                    ['Platform', info?.platform ?? '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-ink-3">{k}</dt>
                      <dd className="timecode text-ink-2">{v}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
