import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { applyEvent, createState } from "./projection.js";

/**
 * 只追加 JSONL 事件日志：事件一旦写入，其标识、发生时间和版本不被原地改写。
 * 每行一个事件信封；进程中断后从头读取重放即可恢复全部状态与待办顺序。
 */
export class EventLog {
  constructor(path) {
    this.path = path;
  }

  async append(events) {
    await mkdir(dirname(this.path), { recursive: true });
    const line = events.map((event) => JSON.stringify(event)).join("\n");
    await appendFile(this.path, `${line}\n`, "utf8");
  }

  async readAll() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  /** 只读重放校验：用于启动核对或测试中断恢复。 */
  async replay() {
    const state = createState();
    for (const event of await this.readAll()) applyEvent(state, event);
    return state;
  }
}
