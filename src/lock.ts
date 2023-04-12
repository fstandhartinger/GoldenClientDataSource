export class Lock {
  private _locked: boolean;
  private _waitQueue: (() => void)[];

  constructor() {
    this._locked = false;
    this._waitQueue = [];
  }

  async acquire(): Promise<void> {
    if (this._locked) {
      await new Promise<void>((resolve) => this._waitQueue.push(resolve));
    }
    this._locked = true;
  }

  release(): void {
    if (this._waitQueue.length > 0) {
      const nextResolve = this._waitQueue.shift();
      if (nextResolve) {
        nextResolve();
      }
    } else {
      this._locked = false;
    }
  }

  async runWithLock<T>(f: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await f();
    } finally {
      this.release();
    }
  }
}
