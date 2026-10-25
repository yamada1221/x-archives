'use strict';
(function (root) {
  class Store {
    async database() {
      if (!this.db) this.db = new Promise((resolve, reject) => {
        const r = indexedDB.open('x-tracker-auto-archive', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('state');
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('拡張機能の保存領域を開けません'));
      });
      return this.db;
    }
    async get(key, fallback = null) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state'); const r = tx.objectStore('state').get(key);
        r.onsuccess = () => resolve(r.result ?? fallback); tx.onerror = () => reject(Error('進捗を読み込めません'));
      });
    }
    async set(key, value) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, key);
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(Error('進捗を保存できません。処理を停止しました'));
      });
    }
    async acquire(key, owner, now) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state'); let acquired = false;
        const r = store.get('lock:' + key);
        r.onsuccess = () => {
          if (!r.result || r.result.expires <= now) { store.put({ owner, expires: now + 10 * 60000 }, 'lock:' + key); acquired = true; }
        };
        tx.oncomplete = () => resolve(acquired); tx.onerror = tx.onabort = () => reject(Error('実行ロックを保存できません'));
      });
    }
    async release(key, owner) {
      const db = await this.database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state'), r = store.get('lock:' + key);
        r.onsuccess = () => { if (r.result?.owner === owner) store.delete('lock:' + key); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(Error('実行ロックを解除できません'));
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = Store; else root.AutoArchiveStore = Store;
})(globalThis);
