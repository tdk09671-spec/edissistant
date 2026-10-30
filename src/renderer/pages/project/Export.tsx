import { useProject } from '../ProjectEditor';
import { useData } from '../../state/DataProvider';
import { ExportPanel, exportFormats } from '../../components/ExportPanel';
import { frameRates, resolutions } from '../../lib/catalog';
import { segmentsToCsv, segmentsToSrt } from '../../lib/captions';
import { defaultExportSettings, getSegments, isElectron } from '../../lib/project';
import { Button, Card, Field, Input, SectionHeader, SegmentedControl, Select, SettingRow, Toggle, cn, useToast } from '../../components/ui';
import { IconCheck, IconDownload, IconFolder, IconText } from '../../components/ui/icons';
import type { ExportSettings } from '../../types';

export default function Export() {
  const { project, update, pipeline } = useProject();
  const { settings: appSettings } = useData();
  const toast = useToast();
  const settings = defaultExportSettings(project, appSettings);
  const segments = getSegments(project);
  const hasTranscript = segments.some((s) => s.transcript.trim());

  const set = (patch: Partial<ExportSettings>) => update((p) => ({ ...p, exportSettings: { ...settings, ...patch } }));

  const chooseFolder = async () => {
    const folder = await window.electronAPI?.openDirectory({ title: 'Choose export destination', defaultPath: settings.destination || undefined });
    if (folder) set({ destination: folder });
  };

  const saveText = async (content: string, ext: string, label: string) => {
    if (!window.electronAPI) return;
    const base = settings.fileName || project.name;
    const sep = settings.destination.includes('\\') ? '\\' : '/';
    try {
      const saved = await window.electronAPI.saveTextFile({
        defaultPath: settings.destination ? `${settings.destination}${sep}${base}.${ext}` : `${base}.${ext}`,
        content,
        extensions: [ext],
        name: label,
      });
      if (saved) toast(`${label} exported`, { description: saved });
    } catch (err) {
      toast('Export failed', { tone: 'error', description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-8 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_340px] xl:px-8 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-10">
          <section>
            <SectionHeader title="Output" description="Choose what to deliver. Alpha outputs are for compositing in your own NLE." />
            <div role="radiogroup" aria-label="Output type" className="mt-5 flex flex-col gap-3">
              {exportFormats.map((f) => {
                const selected = settings.format === f.value;
                const transparent = f.value !== 'full-motion';
                return (
                  <button
                    key={f.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set({ format: f.value })}
                    className={cn(
                      'relative flex items-center gap-5 rounded-[16px] border p-4 pr-5 text-left transition-colors',
                      selected ? 'border-signal/60 bg-signal-soft' : 'border-line bg-surface-2 hover:border-line-strong'
                    )}
                  >
                    <div
                      className={cn('flex h-[72px] w-[128px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] border', selected ? 'border-signal/30' : 'border-line')}
                      style={
                        transparent
                          ? { backgroundImage: 'conic-gradient(#1d1f25 25%, #16171c 0 50%, #1d1f25 0 75%, #16171c 0)', backgroundSize: '14px 14px' }
                          : { background: 'linear-gradient(135deg, #2a2c33, #16171c)' }
                      }
                    >
                      {f.value === 'transparent-captions' ? (
                        <span className="rounded-[4px] bg-black/60 px-2 py-0.5 text-[12px] font-semibold text-ink">Caption line</span>
                      ) : (
                        <span className="h-3 w-16 rounded-full bg-signal/80" />
                      )}
                    </div>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-[14.5px] font-medium text-ink">{f.title}</span>
                      </span>
                      <span className="text-[13px] leading-relaxed text-ink-3">{f.description}</span>
                      <span className="timecode text-[12.5px] text-ink-3">{f.container}</span>
                    </span>
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full border',
                        selected ? 'border-signal bg-signal text-signal-ink' : 'border-line-strong'
                      )}
                    >
                      {selected && <IconCheck size={14} strokeWidth={2.6} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <SectionHeader title="Format" />
            <div className="mt-5 flex flex-col gap-6">
              <Field label="Resolution">
                <SegmentedControl
                  label="Resolution"
                  value={settings.resolution}
                  onChange={(resolution) => set({ resolution })}
                  options={resolutions.map((r) => ({ value: r.value, label: r.label, title: r.detail }))}
                />
              </Field>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Field label="Frame rate" htmlFor="fps" hint="Also used for timecode display in this project.">
                  <Select id="fps" value={settings.frameRate} onChange={(e) => set({ frameRate: e.target.value })}>
                    {frameRates.map((r) => (
                      <option key={r} value={r}>
                        {r} fps
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="File name" htmlFor="export-name">
                  <Input id="export-name" value={settings.fileName} onChange={(e) => set({ fileName: e.target.value.replace(/[\\/:*?"<>|]+/g, '') })} />
                </Field>
              </div>
              <SettingRow
                title="Allow a fallback font"
                htmlFor="font-fallback"
                description="When a brand font from the preset isn't installed, render with a generic font instead of stopping. Off by default, so a missing font is never replaced silently."
              >
                <Toggle id="font-fallback" label="Allow a fallback font" checked={settings.allowFontFallback === true} onChange={(allowFontFallback) => set({ allowFontFallback })} />
              </SettingRow>
              <Field label="Destination" hint={appSettings.outputDirectory && !project.exportSettings?.destination ? 'Using the default output folder from Settings.' : undefined}>
                <div className="flex gap-2">
                  <Input readOnly value={settings.destination} placeholder="Choose a folder" leading={<IconFolder size={16} />} className="min-w-0 flex-1" />
                  <Button variant="secondary" onClick={chooseFolder} disabled={!isElectron}>
                    Browse…
                  </Button>
                  {settings.destination && isElectron && (
                    <Button variant="ghost" onClick={() => window.electronAPI?.openFolder(settings.destination).catch(() => toast('Folder not found', { tone: 'error' }))}>
                      Open
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </section>

          <section>
            <SectionHeader title="Available now" description="Hand-off files you can export today, straight from the sequence." />
            <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
              <Card padding="sm" className="flex items-start gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line-strong text-ink-2">
                  <IconDownload size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">Edit plan (CSV)</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">Timecodes, transcript, visual modes, instructions and statuses — opens in Sheets or Excel.</p>
                  <Button size="sm" variant="secondary" className="mt-3" disabled={!segments.length || !isElectron} onClick={() => saveText(segmentsToCsv(segments), 'csv', 'Edit plan')}>
                    Export CSV…
                  </Button>
                </div>
              </Card>
              <Card padding="sm" className="flex items-start gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line-strong text-ink-2">
                  <IconText size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">Captions (SRT)</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">Subtitle file from segment transcripts. Import it into any NLE as a caption track.</p>
                  <Button size="sm" variant="secondary" className="mt-3" disabled={!hasTranscript || !isElectron} onClick={() => saveText(segmentsToSrt(segments), 'srt', 'Captions')}>
                    Export SRT…
                  </Button>
                </div>
              </Card>
            </div>
            {!segments.length && <p className="mt-3 text-[13px] text-ink-3">Add segments in the Edit tab to enable these exports.</p>}
          </section>
        </div>

        <aside className="min-w-0">
          <div className="lg:sticky lg:top-0">
            <ExportPanel settings={settings} project={project} pipeline={pipeline} />
          </div>
        </aside>
      </div>
    </div>
  );
}
