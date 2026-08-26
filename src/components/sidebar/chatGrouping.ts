/**
 * Раскладка списка чатов в сайдбаре: закреплённые → папки → группы по датам.
 *
 * Вынесено из Sidebar отдельной чистой функцией: раньше группировка жила
 * inline в разметке, и добавление папок сделало бы её нечитаемой. Порядок и
 * состав групп — то, что пользователь видит каждый день, поэтому правило должно
 * проверяться тестами, а не глазами.
 */

import { t } from "@/i18n";
import type { SessionInfo } from "../../api/types";

export interface ChatFolder {
  id: string;
  name: string;
}

export type SidebarGroupKind = "pinned" | "folder" | "date";

export interface SidebarGroup {
  kind: SidebarGroupKind;
  /** Устойчивый ключ для React и для запоминания свёрнутости папки. */
  key: string;
  label: string;
  /** Только для kind === "folder". */
  folderId?: string;
  items: SessionInfo[];
}

const PINNED_LABEL = t("chat_grouping.zakreplennye");

/** Метка группы по времени последнего изменения чата. */
export function dateGroupLabel(
  session: SessionInfo,
  now: number = Date.now(),
): string {
  const ts = session.time?.updated ?? session.time?.created;
  if (!ts) return t("chat_grouping.ranshe");
  const startOfDay = (value: number) => {
    const d = new Date(value);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff <= 0) return t("chat_grouping.segodnya");
  if (diff === 1) return t("chat_grouping.vchera");
  if (diff < 7) return t("chat_grouping.na_etoy_nedele");
  return t("chat_grouping.ranshe");
}

const DATE_ORDER = [
  t("chat_grouping.segodnya"),
  t("chat_grouping.vchera"),
  t("chat_grouping.na_etoy_nedele"),
  t("chat_grouping.ranshe"),
];

export interface BuildGroupsInput {
  sessions: SessionInfo[];
  pinnedSessions: string[];
  folders: ChatFolder[];
  /** sessionId → folderId. Чат принадлежит не более чем одной папке. */
  assignments: Record<string, string>;
  /** Отображаемое имя чата (учитывает серверный оверлей переименования). */
  titleOf: (session: SessionInfo) => string;
  /** Текстовый фильтр по имени чата, уже в нижнем регистре. */
  filter?: string;
  now?: number;
}

/**
 * Собрать группы для отрисовки.
 *
 * Закрепление сильнее папки: закреплённый чат показывается только в секции
 * «Закреплённые». Иначе он дублировался бы в двух местах, и пользователь не
 * понимал бы, сколько у него чатов.
 *
 * Пустые папки остаются в списке — иначе только что созданная папка исчезала бы
 * до того, как в неё что-то положили. При активном текстовом фильтре, наоборот,
 * пустые папки скрываются: там пустая папка — это шум в результатах поиска.
 */
export function buildSidebarGroups(input: BuildGroupsInput): SidebarGroup[] {
  const { sessions, pinnedSessions, folders, assignments, titleOf } = input;
  const filter = (input.filter ?? "").trim().toLowerCase();
  const pinned = new Set(pinnedSessions);
  const knownFolders = new Set(folders.map((f) => f.id));

  const matches = (s: SessionInfo) =>
    !filter || titleOf(s).toLowerCase().includes(filter);

  const visible = sessions.filter(matches);

  const groups: SidebarGroup[] = [];

  const pinnedItems = visible.filter((s) => pinned.has(s.id));
  if (pinnedItems.length > 0) {
    groups.push({
      kind: "pinned",
      key: "pinned",
      label: PINNED_LABEL,
      items: pinnedItems,
    });
  }

  for (const folder of folders) {
    const items = visible.filter(
      (s) => !pinned.has(s.id) && assignments[s.id] === folder.id,
    );
    if (items.length === 0 && filter) continue;
    groups.push({
      kind: "folder",
      key: `folder:${folder.id}`,
      label: folder.name,
      folderId: folder.id,
      items,
    });
  }

  // Чат с привязкой к удалённой папке не должен пропасть из списка — он
  // возвращается в обычные группы по датам.
  const loose = visible.filter((s) => {
    if (pinned.has(s.id)) return false;
    const folderId = assignments[s.id];
    return !folderId || !knownFolders.has(folderId);
  });

  const byLabel = new Map<string, SessionInfo[]>();
  for (const s of loose) {
    const label = dateGroupLabel(s, input.now);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(s);
    else byLabel.set(label, [s]);
  }
  for (const label of DATE_ORDER) {
    const items = byLabel.get(label);
    if (items && items.length > 0) {
      groups.push({ kind: "date", key: `date:${label}`, label, items });
    }
  }

  return groups;
}
