import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useData } from '../state/DataProvider';
import { useNewProject } from '../components/NewProjectModal';
import { UnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { builtInPresets, presetTypeInfo, presetTypes } from '../lib/catalog';
import { fileName, isElectron, mediaUrl } from '../lib/project';
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingState,
  Notice,
  SegmentedControl,
  StepIndicator,
  Textarea,
  cn,
  useToast,
} from '../components/ui';
import {
  IconAlert,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconEdit,
  IconFilm,
  IconLayers,
  IconLink,
  IconPlus,
  IconTrash,
  IconUpload,
} from '../components/ui/icons';
import type { Preset } from '../types';

type PresetForm = Omit<Preset, 'id' | 'createdAt' | 'updatedAt' | 'builtIn'>;

const MAX_LINKS = 3;
const MAX_COLORS = 8;

const emptyPreset: PresetForm = {
  name: '',
  clientName: '',
  type: 'custom',
  referenceLinks: [''],
  referenceFiles: [],
  creativeBrief: '',
  fonts: '',
  tracking: '',
  logoPath: '',
  brandingNotes: '',
  brandColors: [],
};

const steps = [
  { title: 'Identity', description: 'Name the preset and who it is for.' },
  { title: 'References', description: 'Show what “good” looks like for this client.' },
  { title: 'Creative direction', description: 'Brief, typography and brand rules.' },
  { title: 'Review', description: 'Check everything, then save.' },
];

const trackingOptions = [
  { value: 'Tight', em: '-0.03em' },
  { value: 'Normal', em: '0em' },
  { value: 'Wide', em: '0.08em' },
];

function trackingToEm(tracking: string): string {
  const preset = trackingOptions.find((o) => o.value.toLowerCase() === tracking.trim().toLowerCase());
  if (preset) return preset.em;
  const pct = /(-?\d+(?:\.\d+)?)\s*%/.exec(tracking);
  if (pct) return `${parseFloat(pct[1]) / 100}em`;
  if (/tight/i.test(tracking)) return '-0.03em';
  if (/wide|loose/i.test(tracking)) return '0.08em';
  return '0em';
}

function isValidUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toForm(preset: Preset): PresetForm {
  const { id: _id, createdAt: _c, updatedAt: _u, builtIn: _b, ...rest } = preset;
  return {
    ...emptyPreset,
    ...structuredClone(rest),
    referenceLinks: rest.referenceLinks.length ? [...rest.referenceLinks] : [''],
    brandColors: rest.brandColors ?? [],
  };
}

export default function PresetEditor() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const openNewProject = useNewProject();
  const { presets, savePresets, loading } = useData();

  const isNew = !id;
  const existing = id ? presets.find((p) => p.id === id) : undefined;
  const template = builtInPresets.find((p) => p.id === searchParams.get('from'));
  const draftKey = `preset-draft:${id ?? 'new'}:${searchParams.toString()}`;

  const [form, setForm] = useState<PresetForm>(emptyPreset);
  const initialRef = useRef<string>(JSON.stringify(emptyPreset));
  const [initialised, setInitialised] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initialise once data is loaded
  useEffect(() => {
    if (loading || initialised) return;
    let base: PresetForm = emptyPreset;
    if (existing) base = toForm(existing);
    else if (template) base = { ...toForm(template), name: `${template.name} — custom` };
    else {
      const typeParam = searchParams.get('type');
      if (typeParam && presetTypes.some((t) => t.value === typeParam)) base = { ...emptyPreset, type: typeParam as Preset['type'] };
    }
    initialRef.current = JSON.stringify(base);

    let restored: PresetForm | null = null;
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) restored = JSON.parse(raw);
    } catch {
      restored = null;
    }
    if (restored && JSON.stringify(restored) !== initialRef.current) {
      setForm(restored);
      setRestoredDraft(true);
    } else {
      setForm(base);
    }
    if (existing) setMaxStep(steps.length - 1);
    setInitialised(true);
  }, [loading, initialised, existing, template, searchParams, draftKey]);

  const dirty = initialised && JSON.stringify(form) !== initialRef.current;

  // Keep an in-session draft so accidental navigation away never loses work
  useEffect(() => {
    if (!initialised) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(form));
      else sessionStorage.removeItem(draftKey);
    } catch {
      // Session storage unavailable
    }
  }, [form, dirty, initialised, draftKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const update = <K extends keyof PresetForm>(key: K, value: PresetForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'A preset name is required.';
    form.referenceLinks.forEach((link, i) => {
      if (link.trim() && !isValidUrl(link)) e[`link${i}`] = 'Enter a full URL starting with https://';
    });
    return e;
  }, [form]);

  const stepErrors = (index: number) =>
    Object.keys(errors).filter((k) => (index === 0 ? k === 'name' : index === 1 ? k.startsWith('link') : false));

  const goTo = (index: number) => {
    if (index > step) {
      for (let i = step; i < index; i++) {
        if (stepErrors(i).length) {
          setShowErrors(true);
          setStep(i);
          return;
        }
      }
    }
    setShowErrors(false);
    setStep(index);
    setMaxStep((m) => Math.max(m, index));
  };

  const clearDraft = () => {
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      // ignore
    }
  };

  const handleSave = async (thenStartProject = false) => {
    const firstInvalid = [0, 1].find((i) => stepErrors(i).length);
    if (firstInvalid !== undefined) {
      setShowErrors(true);
      setStep(firstInvalid);
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const clean: PresetForm = {
      ...form,
      name: form.name.trim(),
      clientName: form.clientName.trim(),
      referenceLinks: form.referenceLinks.map((l) => l.trim()).filter(Boolean),
    };
    let savedId = id;
    if (isNew || !existing) {
      savedId = uuid();
      await savePresets((all) => [...all, { ...clean, id: savedId!, createdAt: now, updatedAt: now }]);
    } else {
      await savePresets((all) => all.map((p) => (p.id === id ? { ...p, ...clean, updatedAt: now } : p)));
    }
    clearDraft();
    savedRef.current = true;
    initialRef.current = JSON.stringify(form);
    setSaving(false);
    toast(isNew ? 'Preset created' : 'Preset saved', { description: clean.name });
    navigate('/presets');
    if (thenStartProject && savedId) openNewProject({ presetId: savedId });
  };

  const leave = () => navigate('/presets');

  if (loading || !initialised) return <LoadingState label="Loading preset…" />;

  if (id && !existing) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={<IconLayers size={22} />}
          title="Preset not found"
          description="It may have been deleted. Your other presets are unaffected."
          action={
            <Button variant="primary" onClick={() => navigate('/presets')}>
              Back to presets
            </Button>
          }
        />
      </div>
    );
  }

  const linkCount = form.referenceLinks.filter((l) => l.trim()).length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-line bg-canvas">
        <div className="mx-auto w-full max-w-[1280px] px-8 pt-8 pb-6 xl:px-12">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <button
              type="button"
              onClick={leave}
              className="-ml-2 inline-flex h-9 items-center gap-2 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink"
            >
              <IconArrowLeft size={16} /> Presets
            </button>
            {dirty && <span className="text-[12.5px] text-ink-3">Unsaved changes</span>}
          </div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <div className="min-w-0">
              <h1 className="truncate text-title font-semibold text-ink">
                {isNew ? (template ? `Customise “${template.name}”` : 'New preset') : form.name || 'Edit preset'}
              </h1>
              <p className="mt-2 text-[14px] text-ink-3">
                Step {step + 1} of {steps.length} — {steps[step].description}
              </p>
            </div>
          </div>
          <div className="mt-7">
            <StepIndicator steps={steps} current={step} maxReachable={maxStep} onSelect={goTo} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-10 px-8 py-10 xl:grid-cols-[minmax(0,1fr)_340px] xl:px-12">
          <div className="min-w-0 max-w-[760px]">
            {restoredDraft && (
              <Notice
                tone="signal"
                icon={<IconEdit size={17} />}
                title="Unsaved draft restored"
                className="mb-8"
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setForm(JSON.parse(initialRef.current));
                      setRestoredDraft(false);
                      clearDraft();
                    }}
                  >
                    Discard draft
                  </Button>
                }
              >
                We kept the changes you made before leaving this page.
              </Notice>
            )}

            {step === 0 && (
              <div className="flex flex-col gap-8">
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <Field label="Preset name" required htmlFor="preset-name" error={showErrors ? errors.name : undefined} hint="Shown when you pick a preset for a new project.">
                    <Input
                      id="preset-name"
                      autoFocus
                      value={form.name}
                      invalid={showErrors && Boolean(errors.name)}
                      onChange={(e) => update('name', e.target.value)}
                      placeholder="e.g. Northwind — product reels"
                    />
                  </Field>
                  <Field label="Client" optional htmlFor="preset-client" hint="Filled in automatically on new projects.">
                    <Input id="preset-client" value={form.clientName} onChange={(e) => update('clientName', e.target.value)} placeholder="e.g. Northwind" />
                  </Field>
                </div>
                <Field label="Category">
                  <div role="radiogroup" aria-label="Category" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {presetTypes.map((t) => {
                      const selected = form.type === t.value;
                      return (
                        <button
                          key={t.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => update('type', t.value)}
                          className={cn(
                            'flex items-start gap-4 rounded-[14px] border p-4 text-left transition-colors',
                            selected ? 'border-signal/60 bg-signal-soft' : 'border-line bg-surface-2 hover:border-line-strong'
                          )}
                        >
                          <span
                            className={cn(
                              'flex size-10 shrink-0 items-center justify-center rounded-[11px] border',
                              selected ? 'border-signal/40 text-signal' : 'border-line-strong text-ink-2'
                            )}
                          >
                            {t.icon(18)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2 text-sm font-medium text-ink">
                              {t.label}
                              {selected && <IconCheck size={16} strokeWidth={2.2} className="text-signal" />}
                            </span>
                            <span className="mt-1 block text-[13px] leading-relaxed text-ink-3">{t.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>
            )}

            {step === 1 && (
              <div className="flex flex-col gap-10">
                <Field
                  label="Reference video links"
                  optional
                  hint={`Up to ${MAX_LINKS} links — YouTube, Vimeo, Instagram, Frame.io or any public URL.`}
                >
                  <div className="flex flex-col gap-3">
                    {form.referenceLinks.map((link, i) => (
                      <div key={i} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <Input
                            aria-label={`Reference link ${i + 1}`}
                            value={link}
                            invalid={showErrors && Boolean(errors[`link${i}`])}
                            leading={<IconLink size={16} />}
                            onChange={(e) => {
                              const links = [...form.referenceLinks];
                              links[i] = e.target.value;
                              update('referenceLinks', links);
                            }}
                            onBlur={() => link.trim() && setShowErrors(true)}
                            placeholder="https://"
                            className="flex-1"
                          />
                          <IconButton
                            label="Remove link"
                            variant="danger"
                            disabled={form.referenceLinks.length === 1 && !link}
                            onClick={() => {
                              const next = form.referenceLinks.filter((_, idx) => idx !== i);
                              update('referenceLinks', next.length ? next : ['']);
                            }}
                          >
                            <IconTrash size={17} />
                          </IconButton>
                        </div>
                        {showErrors && errors[`link${i}`] && <p className="text-[13px] text-danger">{errors[`link${i}`]}</p>}
                      </div>
                    ))}
                    {form.referenceLinks.length < MAX_LINKS && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconPlus size={16} />}
                        className="self-start"
                        onClick={() => update('referenceLinks', [...form.referenceLinks, ''])}
                      >
                        Add link
                      </Button>
                    )}
                  </div>
                </Field>

                <Field label="Local reference files" optional hint="Videos and images stay where they are on disk; Edissistant only stores their location. Videos are never uploaded. An image is sent to Claude only if you tick it for a run.">
                  <div className="flex flex-col gap-2.5">
                    {form.referenceFiles.map((file) => (
                      <div key={file} className="flex min-h-14 items-center gap-3.5 rounded-[12px] border border-line bg-surface-2 py-2 pr-2 pl-4">
                        <IconFilm size={18} className="shrink-0 text-ink-3" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink">{fileName(file)}</p>
                          <p className="truncate text-[12.5px] text-ink-3" title={file}>
                            {file}
                          </p>
                        </div>
                        {isElectron && (
                          <Button size="sm" variant="ghost" onClick={() => window.electronAPI?.showItemInFolder(file).catch(() => toast('File not found', { tone: 'error', description: file }))}>
                            Reveal
                          </Button>
                        )}
                        <IconButton label="Remove file" variant="danger" onClick={() => update('referenceFiles', form.referenceFiles.filter((f) => f !== file))}>
                          <IconTrash size={17} />
                        </IconButton>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={!isElectron}
                      onClick={async () => {
                        const files = await window.electronAPI?.openFiles({ kind: 'reference', multiple: true, title: 'Select reference videos or images' });
                        if (files?.length) update('referenceFiles', Array.from(new Set([...form.referenceFiles, ...files])));
                      }}
                      className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-line-strong text-[13.5px] text-ink-2 transition-colors hover:border-ink-4 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <IconUpload size={20} />
                      {isElectron ? 'Choose videos or images…' : 'File selection is available in the desktop app'}
                    </button>
                  </div>
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col gap-10">
                <Field label="Creative brief" htmlFor="brief" hint="Style, tone, pacing, transitions — what an editor needs to know before the first cut.">
                  <Textarea
                    id="brief"
                    rows={7}
                    value={form.creativeBrief}
                    onChange={(e) => update('creativeBrief', e.target.value)}
                    placeholder="e.g. Fast, punchy cuts on the beat. Kinetic captions on key phrases. Clean white backgrounds, no lens flares…"
                  />
                </Field>

                <section className="flex flex-col gap-6">
                  <h2 className="eyebrow">Typography</h2>
                  <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
                    <Field label="Fonts" htmlFor="fonts" hint="Separate with commas; the first is used for the preview.">
                      <Input id="fonts" value={form.fonts} onChange={(e) => update('fonts', e.target.value)} placeholder="e.g. Helvetica Now, Montserrat" />
                    </Field>
                    <Field label="Letter spacing">
                      <div className="flex flex-col gap-3">
                        <SegmentedControl
                          label="Letter spacing"
                          fullWidth
                          value={trackingOptions.some((o) => o.value === form.tracking) ? form.tracking : form.tracking ? 'Custom' : 'Normal'}
                          onChange={(v) => update('tracking', v === 'Custom' ? '0%' : v)}
                          options={[...trackingOptions.map((o) => ({ value: o.value, label: o.value })), { value: 'Custom', label: 'Custom' }]}
                        />
                        {form.tracking && !trackingOptions.some((o) => o.value === form.tracking) && (
                          <Input aria-label="Custom letter spacing" value={form.tracking} onChange={(e) => update('tracking', e.target.value)} placeholder="e.g. -2% or 0.05em" inputSize="sm" />
                        )}
                      </div>
                    </Field>
                  </div>
                  <div className="overflow-hidden rounded-[14px] border border-line bg-surface-1 px-6 py-7">
                    <p className="eyebrow mb-3">Preview</p>
                    <p
                      className="truncate text-[34px] leading-tight font-semibold text-ink"
                      style={{ fontFamily: form.fonts ? `${form.fonts.split(',')[0].trim()}, var(--font-sans)` : undefined, letterSpacing: trackingToEm(form.tracking) }}
                    >
                      For an editor, by an editor.
                    </p>
                    <p className="mt-2 text-[12.5px] text-ink-3">Renders with the font if it is installed on this computer.</p>
                  </div>
                </section>

                <section className="flex flex-col gap-6">
                  <h2 className="eyebrow">Brand</h2>
                  <Field label="Brand colours" optional hint={`Up to ${MAX_COLORS} colours. Click a swatch to change it.`}>
                    <div className="flex flex-wrap items-center gap-2.5">
                      {(form.brandColors ?? []).map((color, i) => (
                        <div key={i} className="flex h-11 items-center gap-2 rounded-full border border-line-strong bg-surface-2 pr-1.5 pl-1.5">
                          <label className="relative size-8 cursor-pointer overflow-hidden rounded-full border border-line-strong" style={{ background: color }}>
                            <input
                              type="color"
                              aria-label={`Brand colour ${i + 1}`}
                              value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'}
                              onChange={(e) => {
                                const next = [...(form.brandColors ?? [])];
                                next[i] = e.target.value.toUpperCase();
                                update('brandColors', next);
                              }}
                              className="absolute inset-0 cursor-pointer opacity-0"
                            />
                          </label>
                          <span className="timecode text-[13px] text-ink-2">{color.toUpperCase()}</span>
                          <IconButton
                            label={`Remove colour ${color}`}
                            size="sm"
                            variant="danger"
                            onClick={() => update('brandColors', (form.brandColors ?? []).filter((_, idx) => idx !== i))}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </div>
                      ))}
                      {(form.brandColors ?? []).length < MAX_COLORS && (
                        <Button variant="ghost" size="sm" icon={<IconPlus size={16} />} onClick={() => update('brandColors', [...(form.brandColors ?? []), '#E9A94B'])}>
                          Add colour
                        </Button>
                      )}
                    </div>
                  </Field>

                  <Field label="Logo" optional hint="PNG, JPG, SVG or WebP. Stored by file location.">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-line-strong bg-surface-1">
                        {form.logoPath && isElectron ? (
                          <img src={mediaUrl(form.logoPath)} alt="Logo preview" className="max-h-full max-w-full object-contain p-2" />
                        ) : (
                          <span className="text-[12px] text-ink-4">No logo</span>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        {form.logoPath && (
                          <p className="truncate text-[13px] text-ink-2" title={form.logoPath}>
                            {fileName(form.logoPath)}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!isElectron}
                            onClick={async () => {
                              const [file] = (await window.electronAPI?.openFiles({ kind: 'image', title: 'Select logo' })) ?? [];
                              if (file) update('logoPath', file);
                            }}
                          >
                            {form.logoPath ? 'Replace' : 'Choose image…'}
                          </Button>
                          {form.logoPath && (
                            <Button size="sm" variant="ghost" onClick={() => update('logoPath', '')}>
                              Remove
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </Field>

                  <Field label="Branding notes" optional htmlFor="branding-notes">
                    <Textarea
                      id="branding-notes"
                      rows={4}
                      value={form.brandingNotes}
                      onChange={(e) => update('brandingNotes', e.target.value)}
                      placeholder="Logo usage, safe areas, colour rules, words to avoid…"
                    />
                  </Field>
                </section>
              </div>
            )}

            {step === 3 && (
              <div className="flex flex-col gap-4">
                <ReviewSection title="Identity" onEdit={() => goTo(0)}>
                  <ReviewRow label="Name" value={form.name} required />
                  <ReviewRow label="Client" value={form.clientName} />
                  <ReviewRow label="Category" value={presetTypeInfo(form.type).label} />
                </ReviewSection>
                <ReviewSection title="References" onEdit={() => goTo(1)}>
                  <ReviewRow
                    label="Links"
                    value={
                      linkCount ? (
                        <ul className="flex flex-col gap-1">
                          {form.referenceLinks.filter((l) => l.trim()).map((l) => (
                            <li key={l} className="truncate">
                              {l}
                            </li>
                          ))}
                        </ul>
                      ) : null
                    }
                  />
                  <ReviewRow
                    label="Files"
                    value={
                      form.referenceFiles.length ? (
                        <ul className="flex flex-col gap-1">
                          {form.referenceFiles.map((f) => (
                            <li key={f} className="truncate" title={f}>
                              {fileName(f)}
                            </li>
                          ))}
                        </ul>
                      ) : null
                    }
                  />
                </ReviewSection>
                <ReviewSection title="Creative direction" onEdit={() => goTo(2)}>
                  <ReviewRow label="Brief" value={form.creativeBrief ? <span className="whitespace-pre-line">{form.creativeBrief}</span> : null} />
                  <ReviewRow label="Fonts" value={form.fonts} />
                  <ReviewRow label="Letter spacing" value={form.tracking} />
                  <ReviewRow
                    label="Colours"
                    value={
                      form.brandColors?.length ? (
                        <span className="flex flex-wrap gap-2">
                          {form.brandColors.map((c, i) => (
                            <span key={i} className="flex items-center gap-1.5">
                              <span className="size-4 rounded-full border border-line-strong" style={{ background: c }} />
                              <span className="timecode text-[12.5px]">{c}</span>
                            </span>
                          ))}
                        </span>
                      ) : null
                    }
                  />
                  <ReviewRow label="Logo" value={form.logoPath ? fileName(form.logoPath) : null} />
                  <ReviewRow label="Notes" value={form.brandingNotes ? <span className="whitespace-pre-line">{form.brandingNotes}</span> : null} />
                </ReviewSection>
                {Object.keys(errors).length > 0 && (
                  <Notice tone="danger" icon={<IconAlert size={17} />} title="A few things need attention">
                    {errors.name ? 'Add a preset name in Identity. ' : ''}
                    {Object.keys(errors).some((k) => k.startsWith('link')) ? 'Fix the invalid reference link in References.' : ''}
                  </Notice>
                )}
              </div>
            )}
          </div>

          {/* Live summary */}
          <aside className="hidden xl:block">
            <div className="sticky top-0 flex flex-col gap-4">
              <p className="eyebrow">Preset card</p>
              <Card padding="md" className="flex flex-col gap-5">
                <div className="flex items-start gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-line-strong bg-surface-1 text-ink-2">
                    {presetTypeInfo(form.type).icon(19)}
                  </span>
                  <div className="min-w-0">
                    <p className={cn('truncate text-[15px] font-medium', form.name ? 'text-ink' : 'text-ink-4')}>{form.name || 'Untitled preset'}</p>
                    <p className="truncate text-[13px] text-ink-3">{form.clientName || 'No client'}</p>
                  </div>
                </div>
                <p className={cn('line-clamp-4 text-[13.5px] leading-relaxed', form.creativeBrief ? 'text-ink-2' : 'text-ink-4')}>
                  {form.creativeBrief || 'Your creative brief will appear here.'}
                </p>
                <dl className="flex flex-col gap-2.5 border-t border-line pt-4 text-[13px]">
                  <SummaryRow label="Category" value={presetTypeInfo(form.type).label} />
                  <SummaryRow label="References" value={String(linkCount + form.referenceFiles.length)} />
                  <SummaryRow label="Fonts" value={form.fonts || '—'} />
                  <SummaryRow label="Colours" value={form.brandColors?.length ? String(form.brandColors.length) : '—'} />
                </dl>
              </Card>
            </div>
          </aside>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-line bg-surface-1">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-8 py-4 xl:px-12">
          <Button variant="ghost" onClick={leave} disabled={saving}>
            Cancel
          </Button>
          <div className="flex items-center gap-3">
            {step > 0 && (
              <Button variant="secondary" icon={<IconArrowLeft size={16} />} onClick={() => goTo(step - 1)} disabled={saving}>
                Back
              </Button>
            )}
            {!isNew && step < steps.length - 1 && (
              <Button variant="secondary" onClick={() => handleSave()} loading={saving} disabled={!dirty}>
                Save changes
              </Button>
            )}
            {step < steps.length - 1 ? (
              <Button variant="primary" iconRight={<IconArrowRight size={16} />} onClick={() => goTo(step + 1)}>
                Continue
              </Button>
            ) : (
              <>
                {isNew && (
                  <Button variant="secondary" onClick={() => handleSave(true)} disabled={saving}>
                    Save &amp; start project
                  </Button>
                )}
                <Button variant="primary" icon={<IconCheck size={16} strokeWidth={2.2} />} onClick={() => handleSave()} loading={saving}>
                  {isNew ? 'Save preset' : 'Save changes'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <UnsavedChangesGuard when={dirty && !saving && !savedRef.current} description="Your edits to this preset have not been saved. A draft is kept for this session." />
    </div>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <Card padding="md">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <Button size="sm" variant="ghost" icon={<IconEdit size={15} />} onClick={onEdit}>
          Edit
        </Button>
      </div>
      <dl className="flex flex-col divide-y divide-line">{children}</dl>
    </Card>
  );
}

function ReviewRow({ label, value, required }: { label: string; value: ReactNode; required?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className={cn('min-w-0 text-[13.5px] break-words', empty ? (required ? 'text-danger' : 'text-ink-4') : 'text-ink')}>
        {empty ? (required ? 'Required' : 'Not set') : value}
      </dd>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 truncate text-right text-ink-2">{value}</dd>
    </div>
  );
}
