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
  /** Populated only by the AI planning service once integrated. */
  aiSuggestion: string;
  status: SegmentStatus;
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
}

export interface SourceMedia {
  path: string;
  name: string;
  duration?: number;
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

export interface ElectronAPI {
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
