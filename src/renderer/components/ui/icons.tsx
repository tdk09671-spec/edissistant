import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: ReactNode, displayName: string) {
  const Icon = ({ size = 18, strokeWidth = 1.6, ...props }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
}

export const IconHome = make(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></>, 'IconHome');
export const IconFolder = make(<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.2.6L11.4 7.4a1.5 1.5 0 0 0 1.2.6h6.9A1.5 1.5 0 0 1 21 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />, 'IconFolder');
export const IconLayers = make(<><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>, 'IconLayers');
export const IconSettings = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>, 'IconSettings');
export const IconPlus = make(<><path d="M12 5v14" /><path d="M5 12h14" /></>, 'IconPlus');
export const IconArrowRight = make(<><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>, 'IconArrowRight');
export const IconArrowLeft = make(<><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>, 'IconArrowLeft');
export const IconChevronLeft = make(<path d="m15 18-6-6 6-6" />, 'IconChevronLeft');
export const IconChevronRight = make(<path d="m9 18 6-6-6-6" />, 'IconChevronRight');
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />, 'IconChevronDown');
export const IconSearch = make(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, 'IconSearch');
export const IconClose = make(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, 'IconClose');
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />, 'IconCheck');
export const IconMore = make(<><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>, 'IconMore');
export const IconTrash = make(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" /></>, 'IconTrash');
export const IconCopy = make(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" /></>, 'IconCopy');
export const IconEdit = make(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, 'IconEdit');
export const IconFilm = make(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4" /></>, 'IconFilm');
export const IconCube = make(<><path d="m21 7.5-9-5-9 5v9l9 5 9-5z" /><path d="m3 7.5 9 5 9-5" /><path d="M12 12.5V21.5" /></>, 'IconCube');
export const IconMic = make(<><rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3.5" /></>, 'IconMic');
export const IconUser = make(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, 'IconUser');
export const IconSparkle = make(<><path d="M10 3.5 11.6 8.4 16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6Z" /><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>, 'IconSparkle');
export const IconPlay = make(<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />, 'IconPlay');
export const IconPause = make(<><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>, 'IconPause');
export const IconBack5 = make(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v5h5" /></>, 'IconBack5');
export const IconForward5 = make(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v5h-5" /></>, 'IconForward5');
export const IconStepBack = make(<><path d="M18 5 9 12l9 7z" /><path d="M6 5v14" /></>, 'IconStepBack');
export const IconStepForward = make(<><path d="m6 5 9 7-9 7z" /><path d="M18 5v14" /></>, 'IconStepForward');
export const IconVolume = make(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>, 'IconVolume');
export const IconMute = make(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m16 9 6 6M22 9l-6 6" /></>, 'IconMute');
export const IconExpand = make(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>, 'IconExpand');
export const IconUpload = make(<><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M4 15v4.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V15" /></>, 'IconUpload');
export const IconDownload = make(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 15v4.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V15" /></>, 'IconDownload');
export const IconLink = make(<><path d="M10 14a4 4 0 0 0 5.7 0l3.5-3.5a4 4 0 0 0-5.7-5.7L12 6.3" /><path d="M14 10a4 4 0 0 0-5.7 0l-3.5 3.5a4 4 0 0 0 5.7 5.7l1.5-1.5" /></>, 'IconLink');
export const IconFile = make(<><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3v5h5" /></>, 'IconFile');
export const IconText = make(<><path d="M4 6V4h16v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>, 'IconText');
export const IconMessage = make(<path d="M20 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />, 'IconMessage');
export const IconHistory = make(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, 'IconHistory');
export const IconRefresh = make(<><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>, 'IconRefresh');
export const IconLock = make(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 'IconLock');
export const IconInfo = make(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></>, 'IconInfo');
export const IconAlert = make(<><path d="M12 3 2.5 20h19z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>, 'IconAlert');
export const IconCheckCircle = make(<><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></>, 'IconCheckCircle');
export const IconClock = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, 'IconClock');
export const IconGrid = make(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>, 'IconGrid');
export const IconList = make(<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>, 'IconList');
export const IconSliders = make(<><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></>, 'IconSliders');
export const IconCpu = make(<><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>, 'IconCpu');
export const IconHardDrive = make(<><path d="M22 12H2" /><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /><path d="M6 16h.01M10 16h.01" /></>, 'IconHardDrive');
export const IconKey = make(<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8" /><path d="m16 7 3 3M18.5 4.5l2 2" /></>, 'IconKey');
export const IconBolt = make(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />, 'IconBolt');
export const IconPalette = make(<><path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-4 3.5h-2a2 2 0 0 0-1.5 3.3A1.4 1.4 0 0 1 12 21Z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10.5" cy="7" r="1" fill="currentColor" /><circle cx="15.5" cy="7.5" r="1" fill="currentColor" /></>, 'IconPalette');
export const IconType = make(<><path d="M4 7V5h16v2" /><path d="M9 19h6" /><path d="M12 5v14" /></>, 'IconType');
export const IconExternal = make(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10" /></>, 'IconExternal');
export const IconMinimize = make(<path d="M5 12h14" />, 'IconMinimize');
export const IconMaximize = make(<rect x="5" y="5" width="14" height="14" rx="1.5" />, 'IconMaximize');
export const IconRestore = make(<><rect x="5" y="8" width="11" height="11" rx="1.5" /><path d="M8 8V6.5A1.5 1.5 0 0 1 9.5 5h8A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H16" /></>, 'IconRestore');
export const IconWave = make(<path d="M2 12h2M6 8v8M10 5v14M14 9v6M18 7v10M22 12h-2" />, 'IconWave');
export const IconScissors = make(<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" /></>, 'IconScissors');
export const IconEye = make(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>, 'IconEye');
export const IconSidebar = make(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>, 'IconSidebar');
export const IconCrosshair = make(<><path d="M12 3v18" /><path d="M8 3h8" /><path d="m9 7 3 3 3-3" /></>, 'IconCrosshair');
export const IconUndo =make(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>, 'IconUndo');
export const IconRedo = make(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>, 'IconRedo');
export const IconSave =make(<><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M7 3v5h8" /><path d="M7 21v-7h10v7" /></>, 'IconSave');
