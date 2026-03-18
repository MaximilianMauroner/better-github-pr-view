interface FetchQueueItem<T> {
  taskFactory: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class FetchQueue {
  private activeFetches = 0;
  private readonly queue: Array<FetchQueueItem<unknown>> = [];

  constructor(private readonly maxConcurrentFetches: number) {}

  enqueue<T>(taskFactory: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        taskFactory: taskFactory as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeFetches < this.maxConcurrentFetches && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        continue;
      }

      this.activeFetches += 1;
      next.taskFactory()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.activeFetches -= 1;
          this.pump();
        });
    }
  }
}
