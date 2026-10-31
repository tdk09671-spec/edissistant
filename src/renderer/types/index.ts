import type {
  TranscriptionProgress,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionSettings,
  TranscriptionStatus,
} from '../../shared/transcription/types';

export type * from '../../shared/transcription/types';
export type * from '../../shared/pipeline/types';
import type { SegmentBuildResult, SegmentPlanInfo, SegmentWord, PipelineBridgeAPI, RenderTarget, MediaCheck } from '../../shared/pipeline/types';
import type { VarietyLevel } from '../../shared/planning/types';

export type PresetType = 'product-animation' | 'podcast-trailer' | 'talking-head-intro' | 'custom';

export interface Preset {
  id: string;
  name: string;
  clientName: string;
  type: PresetType;
  referenceLinks: string[];
  referenceFiles: string[];
  creativeBrief: string;
  fonts: string;
  tracking: string;
  logoPath: string;
  brandingNotes: string;
  brandColors?: string[];
  /** Built-in templates ship with the app and are never written to disk. */
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'draft' | 'in-progress' | 'completed';

export type VisualMode = 'speaker' | 'b-roll' | 'motion-graphics' | 'captions';

export type SegmentStatus = 'pending' | 'approved' | 'needs-revision';

export interface Segment {
  id: string;
  /** Seconds from the start of the source */
  start: number;
  end: number;
  transcript: string;
  visualMode: VisualMode;
  instruction: string;
  /** Short summary of the creative plan for this row (concept: reasoning). */
  aiSuggestion: string;
  status: SegmentStatus;
  /** Word timing from local transcription (seconds on the source timeline). */
  words?: SegmentWord[];
  /**
   * Transcription couldn't verify this row's start against the audio (music or noise under the
   * speech, an overlapping voice, or no clear onset): a graphic here may start early or late.
   */
  startUncertain?: boolean;
  /** Transcription couldn't verify where this row's speech ends: it may run into the pause. */
  endUncertain?: boolean;
  /**
   * The editor's on-screen in/out for this row's graphic, separate from the speech timing
   * (start/end), which stays as transcribed. Snapped to the project's frames. Absent = the graphic
   * follows the speech timing.
   */
  visualTiming?: { start: number; end: number; adjustedAt?: string };
  /** The creative plan for this row; set by Suggest visuals and editor decisions. */
  plan?: SegmentPlanInfo;
}

export interface ReviewComment {
  id: string;
  time: number;
  segmentId: string | null;
  text: string;
  resolved: boolean;
  createdAt: string;
}

export interface ProjectVersion {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  segments: Segment[];
}

export type ExportFormat = 'full-motion' | 'transparent-motion' | 'transparent-captions';

export interface ExportSettings {
  format: ExportFormat;
  resolution: string;
  frameRate: string;
  destination: string;
  fileName: string;
  /** Render with a generic font when a brand font isn't installed (otherwise the render stops). */
  allowFontFallback?: boolean;
}

export interface SourceMedia {
  path: string;
  name: string;
  duration?: number;
}

/** The last rendered preview: graphics composited over the source, with its audio. */
export interface ProjectRenderState {
  previewPath: string;
  sourcePath: string;
  quality: 'preview' | 'final';
  width: number;
  height: number;
  fps: number;
  duration: number;
  renderedAt: string;
  /** Sequence rows rendered in that run / served from the render cache. */
  rendered: string[];
  reused: string[];
  /** Why each row did or didn't produce a graphic. */
  segments: SegmentBuildResult[];
}

export interface ExportRecord {
  id: string;
  target: RenderTarget;
  createdAt: string;
  folder: string;
  files: MediaCheck[];
  /** Set when the editor exported anyway while requested changes weren't applied: what's missing. */
  outdated?: string;
}

export interface Project {
  id: string;
  name: string;
  presetId: string;
  presetName: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  clientName?: string;
  presetType?: PresetType;
  creativeNotes?: string;
  source?: SourceMedia | null;
  segments?: Segment[];
  comments?: ReviewComment[];
  versions?: ProjectVersion[];
  exportSettings?: ExportSettings;
  /** Creative planning options for this project. */
  planning?: { variety: VarietyLevel; plannedAt?: string; findings?: string[] };
  /** Where the sequence came from when it was transcribed locally. */
  transcription?: { transcriptId: string; language: string; model: string; wordTiming: string; createdAt: string; warnings: string[] };
  render?: ProjectRenderState | null;
  exports?: ExportRecord[];
}

export interface AppSettings {
  theme: 'dark' | 'light';
  ffmpegPath: string;
  outputDirectory: string;
  autoSave: boolean;
  confirmBeforeDelete: boolean;
  reduceMotion: boolean;
  hardwareAcceleration: boolean;
  defaultResolution: string;
  defaultFrameRate: string;
  localAI: {
    enabled: boolean;
    provider: 'ollama' | 'lm-studio' | 'custom';
    endpoint: string;
    model: string;
  };
  /** Optional local transcription config (no UI yet; edit settings.json). Preserved across saves. */
  transcription?: TranscriptionSettings;
}

export interface SecretStatus {
  encryptionAvailable: boolean;
  claudeApiKey: boolean;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataPath: string;
  videosPath: string;
  hardwareAcceleration: boolean;
}

// Render engine bridge methods (src/main/render/ipc.ts).
import type { RenderBridgeAPI } from '../../shared/animation/api';

export interface ElectronAPI extends RenderBridgeAPI, PipelineBridgeAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  loadPresets: () => Promise<Preset[]>;
  savePresets: (presets: Preset[]) => Promise<boolean>;
  loadProjects: () => Promise<Project[]>;
  saveProjects: (projects: Project[]) => Promise<boolean>;
  loadSettings: () => Promise<Partial<AppSettings>>;
  saveSettings: (settings: AppSettings) => Promise<boolean>;
  getSecretStatus: () => Promise<SecretStatus>;
  setSecret: (name: 'claudeApiKey', value: string) => Promise<boolean>;
  deleteSecret: (name: 'claudeApiKey') => Promise<boolean>;
  openFiles: (options: { kind?: 'video' | 'media' | 'captions' | 'image'; multiple?: boolean; title?: string }) => Promise<string[]>;
  openDirectory: (options: { title?: string; defaultPath?: string }) => Promise<string | null>;
  readTextFile: (filePath: string) => Promise<string>;
  saveTextFile: (options: { defaultPath?: string; content: string; extensions?: string[]; name?: string }) => Promise<string | null>;
  fileExists: (filePath: string) => Promise<boolean>;
  openFolder: (folderPath: string) => Promise<boolean>;
  showItemInFolder: (filePath: string) => Promise<boolean>;
  getAppInfo: () => Promise<AppInfo>;
  getTranscriptionStatus: () => Promise<TranscriptionStatus>;
  /** `jobId` is chosen by the caller so it can cancel before the promise settles. */
  transcribe: (jobId: string, request: TranscriptionRequest) => Promise<TranscriptionResult>;
  cancelTranscription: (jobId: string) => Promise<boolean>;
  getCachedTranscript: (request: TranscriptionRequest) => Promise<TranscriptionResult | null>;
  clearTranscriptCache: () => Promise<number>;
  onTranscriptionProgress: (callback: (progress: TranscriptionProgress) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
