import { FINAL_SETTLE_MS } from "../api/turnFinality";

/**
 * Арбитр финального маркера: окно стабилизации на клиенте.
 *
 * Маркер завершённости («шаг закончен») приходит на КАЖДОМ шаге агента, и до
 * этого арбитра клиент закрывал ход по первому же такому событию. Теперь
 * маркер только взводит таймер: любая дальнейшая активность в сессии его
 * снимает, и ход закрывается лишь тишиной длиной `FINAL_SETTLE_MS`. Ровно то
 * же делает `turn-reconciler.mjs` на сервере — правило одно, записано дважды
 * только потому, что оркестратор выключен по умолчанию.
 *
 * Собственный источник правды здесь не заводится: таймер лишь откладывает то
 * самое действие, которое раньше выполнялось немедленно.
 *
 * Почему отдельный класс, а не пара функций над `Map` внутри слайса. Таймеры
 * жили модульной переменной в тысячестрочном файле, и единственным способом
 * до них дотянуться был экспорт `resetFinalSettleTimers` — заведённый «для
 * тестов» и не использованный ни одним тестом. Состояние, которое приходится
 * сбрасывать снаружи, не принадлежит модулю, в котором лежит. Тот же приём и
 * по той же причине уже применён к `SessionFsm`.
 */
export class TurnSettle {
  /** sessionId → отложенное закрытие хода. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Снять отложенное закрытие (пришла активность или явный idle). */
  cancel(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    this.timers.delete(sessionId);
  }

  /**
   * Взвести отложенное закрытие хода.
   *
   * Повторный маркер ПРОДЛЕВАЕТ окно, а не заводит второй таймер: иначе
   * первый сработал бы посреди продолжающейся работы. Отсюда `cancel` первым
   * действием — это не защита от утечки, а само правило.
   */
  arm(sessionId: string, close: () => void): void {
    this.cancel(sessionId);
    const t = setTimeout(() => {
      this.timers.delete(sessionId);
      close();
    }, FINAL_SETTLE_MS);
    this.timers.set(sessionId, t);
  }

  /** Ждёт ли эта сессия отложенного закрытия. */
  isPending(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  /** Сколько сессий ждут закрытия (для тестов и диагностики). */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** Снять все отложенные закрытия: размонтирование и изоляция тестов. */
  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Общий на приложение экземпляр — как `sessionFsm`. */
export const turnSettle = new TurnSettle();
