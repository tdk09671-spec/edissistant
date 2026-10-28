import type { ExportFormat, ExportSettings } from '../types';
import { resolutions } from '../lib/catalog';
import { Badge, Button, Card, Notice, Tooltip, UnavailableBadge } from './ui';
import { IconInfo, IconLock } from './ui/icons';

export const exportFormats: Array<{ value: ExportFormat; title: string; description: string; container: string }> = [
  {
    value: 'full-motion',
    title: 'Full motion graphics',
    description: 'Finished edit with graphics composited over the background footage.',
    container: 'H.264 / ProRes 422 · MP4 or MOV',
  },
  {
    value: 'transparent-motion',
    title: 'Transparent motion graphics',
    description: 'Graphics only, with alpha, to drop onto your own timeline in Premiere, Resolve or FCP.',
    container: 'ProRes 4444 · MOV with alpha',
  },
  {
    value: 'transparent-captions',
    title: 'Transparent captions',
    description: 'Caption layer only, with alpha, synced to the sequence timing.',
    container: 'ProRes 4444 · MOV with alpha',
  },
];

/** Summary and render action. Rendering is not implemented in this build and is shown as unavailable. */
export function ExportPanel({ settings }: { settings: ExportSettings }) {
  const format = exportFormats.find((f) => f.value === settings.format)!;
  const res = resolutions.find((r) => r.value === settings.resolution);
  const rows: Array<[string, string]> = [
    ['Output', format.title],
    ['Format', format.container],
    ['Resolution', res ? `${res.label} · ${res.detail}` : settings.resolution],
    ['Frame rate', `${settings.frameRate} fps`],
    ['File name', settings.fileName || '—'],
    ['Destination', settings.destination || 'Not set'],
  ];

  return (
    <Card padding="md" className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">Render</h2>
        <UnavailableBadge>Engine not installed</UnavailableBadge>
      </div>
      <dl className="flex flex-col divide-y divide-line">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2.5 first:pt-0 last:pb-0 text-[13px]">
            <dt className="text-ink-3">{label}</dt>
            <dd className="min-w-0 break-words text-ink-2" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <Notice tone="neutral" icon={<IconInfo size={16} />} title="Rendering is not part of this build">
        The motion-graphics and FFmpeg render pipeline hasn’t been integrated yet, so no video files are produced. Your export settings are saved with the
        project and will be used once rendering is available.
      </Notice>

      <div className="flex items-center justify-between text-[13px] text-ink-3">
        <span>Render queue</span>
        <Badge tone="outline">Empty</Badge>
      </div>

      <Tooltip content="Available once the render engine is integrated.">
        <span tabIndex={0} className="block">
          <Button variant="primary" size="lg" icon={<IconLock size={16} />} disabled className="w-full">
            Start render
          </Button>
        </span>
      </Tooltip>
    </Card>
  );
}
