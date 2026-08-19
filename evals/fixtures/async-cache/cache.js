export class Cache {
  #pending = new Map();
  async get(key, load) {
    if (this.#pending.has(key)) return this.#pending.get(key);
    const promise = load();
    this.#pending.set(key, promise);
    return await promise;
  }
}
