import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class OcrWorker {
  constructor({
    command,
    args,
    idleMs = 300_000,
    startTimeoutMs = 45_000,
    requestTimeoutMs = 45_000,
    maxQueue = 16
  }) {
    this.command = command;
    this.args = args;
    this.idleMs = idleMs;
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxQueue = maxQueue;
    this.child = null;
    this.readyPromise = null;
    this.reader = null;
    this.queue = [];
    this.active = null;
    this.nextId = 1;
    this.idleTimer = null;
    this.spawns = 0;
    this.completed = 0;
    this.closed = false;
  }

  stats() {
    return {
      running: Boolean(this.child && this.child.exitCode === null && !this.child.killed),
      spawns: this.spawns,
      completed: this.completed,
      queued: this.queue.length
    };
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdle() {
    this._clearIdle();
    if (!this.idleMs || !this.child || this.active || this.queue.length) return;
    this.idleTimer = setTimeout(() => {
      if (!this.active && !this.queue.length) this._terminate('idle');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  _terminate(reason = 'reset') {
    this._clearIdle();
    const child = this.child;
    const reader = this.reader;
    this.child = null;
    this.reader = null;
    this.readyPromise = null;
    if (reader) {
      reader.removeAllListeners();
      reader.close();
    }
    if (child) {
      child.removeAllListeners();
      try {
        if (reason === 'idle' || reason === 'close') child.stdin?.end();
      } catch { /* ignore */ }
      try {
        if (child.exitCode === null && !child.killed) child.kill();
      } catch { /* ignore */ }
    }
  }

  _ensureStarted() {
    if (this.closed) return Promise.reject(Error('OCR 工作进程已关闭。'));
    if (this.readyPromise && this.child && this.child.exitCode === null) return this.readyPromise;
    this._terminate('restart');
    this.spawns += 1;
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    let stderrTail = '';
    child.stderr?.on('data', chunk => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader = reader;

    let readyResolved = false;
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.readyPromise = readyPromise;

    const startTimer = setTimeout(() => {
      if (readyResolved) return;
      readyResolved = true;
      this._terminate('start-timeout');
      rejectReady(Error('OCR 常驻进程启动超时。'));
    }, this.startTimeoutMs);
    startTimer.unref?.();

    const failProcess = message => {
      clearTimeout(startTimer);
      if (this.child === child) this._terminate('crash');
      const error = Error(message);
      if (!readyResolved) {
        readyResolved = true;
        rejectReady(error);
      }
      if (this.active && this.active.child === child) {
        const current = this.active;
        this.active = null;
        current.cleanup();
        current.reject(error);
        this._drain();
      }
    };

    reader.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!readyResolved) {
        if (payload.ready === true) {
          readyResolved = true;
          clearTimeout(startTimer);
          resolveReady();
        }
        return;
      }
      if (!this.active || payload.id !== this.active.id) return;
      const current = this.active;
      this.active = null;
      current.cleanup();
      if (payload.error) {
        current.reject(Error(String(payload.error)));
      } else if (!Array.isArray(payload.lines)) {
        current.reject(Error('Invalid OCR result'));
      } else {
        this.completed += 1;
        current.resolve({ lines: payload.lines });
      }
      this._drain();
    });

    child.on('error', err => failProcess(`OCR 常驻进程启动失败：${err.code || err.message}`));
    child.on('exit', (code, signal) => {
      const reason = stderrTail.trim().split('\n').at(-1);
      failProcess(`OCR 常驻进程异常退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}${reason ? `, ${reason}` : ''}）。`);
    });

    return readyPromise;
  }

  recognize(imagePath, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (this.closed) return Promise.reject(Error('OCR 工作进程已关闭。'));
    if (signal?.aborted) return Promise.reject(Error('OCR 请求已取消。'));
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(Error('本机 OCR 队列繁忙，请稍后重试。'));
    }
    return new Promise((resolve, reject) => {
      const task = { imagePath, timeoutMs, signal, resolve, reject, onQueuedAbort: null };
      if (signal) {
        task.onQueuedAbort = () => {
          const index = this.queue.indexOf(task);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(Error('OCR 请求已取消。'));
          }
        };
        signal.addEventListener('abort', task.onQueuedAbort, { once: true });
      }
      this.queue.push(task);
      this._drain();
    });
  }

  _drain() {
    if (this.active) return;
    const task = this.queue.shift();
    if (!task) {
      this._scheduleIdle();
      return;
    }
    this._clearIdle();
    if (task.onQueuedAbort) task.signal?.removeEventListener('abort', task.onQueuedAbort);
    if (task.signal?.aborted) {
      task.reject(Error('OCR 请求已取消。'));
      this._drain();
      return;
    }

    const id = this.nextId++;
    let timer = null;
    const onActiveAbort = () => {
      if (this.active?.id !== id) return;
      const current = this.active;
      this.active = null;
      current.cleanup();
      this._terminate('abort');
      current.reject(Error('OCR 请求已取消。'));
      this._drain();
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (task.signal) task.signal.removeEventListener('abort', onActiveAbort);
    };
    // Claim the active slot synchronously BEFORE async startup to serialize concurrent callers.
    this.active = { id, child: null, resolve: task.resolve, reject: task.reject, cleanup };
    if (task.signal) task.signal.addEventListener('abort', onActiveAbort, { once: true });

    this._ensureStarted().then(() => {
      if (this.active?.id !== id) return;
      if (task.signal?.aborted) {
        onActiveAbort();
        return;
      }
      const child = this.child;
      if (!child || child.exitCode !== null || !child.stdin?.writable) {
        const current = this.active;
        this.active = null;
        current.cleanup();
        current.reject(Error('OCR 常驻进程不可用。'));
        this._drain();
        return;
      }
      this.active.child = child;
      timer = setTimeout(() => {
        if (this.active?.id !== id) return;
        const current = this.active;
        this.active = null;
        current.cleanup();
        this._terminate('timeout');
        current.reject(Error('OCR 识别超时。'));
        this._drain();
      }, task.timeoutMs);
      timer.unref?.();

      child.stdin.write(`${JSON.stringify({ id, image: task.imagePath })}\n`, err => {
        if (err && this.active?.id === id) {
          const current = this.active;
          this.active = null;
          current.cleanup();
          this._terminate('write-error');
          current.reject(Error(`OCR 进程写入失败：${err.message}`));
          this._drain();
        }
      });
    }).catch(error => {
      if (this.active?.id === id) {
        const current = this.active;
        this.active = null;
        current.cleanup();
        current.reject(error);
      }
      this._drain();
    });
  }

  close() {
    this.closed = true;
    const error = Error('OCR 工作进程已关闭。');
    while (this.queue.length) {
      const task = this.queue.shift();
      if (task.onQueuedAbort) task.signal?.removeEventListener('abort', task.onQueuedAbort);
      task.reject(error);
    }
    if (this.active) {
      const current = this.active;
      this.active = null;
      current.cleanup();
      current.reject(error);
    }
    this._terminate('close');
  }
}
