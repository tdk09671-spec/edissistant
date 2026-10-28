import type { ReactNode } from 'react';
import type { Preset, PresetType, ProjectStatus, SegmentStatus, VisualMode } from '../types';
import { IconCube, IconMic, IconPalette, IconUser } from '../components/ui/icons';

export const presetTypes: Array<{ value: PresetType; label: string; description: string; icon: (size?: number) => ReactNode }> = [
  {
    value: 'product-animation',
    label: 'Product Animation',
    description: 'Clean product showcases with kinetic type and motion graphics.',
    icon: (size = 20) => <IconCube size={size} />,
  },
  {
    value: 'podcast-trailer',
    label: 'Podcast Trailer',
    description: 'Hook-first trailers with captions, waveforms and speaker cards.',
    icon: (size = 20) => <IconMic size={size} />,
  },
  {
    value: 'talking-head-intro',
    label: 'Talking Head Intro',
    description: 'Branded intros, lower thirds and punch-in B-roll for creators.',
    icon: (size = 20) => <IconUser size={size} />,
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Your own direction, references and brand rules.',
    icon: (size = 20) => <IconPalette size={size} />,
  },
];

export function presetTypeInfo(type: PresetType | undefined) {
  return presetTypes.find((t) => t.value === type) ?? presetTypes[3];
}

const BUILT_IN_DATE = '2026-01-01T00:00:00.000Z';

/** Starting points that ship with Edissistant. Never persisted; "Use template" creates an editable copy. */
export const builtInPresets: Preset[] = [
  {
    id: 'builtin-product-animation',
    builtIn: true,
    name: 'Product Animation',
    clientName: '',
    type: 'product-animation',
    referenceLinks: [],
    referenceFiles: [],
    creativeBrief:
      'Premium, minimal product reveal. Slow push-ins, macro detail shots and clean kinetic typography. Let the product breathe — negative space over clutter. Cuts land on the beat.',
    fonts: 'Geist, Inter',
    tracking: 'Tight (-2%)',
    logoPath: '',
    brandingNotes: 'Monochrome base with a single accent colour. Logo lockup only on the final card.',
    brandColors: ['#0C0D10', '#F3F1EA'],
    createdAt: BUILT_IN_DATE,
    updatedAt: BUILT_IN_DATE,
  },
  {
    id: 'builtin-podcast-trailer',
    builtIn: true,
    name: 'Podcast Trailer',
    clientName: '',
    type: 'podcast-trailer',
    referenceLinks: [],
    referenceFiles: [],
    creativeBrief:
      'Open on the strongest hook in the first three seconds. Word-synced captions, speaker name cards and subtle audio-reactive accents. 30–60 seconds, vertical and horizontal cut-downs.',
    fonts: 'Geist',
    tracking: 'Normal',
    logoPath: '',
    brandingNotes: 'Show artwork on the end card with the episode number and release date.',
    brandColors: ['#111216', '#E9A94B'],
    createdAt: BUILT_IN_DATE,
    updatedAt: BUILT_IN_DATE,
  },
  {
    id: 'builtin-talking-head-intro',
    builtIn: true,
    name: 'Talking Head Intro',
    clientName: '',
    type: 'talking-head-intro',
    referenceLinks: [],
    referenceFiles: [],
    creativeBrief:
      'Confident creator intro. Punch-in zooms on emphasis, B-roll cutaways for every concrete noun, lower third on first appearance and bold keyword captions.',
    fonts: 'Geist',
    tracking: 'Tight (-1%)',
    logoPath: '',
    brandingNotes: 'Keep lower thirds in the safe area. Captions centred, two lines maximum.',
    brandColors: ['#16171C', '#86A8E3'],
    createdAt: BUILT_IN_DATE,
    updatedAt: BUILT_IN_DATE,
  },
];

export const projectStatuses: Array<{ value: ProjectStatus; label: string; tone: 'neutral' | 'signal' | 'success' }> = [
  { value: 'draft', label: 'Draft', tone: 'neutral' },
  { value: 'in-progress', label: 'In progress', tone: 'signal' },
  { value: 'completed', label: 'Completed', tone: 'success' },
];

export function projectStatusInfo(status: ProjectStatus) {
  return projectStatuses.find((s) => s.value === status) ?? projectStatuses[0];
}

export const visualModes: Array<{ value: VisualMode; label: string; short: string; color: string }> = [
  { value: 'speaker', label: 'Speaker', short: 'Speaker', color: 'var(--color-mode-speaker)' },
  { value: 'b-roll', label: 'B-roll', short: 'B-roll', color: 'var(--color-mode-broll)' },
  { value: 'motion-graphics', label: 'Motion graphics', short: 'Motion', color: 'var(--color-mode-motion)' },
  { value: 'captions', label: 'Captions', short: 'Captions', color: 'var(--color-mode-captions)' },
];

export function visualModeInfo(mode: VisualMode) {
  return visualModes.find((m) => m.value === mode) ?? visualModes[0];
}

export const segmentStatuses: Array<{ value: SegmentStatus; label: string; tone: 'neutral' | 'success' | 'warning' }> = [
  { value: 'pending', label: 'Pending', tone: 'neutral' },
  { value: 'approved', label: 'Approved', tone: 'success' },
  { value: 'needs-revision', label: 'Needs revision', tone: 'warning' },
];

export function segmentStatusInfo(status: SegmentStatus) {
  return segmentStatuses.find((s) => s.value === status) ?? segmentStatuses[0];
}

export const resolutions = [
  { value: '1920x1080', label: '1080p', detail: '1920 × 1080' },
  { value: '3840x2160', label: '4K UHD', detail: '3840 × 2160' },
  { value: '1080x1920', label: 'Vertical', detail: '1080 × 1920' },
  { value: '1080x1350', label: 'Portrait', detail: '1080 × 1350' },
  { value: '1080x1080', label: 'Square', detail: '1080 × 1080' },
];

export const frameRates = ['23.976', '24', '25', '29.97', '30', '50', '60'];
