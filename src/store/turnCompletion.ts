import { isAbortError } from "../api/abortRegistry";
import { api, SessionGoneError } from "../api/client";
import { isSseHealthyForSession } from "../api/events";
import { assistantFinishState, finalMarkerOf } from "../api/turnFinality";
import {
  dispositionOf,
  isSettled,
  isVerdictSourceEnabled,
  parseTurnState,
  type TurnProjection,
  VERDICT_POLL_MS,
} from "../api/turnVerdict";
import type { Message } from "../api/types";
import { log } from "../lib/log";
import { sessionFsm } from "./sessionFsm";

/**
 * Ожидание конца хода агента.
 *
 * Это самая тонкая часть отправки, и до выноса она была двумястами пятьюдесятью
 * строками внутри пятисотстрочного `send()` — то есть не проверялась ничем.
 * Здесь сведены ЧЕТЫРЕ источника завершения, и важен не каждый по отдельности,
 * а то, что все они гасят друг друга ровно один раз (`settled`):
 *
 *  1. вердикт сервера (новый путь, за флагом);
 *  2. SSE `session.idle` (прежний путь);
 *  3. HTTP-поллер с окном стабильности (страховка от битого SSE);
 *  4. страховочный таймаут.
 *
 * Пути 1 и 2–4 взаимоисключающи по флагу `isVerdictSourceEnabled()`: I-30
 * требует, чтобы интерфейс не вычислял завершение сам, и новый путь читает
 * вердикт с сервера. Прежний оставлен рядом, пока флаг снят, — по принципу
 * выката он сначала ДУБЛИРУЕТ поведение.
 *
 * Логика перенесена дословно; менялось только то, что делает её видимой:
 * зависимости стали параметрами, а эффекты над стором — тремя узкими
 * колбэками. Расширять контракт «заодно» здесь нельзя: любое лишнее условие
 * сведения источников проявляется как зависший спиннер или, наоборот, как
 * закрытый посреди работы ход.
 */
export interface TurnCompletionOptions {
  sessionId: string;
  /** Поколение запроса из `sessionFsm` — им гасятся idle-резолверы. */
  requestGen: number;
  /**
   * Уже запущенный запрос промпта. `null` в результате означает «соединение
   * оборвалось после доставки»: ход идёт, финал подтвердят другие источники.
   */
  promptPromise: Promise<Message | null>;
  /**
   * Положить проекцию хода в стор (нужна интерфейсу и в состоянии `stuck`).
   * `null` — допустимое значение: сервер отдал ответ без проекции, и стор
   * хранил его как есть ещё до выноса.
   */
  onTurnProjection: (turn: TurnProjection | null) => void;
  /** Пометить сессию ошибкой (сервер сказал `failed`). */
  onFailed: () => void;
  /** Влить серверный снимок сообщений в стор (только когда SSE не работает). */
  onSnapshot: (msgs: Message[]) => void;
  /** Страховочный таймаут, мс. */
  hardTimeoutMs: number;
}

/**
 * @returns промис, который резолвится, когда интерфейс можно отпускать, и
 *   реджектится при мёртвой сессии или ошибке отправки.
 */
export function awaitTurnCompletion(
  opts: TurnCompletionOptions,
): Promise<void> {
  const {
    sessionId: sidStr,
    requestGen,
    promptPromise,
    onTurnProjection,
    onFailed,
    onSnapshot,
    hardTimeoutMs,
  } = opts;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (_reason: string) => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // --- Источник завершения: сервер или прежний клиентский арбитраж ---
    //
    // I-30 требует, чтобы UI не вычислял завершение сам. Прежний путь это
    // делает: SSE-резолвер, HTTP-поллер с окном стабильности и
    // предохранительный таймаут — три источника, сведённые в клиенте. Пока
    // арбитров два, они расходятся молча, и вопрос «чьё состояние правильное»
    // не имеет ответа.
    const fromServer = isVerdictSourceEnabled();

    // --- Новый путь: единственный источник — вердикт сервера ----------
    // Объявлено через let: обработчик снимает собственный интервал, и в const
    // пришлось бы ссылаться на переменную из её же инициализатора.
    let verdictPoller: ReturnType<typeof setInterval> | null = null;
    if (fromServer) {
      verdictPoller = setInterval(async () => {
        if (settled) {
          if (verdictPoller) clearInterval(verdictPoller);
          return;
        }
        let state: unknown;
        try {
          state = await api.turnState(sidStr);
        } catch (e) {
          // Мёртвая сессия разбирается той же ветвью, что и в прежнем пути;
          // сетевой сбой — просто ждём следующего опроса.
          if (e instanceof SessionGoneError) {
            if (verdictPoller) clearInterval(verdictPoller);
            clearTimeout(timeoutId);
            if (!settled) {
              settled = true;
              reject(e);
            }
          }
          return;
        }
        const parsed = parseTurnState(state);
        if (!parsed) return;
        // Проекция кладётся в стор до всякого решения о завершении:
        // интерфейсу она нужна и в состоянии `stuck`, где ход как раз НЕ
        // завершается и ветки ниже не срабатывают.
        onTurnProjection(parsed.turn);
        if (!parsed.orchestrator) {
          // Флаг на клиенте включён, а оркестратора на сервере нет: вердикта
          // не будет никогда. Молча ждать значило бы повесить интерфейс на
          // рассогласовании конфигурации — заметить это потом было бы почти
          // невозможно.
          log.warn(
            "[send] verdict source is on in the client, but the server has no orchestrator",
          );
          if (verdictPoller) clearInterval(verdictPoller);
          clearTimeout(timeoutId);
          done("server:no-orchestrator");
          return;
        }
        // Единственное решение здесь — «интерфейс можно отпускать». Что именно
        // случилось с ходом, решил сервер.
        if (isSettled(parsed.turn)) {
          if (verdictPoller) clearInterval(verdictPoller);
          clearTimeout(timeoutId);
          if (dispositionOf(parsed.turn) === "failed") onFailed();
          done("server:verdict");
        }
        // `stuck` завершением НЕ считается: «мы не знаем» и «всё готово» —
        // разные исходы. Сверка на сервере продолжается и может его разрешить;
        // если не разрешит, интерфейс отпустит страховочный таймаут — но уже
        // не делая вид, что ход успешно закончился.
      }, VERDICT_POLL_MS);
    }

    // --- Прежний путь: SSE-резолвер, поддерживая множественные send() --
    // Если для этой сессии уже есть резолвер (юзер быстро жмёт 2 раза), не
    // теряем его — sessionFsm вызывает оба цепочкой.
    if (!fromServer) {
      sessionFsm.onIdle(
        sidStr,
        () => {
          done("sse:session.idle");
        },
        requestGen,
      );
    }

    // --- HTTP-polling подтверждение финала (страховка от битого SSE) ---
    // Проверяем состояние каждые 3s. Считаем финалом, когда:
    //   - есть хотя бы одно assistant-сообщение
    //   - у него info.finish === "stop"|"error" ИЛИ info.time.completed
    //   - И это состояние подтверждено (3s стабильности)
    // Это защищает от промежуточных finish:"stop" на reasoning-стадии.
    let lastSignature = "";
    const httpPoller = setInterval(async () => {
      if (settled) {
        clearInterval(httpPoller);
        return;
      }
      try {
        const msgs = await api.listMessages(sidStr);
        // REAL-TIME FIX: раньше поллер ПОЛНОСТЬЮ перезаписывал стор серверным
        // снапшотом каждые 3s — это откатывало/дёргало текст, который уже
        // пришёл по SSE, и ответ визуально появлялся «пачками». Теперь
        // используем детерминированный merge: локальный стриминговый текст
        // (длиннее и являющийся префиксным расширением серверного) сохраняется,
        // пока сервер не финализирует сообщение. Поллер остаётся только
        // страховкой от битого SSE.
        // P0-fix: пока SSE здоров ("open"), поллер служит ТОЛЬКО детектором
        // финала и НЕ пишет снапшот в стор — снапшот на мгновение отстаёт от
        // SSE-дельт и откатывал стриминговые reasoning/tool-части (дёргание
        // карточек). Мержим в стор только когда SSE реально не работает.
        // P2-fix: проверяем здоровье SSE именно ДЛЯ ЭТОЙ сессии: глобальный
        // «open» обманывал фоновый чат после переключения — стрим подписан на
        // другую сессию, события сюда не идут, а поллер молчал — текст замирал
        // до переключения обратно.
        const sseHealthy = isSseHealthyForSession(sidStr);
        if (!sseHealthy && Array.isArray(msgs) && msgs.length > 0) {
          onSnapshot(msgs as Message[]);
        }
        // Подтягивание текста выше — это восстановление данных, и оно нужно на
        // любом пути: если SSE сломан, ответу больше откуда взяться. А вот всё,
        // что ниже, — арбитраж завершения, и на новом пути его делает сервер
        // (I-30).
        if (fromServer) return;

        const { isDone, sig } = assistantFinishState(msgs as Message[]);
        // Финал засчитывается только после ДВУХ одинаковых замеров подряд
        // (~6 с тишины). Прежняя ветка «есть completedAt — закрываем
        // немедленно» снимала именно эту защиту, а маркер completed движок
        // ставит на каждом шаге агента: ход закрывался посреди работы, и
        // очередь отправляла следующее сообщение в ещё живой ход. Про
        // инструмент в работе знает уже `assistantFinishState` —
        // сорокасекундный bash не выглядит законченным ходом.
        if (isDone && sig === lastSignature) {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          done("http:stable-finish");
        } else {
          lastSignature = sig;
        }
      } catch (pollErr) {
        // UX-fix: если сессия мертва — прекращаем полить, дальше обработается
        // в catch send()
        if (pollErr instanceof SessionGoneError) {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          if (!settled) {
            settled = true;
            reject(pollErr);
          }
          return;
        }
        // иначе — сеть моргает, продолжаем
      }
    }, 3000);

    // --- Страховочный таймаут ------------------------------------------
    //
    // Остаётся на обоих путях, и это не нарушение I-30. Инвариант запрещает
    // ВЫВОДИТЬ завершение из сигналов; сторож же ничего не выводит — он
    // отпускает интерфейс, когда сервер молчит дольше всякого разумного срока.
    // Убрать его на новом пути значило бы поменять «спиннер до 15 минут» на
    // «спиннер навсегда», если оркестратор почему-то не отдаёт вердикт.
    //
    // Разница в том, что он больше не притворяется успехом: на новом пути
    // срабатывание пишется как отказ сервера, а не как финал.
    const timeoutId = setTimeout(() => {
      if (settled) return;
      log.warn(
        fromServer
          ? `[send] server verdict did not arrive within ${hardTimeoutMs}ms — releasing the UI without a verdict`
          : `[send] hard timeout after ${hardTimeoutMs}ms — forcing completion`,
      );
      clearInterval(httpPoller);
      if (verdictPoller) clearInterval(verdictPoller);
      sessionFsm.clearIdleResolver(sidStr, requestGen);
      done("hard-timeout");
    }, hardTimeoutMs);

    // --- Prompt response handling — if server returns final message directly,
    // complete immediately (fixes Stop hanging)
    promptPromise
      .then((responseMsg) => {
        // null — соединение оборвалось уже ПОСЛЕ доставки промпта (см.
        // retryablePrompt). Ход агента продолжается на сервере, финал
        // подтвердят SSE session.idle или HTTP-поллер.
        if (!responseMsg) return;
        // На новом пути ответ на промпт больше не считается финалом: это ровно
        // тот «один сигнал», по которому EXECUTION_TRUTH §8 запрещает закрывать
        // ход. Тело ответа при этом не игнорируется — его подхватит общий
        // merge, — а решение остаётся за сервером.
        if (fromServer) return;
        // То же правило, что у SSE и поллера: остановка ради инструмента
        // финалом не считается. Отдельная проверка здесь была третьим способом
        // ответить на один вопрос — и единственным, который ещё закрывал ход по
        // маркеру шага.
        const finish = responseMsg?.info?.finish;
        if (finalMarkerOf(responseMsg as Message) === "final") {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          done(
            finish === "error" ? "prompt:finish-error" : "prompt:finish-stop",
          );
        }
      })
      .catch((e) => {
        // Релиз 4: отмена по «Стоп» (AbortError) — не ошибка отправки. Интервал
        // и таймаут не трогаем: финал подтвердят SSE session.idle или поллер —
        // сервер финализирует ответ после abort.
        if (isAbortError(e)) return;
        clearInterval(httpPoller);
        if (verdictPoller) clearInterval(verdictPoller);
        clearTimeout(timeoutId);
        sessionFsm.clearIdleResolver(sidStr, requestGen);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
  });
}
