// Lightweight inline SVG icons (no external assets → works in sandboxed preview).
import type { ReactNode } from "react";

const S = (props: { children: ReactNode; size?: number | undefined }) => (
  <svg
    aria-hidden="true"
    width={props.size ?? 18}
    height={props.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.children}
  </svg>
);

export const NewChatIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);

export const TrashIcon = (p: { size?: number }) => (
  <S size={p.size ?? 15}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </S>
);

export const FilePlusIcon = (p: { size?: number }) => (
  <S size={p.size ?? 15}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M12 18v-6" />
    <path d="M9 15h6" />
  </S>
);

export const FolderPlusIcon = (p: { size?: number }) => (
  <S size={p.size ?? 15}>
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
    <path d="M12 11v6" />
    <path d="M9 14h6" />
  </S>
);

export const SaveIcon = (p: { size?: number }) => (
  <S size={p.size ?? 15}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8" />
    <path d="M7 3v5h8" />
  </S>
);

export const RenameIcon = (p: { size?: number }) => (
  <S size={p.size ?? 15}>
    <path d="M4 7V5h16v2" />
    <path d="M9 20h6" />
    <path d="M12 5v15" />
  </S>
);

export const SettingsIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </S>
);

export const SunIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </S>
);

export const MoonIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </S>
);

export const SendIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </S>
);

export const StopIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect
      x="6"
      y="6"
      width="12"
      height="12"
      rx="2"
      fill="currentColor"
      stroke="none"
    />
  </S>
);

export const CloseIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </S>
);

export const CheckIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M20 6 9 17l-5-5" />
  </S>
);

export const CopyIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
);

export const KeyIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.5 12.5 8-8M16 7l3 3M14 9l3 3" />
  </S>
);

export const LogoutIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </S>
);

export const MenuIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </S>
);

// Left sidebar toggle icons — panel style (two bars + divider)
// Collapse (sidebar open) — divider on the right (sharp, no circle)
export const SidebarLeftCollapseIcon = (p: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={p.size ?? 20}
    height={p.size ?? 20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="8" height="18" />
    <line x1="13" y1="3" x2="13" y2="21" />
    <rect x="15" y="3" width="6" height="18" />
  </svg>
);

// Expand (sidebar closed) — clean sharp panel style (no circle)
export const SidebarLeftExpandIcon = (p: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={p.size ?? 20}
    height={p.size ?? 20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.25"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="6" height="18" />
    <line x1="11" y1="3" x2="11" y2="21" />
    <rect x="13" y="3" width="8" height="18" />
  </svg>
);

// Workspace icons — pure folder, NO arrows
export const WorkspaceClosedIcon = (p: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={p.size ?? 18}
    height={p.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2" />
  </svg>
);

export const WorkspaceOpenIcon = (p: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={p.size ?? 18}
    height={p.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2" />
    <line x1="21" y1="7" x2="21" y2="17" />
  </svg>
);

export const PaperclipIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </S>
);

export const ChevronRightIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="m9 18 6-6-6-6" />
  </S>
);

export const ChevronDownIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="m6 9 6 6 6-6" />
  </S>
);

export const FileIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </S>
);

/** Картинка в дереве воркспейса: рамка с горизонтом и солнцем. */
export const ImageFileIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 16-5-5L5 20" />
  </S>
);

/** Архив: коробка с защёлкой. Отличается от листа силуэтом, а не только цветом. */
export const ArchiveFileIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
    <path d="M10 13h4" />
  </S>
);

export const FolderIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </S>
);

/**
 * Карандаш — «переименовать». Отдельно от `RenameIcon`: тот рисует букву «Т»
 * (значок текста) и в строке чата читается именно как буква, а не как
 * действие.
 */
export const PencilIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);

// Значки карточек-подсказок на пустом экране. Заменяют эмодзи 📖 🐛:
// цветные картинки посреди интерфейса, из которого цвет убран.

export const BookIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z" />
    <path d="M4 17.5h16" />
  </S>
);

export const BugIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="8" y="7" width="8" height="13" rx="4" />
    <path d="M9 8a3 3 0 0 1 6 0" />
    <path d="M3 11h5M16 11h5M3 18h5M16 18h5M12 20v2" />
  </S>
);

/** Заменяет эмодзи 👤 в строке аккаунта. */
export const UserIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </S>
);

/** Кнопка. Заменяет эмодзи 📌 в списке чатов. */
export const PinIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M9 3h6l-1 7 3 3H7l3-3z" />
    <path d="M12 16v5" />
  </S>
);

export const SearchIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </S>
);

export const GitBranchIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </S>
);

export const RefreshIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </S>
);

export const PanelIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </S>
);

export const GiftIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
  </S>
);

export const WarningIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </S>
);

// --- Tool icons (for tool cards) ---

export const BashIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m6 9 3 3-3 3M13 15h4" />
  </S>
);

export const EditIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);

export const WriteIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h4" />
  </S>
);

export const GlobIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M4 7h16M4 12h16M4 17h16" strokeDasharray="3 2" />
  </S>
);

export const GrepIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3M8 11h6" />
  </S>
);

export const ListFilesIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </S>
);

export const TaskIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 11l2 2 4-4M9 17h6" />
  </S>
);

export const WebFetchIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
  </S>
);

export const WebSearchIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
    <path d="M8 11h6" strokeDasharray="2 2" />
  </S>
);

export const FolderUploadIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <path d="M12 10v6M9 13h6" />
  </S>
);

export const QuestionIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </S>
);

export const DefaultToolIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
  </S>
);

export const DownloadIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </S>
);

export const ThinkIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M12 4a6 6 0 0 1 6 6c0 1.9-.9 3.3-2 4.3V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.7c-1.1-1-2-2.4-2-4.3a6 6 0 0 1 6-6Z" />
    <path d="M10 21h4" />
  </S>
);

export const PreviewIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </S>
);

export const FullscreenIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </S>
);

export const ExitFullscreenIcon = (p: { size?: number }) => (
  <S size={p.size}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </S>
);
