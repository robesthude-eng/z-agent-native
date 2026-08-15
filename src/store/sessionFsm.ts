// P1.6 → Релиз 4: конечный автомат состояния сессии (busy/idle) с поколениями
// запросов. Каждый send() получает монотонный номер поколения (beginRequest);
// markIdle/clearIdleResolver с номером действуют только на своё поколение —
// зависший старый send() (hard-timeout, поздний поллер) не может снять busy
// или стереть idle-резолвер более нового запроса.
// Чистый класс без React и сети — легко тестировать (см. sessionFsm.test.ts).

export class SessionFsm {
  /**
   * Последний выданный номер поколения per session. Монотонный, не
   * сбрасывается markIdle — по нему isCurrent() отличает актуальный
   * запрос от устаревшего.
   */
  private generations = new Map<string, number>();
  /** Поколение, владеющее busy-состоянием сессии (нет записи — idle). */
  private active = new Map<string, number>();
  /** Idle-резолверы: sessionId → (поколение → колбэк). */
  private idleResolvers = new Map<string, Map<number, () => void>>();

  /** Начать новый запрос: выдать поколение и пометить сессию busy. */
  beginRequest(sessionId: string): number {
    const gen = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, gen);
    this.active.set(sessionId, gen);
    return gen;
  }

  /** true, если это поколение всё ещё последнее (новее не стартовало). */
  isCurrent(sessionId: string, generation: number): boolean {
    return (this.generations.get(sessionId) ?? 0) === generation;
  }

  /**
   * Номер текущего поколения (0 — запросов ещё не было).
   *
   * Нужен ключу идемпотентности отмены: он обязан быть одинаковым для всех
   * нажатий «Стоп» по одному и тому же ходу и разным — для следующего хода
   * (I-13). Поколение — уже существующая в этом классе величина ровно с такой
   * семантикой, и заводить рядом второй счётчик было бы вторым источником
   * правды об одном и том же.
   */
  currentGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** true, если send() для этой сессии ещё не завершился. */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Легаси-обёртка: пометить busy без получения номера поколения. */
  markBusy(sessionId: string): void {
    this.beginRequest(sessionId);
  }

  /**
   * Снять пометку активности (конец send() или ошибка). С указанным
   * поколением — только если оно всё ещё владеет busy; устаревший вызов — no-op.
   * Без поколения — безусловно (легаси-семантика __locallyBusy.delete()).
   * Резолверы не трогаем — их снимает та ветка, которая реально завершила ожидание.
   */
  markIdle(sessionId: string, generation?: number): void {
    if (generation !== undefined && this.active.get(sessionId) !== generation) {
      return;
    }
    this.active.delete(sessionId);
  }

  /**
   * Зарегистрировать резолвер завершения для поколения (по умолчанию — последнего).
   * Повторная регистрация в том же поколении не теряет предыдущий колбэк —
   * вызывает его цепочкой (прежняя семантика __idleResolvers.set).
   */
  onIdle(sessionId: string, resolver: () => void, generation?: number): void {
    const gen = generation ?? this.generations.get(sessionId) ?? 0;
    let byGen = this.idleResolvers.get(sessionId);
    if (!byGen) {
      byGen = new Map();
      this.idleResolvers.set(sessionId, byGen);
    }
    const prev = byGen.get(gen);
    byGen.set(
      gen,
      prev
        ? () => {
            try {
              prev();
            } catch {
              /* прежнее поведение: ошибка предыдущего резолвера глотается */
            }
            resolver();
          }
        : resolver,
    );
  }

  /**
   * Снять резолвер без вызова. С поколением — только свой (чужие send()
   * продолжают ждать); без поколения — все (легаси-семантика).
   */
  clearIdleResolver(sessionId: string, generation?: number): void {
    if (generation === undefined) {
      this.idleResolvers.delete(sessionId);
      return;
    }
    const byGen = this.idleResolvers.get(sessionId);
    if (!byGen) return;
    byGen.delete(generation);
    if (byGen.size === 0) this.idleResolvers.delete(sessionId);
  }

  /**
   * Вызвать и снять все резолверы сессии (session.idle пришёл — завершились
   * все ожидающие send()). Возвращает true, если хоть один вызван.
   * Ошибки каждого резолвера глотаются, чтобы сбой одного send() не
   * блокировал завершение остальных.
   */
  resolveIdle(sessionId: string): boolean {
    const byGen = this.idleResolvers.get(sessionId);
    if (!byGen || byGen.size === 0) return false;
    this.idleResolvers.delete(sessionId);
    for (const resolve of byGen.values()) {
      try {
        resolve();
      } catch {
        /* см. выше */
      }
    }
    return true;
  }

  /**
   * Ожидать перехода сессии в состояние idle после вызова abort() или запроса.
   * Если сессия уже idle, возвращает true немедленно.
   */
  waitForIdle(sessionId: string, maxWaitMs = 15000): Promise<boolean> {
    if (!this.isBusy(sessionId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this.clearIdleResolver(sessionId);
          resolve(false);
        }
      }, maxWaitMs);
      this.onIdle(sessionId, () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  /** Полный сброс (для тестов). */
  reset(): void {
    this.generations.clear();
    this.active.clear();
    this.idleResolvers.clear();
  }
}

/** Единственный экземпляр на приложение — как прежние модульные переменные. */
export const sessionFsm = new SessionFsm();
