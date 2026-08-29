import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, tf } from "@/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api, pendingQuestionForSession } from "../api/client";
import {
  activeQuestion,
  BAR_COLLAPSE_LINES,
  barPresentation,
  barWarning,
  batchReplyPlan,
  type Interruption,
  normalizePermission,
  optionsLayout,
  replyPlan,
  type ToolPresentation,
} from "../api/interruptions";
import { log } from "../lib/log";
import { useStore } from "../store/useStore";
import { KeyIcon } from "./icons";
import {
  type QuestionAnswer,
  type QuestionConfig,
  QuestionTool,
} from "./QuestionTool";

/**
 * Плавающая полоса прерываний — этап 2.1.
 *
 * Согласовано с владельцем: прерывание живёт над композером, а не карточкой в
 * ленте. Причина в асимметрии, которая и была дефектом: разрешение висело над
 * композером и увести его прокруткой нельзя, а вопрос жил в ленте и прокруткой
 * уходил из вида — после чего ход молча ждал ответа, которого никто не видел.
 *
 * Компонент намеренно тонкий. Всё, что можно решить, решено в
 * `src/api/interruptions.ts` и проверено там же: какое прерывание показать,
 * сколько ждёт за ним, сворачивать ли текст, что отправить и предупреждать ли
 * об отмене хода. Здесь остались разметка и вызовы сети.
 *
 * За флагом `VITE_INTERRUPTION_BAR`.
 */

/**
 * Человеческая формулировка вызова инструмента.
 *
 * Дубликат `presentTool` из `PermissionDialog.tsx` не нужен: пока флаг
 * выключен, работает тот компонент, и две копии текстов разошлись бы молча.
 * Поэтому здесь короткая форма, а подробные тексты остаются там до тех пор,
 * пока прежний показ не удалён (этап 3.3).
 */
function presentTool(tool: string, input: unknown): ToolPresentation {
  const obj = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const str = (k: string) =>
    typeof obj[k] === "string" ? (obj[k] as string) : undefined;
  const detail =
    str("command") ??
    str("cmd") ??
    str("filePath") ??
    str("path") ??
    str("url") ??
    str("pattern");
  return {
    action: tf("interruption_bar.razreshit_vyzov_0", [tool]),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Одна и та же пустая ссылка для чата без сообщений.
 *
 * Не мелочь: селектор zustand сравнивает результат по идентичности, и `?? []`
 * прямо в нём возвращал бы НОВЫЙ массив на каждый вызов — то есть «значение
 * изменилось» при любом обновлении стора. React отвечает на это предупреждением
 * про несохранённый снимок и лишними рендерами полосы, висящей над перепиской.
 */
const NO_MESSAGES: never[] = [];

export default function InterruptionBar() {
  const currentID = useStore((s) => s.currentID);
  const permissions = useStore((s) => s.permissions);
  const respondPermission = useStore((s) => s.respondPermission);
  const messages = useStore((s) =>
    currentID ? (s.messages[currentID] ?? NO_MESSAGES) : NO_MESSAGES,
  );

  const [expanded, setExpanded] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Идентификатор pending request нативного Question API. `null` означает
   * только «ещё не увидели»: при клике делаем короткий повторный поиск.
   * Ответ обычным user-message здесь запрещён — он создавал второй turn и
   * в старом transport-контуре мог привести к abort tool-call.
   */
  const [pendingQuestionId, setPendingQuestionId] = useState<string | null>(
    null,
  );

  const question = useMemo(() => activeQuestion(messages), [messages]);

  /**
   * Ответы на вопросы ЭТОГО вызова, уже выбранные, но ещё не отправленные.
   *
   * Копятся до последнего вопроса и уходят одной посылкой, как требует
   * Question API: внешний массив `answers` соответствует массиву вопросов.
   *
   * Порядок в массиве и есть порядок вопросов: показываются они строго по
   * очереди, поэтому индекс активного равен числу накопленных.
   */
  const [drafts, setDrafts] = useState<string[][]>([]);

  const queue = useMemo(() => question?.interruptions ?? [], [question]);

  // Ключ вызова, а НЕ активного вопроса: черновики живут ровно пока идёт
  // разбор одного вызова инструмента. Сброс по активному вопросу закольцевал
  // бы полосу — ответ на первый сдвигал бы ключ и тут же стирал сам ответ.
  const callKey = question
    ? `${question.callId ?? queue[0]?.prompt ?? ""}|${queue.length}`
    : "";
  useEffect(() => {
    if (callKey) setDrafts([]);
  }, [callKey]);

  const interruptions = useMemo<Interruption[]>(() => {
    const fromPermissions = permissions.map((p) =>
      normalizePermission(p, presentTool),
    );
    return [...fromPermissions, ...queue.slice(drafts.length)];
  }, [permissions, queue, drafts]);

  const bar = useMemo(() => barPresentation(interruptions), [interruptions]);
  const active = bar.active;

  // Новое прерывание — свои свёртка, черновик и подтверждение протокола.
  // Без сброса ответ, набранный для прошлого вопроса, переехал бы в следующий.
  // Ключ — заголовок вместе с деталью: id у вопроса из ленты нет.
  const activeKey = active
    ? `${active.kind}|${active.prompt}|${active.detail}`
    : "";
  // Пустой список зависимостей здесь был опечаткой, а не решением: сброс
  // задумывался на смену прерывания (о чём говорит комментарий выше), но
  // выполнялся один раз за жизнь компонента. Следствие видно на втором
  // вопросе — набранный, но не отправленный «свой ответ» переезжал в него из
  // предыдущего.
  useEffect(() => {
    if (activeKey) {
      setExpanded(false);
      setCustom("");
      return;
    }
    setExpanded(false);
    setCustom("");
  }, [activeKey]);

  useEffect(() => {
    // Сброс перед запросом, а не в отдельном эффекте: подтверждение относится
    // к конкретному вызову, и унесённое в следующий отправило бы ответ по
    // протоколу на чужой идентификатор.
    setPendingQuestionId(null);
    if (!callKey || !currentID || active?.kind !== "question") return;
    let alive = true;
    api
      .listPendingQuestions(currentID)
      .then((list) => {
        const pending = pendingQuestionForSession(list, currentID);
        if (alive && pending) setPendingQuestionId(pending.id);
      })
      .catch(() => {
        // При отправке будет повторный поиск с коротким polling. Здесь ошибка
        // не должна закрывать карточку и тем более отменять текущий turn.
      });
    return () => {
      alive = false;
    };
  }, [currentID, active?.kind, callKey]);

  /**
   * Фокус переносится на первый вариант, когда прерывание появилось, и
   * возвращается туда, где был, когда очередь опустела. Так же вёл себя
   * `PermissionDialog`, и потерять это при переезде значило бы починить одно
   * (вопрос уходил прокруткой) ценой другого: с клавиатуры до полосы,
   * плавающей вне потока документа, иначе не добраться.
   *
   * Первый вариант, а не отказ, — отдельное условие: `barPresentation` ставит
   * отказ последним и помечает `denial`, и фокус на нём превратил бы Enter в
   * отклонение.
   */
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (activeKey) {
      if (!returnFocusRef.current) {
        returnFocusRef.current = document.activeElement as HTMLElement | null;
      }
      firstOptionRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [activeKey]);

  // Предупреждение считается по прерыванию, а не по плану: план требует
  // выбранного ответа, а предупредить нужно ДО того, как пользователь нажмёт.
  const warning = active ? barWarning(active, { pendingQuestionId }) : null;
  const layout = active ? optionsLayout(active) : "list";

  const answer = useCallback(
    async (values: string[]) => {
      if (!active || busy) return;

      // Вопросы одного вызова отвечаются пакетом, разрешения — поодиночке.
      // Развилка здесь одна и явная: `active` — вопрос ровно тогда, когда он
      // взят из очереди этого вызова, потому что `barPresentation` ставит
      // разрешения впереди и до вопроса очередь не доходит, пока они есть.
      const isQueued = active.kind === "question";
      const filled = isQueued ? [...drafts, values] : [];
      if (isQueued && filled.length < queue.length) {
        // Не последний вопрос вызова: ответ запоминается, полоса показывает
        // следующий. Отправляем только полный массив ответов одного tool-call.
        setDrafts(filled);
        return;
      }

      setBusy(true);
      try {
        let confirmedQuestionId = pendingQuestionId;
        if (isQueued && currentID && !confirmedQuestionId) {
          const pending = await api.waitForPendingQuestion(currentID);
          confirmedQuestionId = pending?.id ?? null;
          if (confirmedQuestionId) setPendingQuestionId(confirmedQuestionId);
        }

        const chosen = isQueued
          ? batchReplyPlan(queue, filled, {
              pendingQuestionId: confirmedQuestionId,
            })
          : replyPlan(active, values, {
              pendingQuestionId: confirmedQuestionId,
            });

        switch (chosen.transport) {
          case "permission":
            await respondPermission(chosen.id, chosen.response);
            break;
          case "question":
            if (!currentID)
              throw new Error(t("interruption_bar.net_aktivnoy_sessii"));
            await api.replyQuestion(currentID, chosen.id, chosen.answers);
            break;
          case "none":
            log.warn(
              t("interruption_bar.interruptionbar_otvet_poka_ne_otpravlen"),
              chosen.reason,
            );
            toast(
              "error",
              t("interruption_bar.ne_udalos_svyazat_otvet_s_voprosom"),
            );
            return;
        }
        // Успешный reply разблокирует ТОТ ЖЕ question tool-call. Черновики
        // можно убрать сразу: повторный клик создал бы дубликат ответа.
        if (isQueued) setDrafts(filled);
      } catch (e) {
        // Молчаливая неудача здесь худшая из возможных: полоса остаётся на
        // месте, кнопки снова активны, и со стороны это неотличимо от «клик не
        // сработал». Ход при этом продолжает ждать.
        log.error(t("interruption_bar.interruptionbar_otvet_ne_otpravlen"), e);
        toast(
          "error",
          t("interruption_bar.otvet_ne_otpravlen_poprobuyte_esche_raz"),
        );
      } finally {
        setBusy(false);
      }
    },
    [
      active,
      busy,
      currentID,
      drafts,
      pendingQuestionId,
      queue,
      respondPermission,
    ],
  );

  if (!bar.visible || !active) return null;

  const isPermission = active.kind === "permission";

  // Если активен вопрос агента — рендерим красивый QuestionTool с 21st.dev
  if (!isPermission && queue.length > 0) {
    const questionConfigs: QuestionConfig[] = queue.map((q, idx) => ({
      id: q.id ?? `q-${idx}`,
      title: q.prompt,
      header: q.title || t("question_tool.vopros"),
      ...(q.detail ? { description: q.detail } : {}),
      allowCustom: q.allowCustom,
      options: q.options.map((opt, oIdx) => ({
        id: opt.value || `opt-${oIdx}`,
        label: opt.label,
        ...(opt.description ? { description: opt.description } : {}),
      })),
    }));

    return (
      <section
        className="pointer-events-none fixed inset-x-0 bottom-[116px] z-40 px-3 md:px-6"
        aria-live="polite"
        aria-label="Вопрос агента"
      >
        <div className="pointer-events-auto mx-auto w-full max-w-lg animate-in fade-in slide-in-from-bottom-2">
          <QuestionTool
            questions={questionConfigs}
            busy={busy}
            onSubmitAnswer={async (answers: QuestionAnswer[]) => {
              const allValues = answers.map((ans) => {
                if (ans.kind === "skip") return ["skip"];
                if (ans.text) return [ans.text];
                return ans.selectedLabels && ans.selectedLabels.length > 0
                  ? ans.selectedLabels
                  : (ans.selectedIds ?? []);
              });
              setBusy(true);
              try {
                let confirmedQuestionId = pendingQuestionId;
                if (currentID && !confirmedQuestionId) {
                  const pending = await api.waitForPendingQuestion(currentID);
                  confirmedQuestionId = pending?.id ?? null;
                  if (confirmedQuestionId)
                    setPendingQuestionId(confirmedQuestionId);
                }

                const chosen = batchReplyPlan(queue, allValues, {
                  pendingQuestionId: confirmedQuestionId,
                });

                if (chosen.transport === "question") {
                  if (!currentID)
                    throw new Error(t("interruption_bar.net_aktivnoy_sessii"));
                  await api.replyQuestion(currentID, chosen.id, chosen.answers);
                } else if (chosen.transport === "none") {
                  log.warn(
                    t(
                      "interruption_bar.interruptionbar_otvet_poka_ne_otpravlen",
                    ),
                    chosen.reason,
                  );
                  toast(
                    "error",
                    t("interruption_bar.ne_udalos_svyazat_otvet_s_voprosom"),
                  );
                }
              } catch (e) {
                log.error(
                  t("interruption_bar.interruptionbar_otvet_ne_otpravlen"),
                  e,
                );
                toast(
                  "error",
                  t("interruption_bar.otvet_ne_otpravlen_poprobuyte_esche_raz"),
                );
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      className="pointer-events-none fixed inset-x-0 bottom-[116px] z-40 px-3 md:px-6"
      aria-live="polite"
      aria-label={active.title}
    >
      <div
        className={cn(
          "pointer-events-auto mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border bg-card/95 shadow-2xl backdrop-blur",
          "animate-in fade-in slide-in-from-bottom-2",
          // Цветной кант — только у разрешения: оно про последствия. У вопроса
          // канта нет. Зелёная рамка на каждый вопрос — это акцент, который
          // виден всегда, а значит не акцент.
          isPermission ? "border-warning/40" : "border-border",
        )}
      >
        <div className="space-y-3 px-4 py-3.5">
          {/* Шапка — подпись, а не заголовок с разделителем. Полоса и так
              отделена от переписки собственными границей и тенью; вторая
              линия внутри делила маленькую карточку на две ещё меньшие. */}
          <div className="flex items-center gap-2">
            {isPermission && (
              <span aria-hidden="true" className="text-warning">
                <KeyIcon size={13} />
              </span>
            )}
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {active.title}
            </span>
            {bar.queued > 0 && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                ещё {bar.queued}
              </span>
            )}
          </div>

          {active.prompt && (
            <p
              className={cn(
                "text-[15px] leading-relaxed text-foreground",
                bar.collapsible && !expanded && "line-clamp-3",
              )}
            >
              {active.prompt}
            </p>
          )}

          {active.detail && (
            <pre
              className={cn(
                "overflow-auto rounded-xl border border-border bg-background/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all",
                bar.collapsible && !expanded ? "line-clamp-3" : "max-h-40",
              )}
            >
              {active.detail}
            </pre>
          )}

          {bar.collapsible && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? t("interruption_bar.svernut")
                : tf("interruption_bar.pokazat_celikom_svernuto_do_0_strok", [
                    BAR_COLLAPSE_LINES,
                  ])}
            </button>
          )}

          {/* Форму выбора решает `optionsLayout`, а не classNames по месту.
              Список во всю ширину читается одинаково при трёх вариантах и при
              семи; заливка у строк убрана — пять сплошных зелёных плашек
              подряд спорили друг с другом за внимание, хотя выбрать надо одну
              и все они равноправны. Пояснение стоит второй строкой, а не в
              подсказке под курсором, которой на телефоне нет вовсе. */}
          {layout === "list" ? (
            <div className="flex flex-col gap-1.5">
              {active.options.map((opt, idx) => (
                <button
                  key={opt.value}
                  ref={idx === 0 ? firstOptionRef : undefined}
                  type="button"
                  disabled={busy}
                  onClick={() => answer([opt.value])}
                  className={cn(
                    "w-full rounded-xl border border-border/70 bg-background/40 px-3.5 py-2.5 text-left transition",
                    "hover:border-primary/50 hover:bg-muted/40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <span className="block text-[14px] leading-snug text-foreground">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                      {opt.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
              {active.options.map((opt, idx) => (
                <Button
                  key={opt.value}
                  ref={idx === 0 ? firstOptionRef : undefined}
                  size="sm"
                  variant={opt.denial ? "ghost" : "default"}
                  disabled={busy}
                  onClick={() => answer([opt.value])}
                  {...(opt.description ? { title: opt.description } : {})}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          )}

          {active.allowCustom && (
            <div className="flex items-center gap-2 border-t border-border/60 pt-3">
              <Input
                type="text"
                className="h-9 rounded-xl text-[13.5px]"
                placeholder={t("interruption_bar.otvetit_svoimi_slovami")}
                value={custom}
                disabled={busy}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && custom.trim()) {
                    e.preventDefault();
                    answer([custom]);
                  }
                }}
              />
              <Button
                size="sm"
                className="h-9 shrink-0 rounded-xl"
                disabled={busy || !custom.trim()}
                onClick={() => answer([custom])}
              >
                Ответить
              </Button>
            </div>
          )}

          {/* Для Question API предупреждения об отмене больше нет: reply
              продолжает тот же tool-call. Блок оставлен общим для других
              типов interruption, если у них появится предупреждение. */}
          {warning && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {warning}
            </p>
          )}
        </div>

        {/* Накопленный ответ должен быть виден. Пакет отправляется по
            последнему вопросу вызова, и без этой строки ответ на первый
            выглядел бы как «нажал, и ничего не произошло». Внизу, а не вверху:
            это следствие действия, а не заголовок карточки. */}
        {drafts.length > 0 && (
          <p className="border-t border-border/60 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">
            Ответов сохранено: {drafts.length}. Уйдут вместе, когда ответите на
            последний вопрос.
          </p>
        )}
      </div>
    </section>
  );
}
