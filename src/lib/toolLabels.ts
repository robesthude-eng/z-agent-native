import { type MessageKey, t, tf } from "@/i18n";

/**
 * Подписи инструментов.
 *
 * Живёт в `lib`, а не рядом с карточкой: таблицей пользуются и нижний
 * индикатор (`lib/agentActivity`), и карточка, и шапка группы. Пока функция
 * лежала в `components/ToolCard`, библиотечный слой импортировал компонент вместе
 * со всем, что тот тянет за собой.
 *
 * Таблица, а не цепочка `if`, чтобы набор известных инструментов можно было
 * сверить с таблицей значков (`utils/toolUtils`) — раньше они расходились
 * молча: подпись «Рисует изображение» соседствовала с дефолтной шестерёнкой.
 */
export const TOOL_LABEL_KEYS: Record<string, MessageKey> = {
  bash: "tool_card.komanda",
  shell: "tool_card.komanda",
  cmd: "tool_card.komanda",
  read: "tool_card.chitaet_fayl",
  write: "tool_card.pishet_fayl",
  edit: "tool_card.pravit_fayl",
  applypatch: "tool_card.pravit_fayl",
  apply_patch: "tool_card.pravit_fayl",
  patch: "tool_card.primenyaet_patch",
  glob: "tool_card.ischet_fayly",
  grep: "tool_card.ischet_po_tekstu",
  ls: "tool_card.smotrit_papku",
  list: "tool_card.smotrit_papku",
  webfetch: "tool_card.zagruzhaet_stranicu",
  fetch: "tool_card.zagruzhaet_stranicu",
  websearch: "tool_card.ischet_v_internete",
  search: "tool_card.ischet_v_internete",
  ssh_tool: "tool_card.rabotaet_s_udalennym_serverom",
  ssh: "tool_card.rabotaet_s_udalennym_serverom",
  task: "tool_card.podzadacha",
  todowrite: "tool_card.obnovlyaet_plan",
  todo: "tool_card.obnovlyaet_plan",
  question: "tool_card.vopros",
  ensure_environment: "tool_card.gotovit_okruzhenie",
  environment_status: "tool_card.proveryaet_okruzhenie",
  repo_map: "tool_card.smotrit_strukturu_proekta",
  generate_image: "tool_card.risuet_izobrazhenie",
  generate_speech: "tool_card.ozvuchivaet_tekst",
  render_document: "tool_card.sobiraet_dokument",
  render_video: "tool_card.sobiraet_video",
  convert_media: "tool_card.konvertiruet_fayl",
  media_info: "tool_card.smotrit_svedeniya_o_fayle",
};

export function friendlyToolLabel(tool?: string): string {
  const key = TOOL_LABEL_KEYS[(tool || "").toLowerCase()];
  if (key) return t(key);
  if (!tool) return t("tool_card.instrument");
  return tf("tool_card.instrument_0", [tool]);
}
