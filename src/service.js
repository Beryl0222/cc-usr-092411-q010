import { ReviewChain } from "./chain.js";
import { EventLog } from "./log.js";
import { pendingTodos, traceComponent } from "./projection.js";

/**
 * 会审服务装配：命令先在内存中通过全部业务校验，再把事件整批写入只追加日志。
 * 进程中断后调用 load() 从日志重放，状态与待办顺序逐位恢复。
 */
export class ReviewService {
  constructor(logPath, { now } = {}) {
    this.log = new EventLog(logPath);
    this._now = now;
    this.chain = new ReviewChain({ now });
    this.loaded = false;
  }

  async load() {
    const events = await this.log.readAll();
    this.chain = ReviewChain.restore(events, { now: this._now });
    this.loaded = true;
    return events.length;
  }

  /** 执行命令并持久化。返回 { replayed, events }；整批事件一次写入。 */
  async execute(method, command) {
    if (typeof this.chain[method] !== "function") throw new Error(`未知命令：${method}`);
    const result = this.chain[method](command);
    if (!result.replayed) await this.log.append(result.events);
    return result;
  }

  pendingTodos() {
    return pendingTodos(this.chain.state);
  }

  traceComponent(componentId) {
    return traceComponent(this.chain.state, componentId);
  }
}
