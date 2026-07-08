import { Subject, firstValueFrom } from "rxjs";
import { timeout } from "rxjs/operators";

export interface PendingRequest<T = unknown> {
  id: string;
  subject: Subject<T>;
  createdAt: number;
}

export class RequestManager<T = unknown> {
  private readonly pending = new Map<string, PendingRequest<T>>();

  constructor(private readonly timeoutMs: number) {}

  create(): PendingRequest<T> {
    const request: PendingRequest<T> = {
      id: crypto.randomUUID(),
      subject: new Subject<T>(),
      createdAt: Date.now(),
    };

    this.pending.set(request.id, request);

    return request;
  }

  async wait(request: PendingRequest<T>): Promise<T> {
    try {
      return await firstValueFrom(
        request.subject.pipe(timeout(this.timeoutMs)),
      );
    } finally {
      this.pending.delete(request.id);
    }
  }

  resolve(id: string, payload: T): boolean {
    const request = this.pending.get(id);

    if (!request) return false;

    request.subject.next(payload);
    request.subject.complete();

    this.pending.delete(id);

    return true;
  }

  reject(id: string, error: Error): boolean {
    const request = this.pending.get(id);

    if (!request) return false;

    request.subject.error(error);

    this.pending.delete(id);

    return true;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  get(id: string): PendingRequest<T> | undefined {
    return this.pending.get(id);
  }

  clear(error: Error = new Error("Pending request cancelled.")): void {
    for (const request of this.pending.values()) {
      request.subject.error(error);
    }

    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  get ids(): readonly string[] {
    return [...this.pending.keys()];
  }
}
