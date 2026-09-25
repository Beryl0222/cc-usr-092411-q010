import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ConflictError, ConcurrencyError, DomainError } from "./errors.js";

/**
 * 追加式事件存储。
 *
 * - 事件一旦写入不得原地改写；业务更正只能追加后继事件。
 * - 每个命令携带 request_id 与内容指纹：同编号且内容一致视为重放，直接返回首次结果；
 *   同编号但内容不一致视为冲突，拒绝执行。
 * - 聚合版本单调递增，写入前校验期望版本，防止并发签署越过前序条件。
 * - 可选 JSONL 文件持久化，重启后按原顺序重放，待办顺序不变。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #requests = new Map();
  #aggregateVersions = new Map();
  #filePath;

  constructor(filePath = null) {
    this.#filePath = filePath;
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) this.#restore(JSON.parse(line));
    }
  }

  get size() {
    return this.#events.length;
  }

  all() {
    return [...this.#events];
  }

  byId(eventId) {
    return this.#byId.get(eventId) ?? null;
  }

  /** 已接收请求的记录；未接收返回 null。 */
  lookupRequest(requestId) {
    const record = this.#requests.get(requestId);
    if (!record) return null;
    return { fingerprint: record.fingerprint, events: record.events.map((id) => this.#byId.get(id)) };
  }

  /** 聚合当前版本（无事件时为 0）。 */
  aggregateVersion(aggregateType, aggregateId) {
    return this.#aggregateVersions.get(`${aggregateType}:${aggregateId}`) ?? 0;
  }

  /** 聚合的全部事件，按写入顺序。 */
  eventsOf(aggregateType, aggregateId) {
    return this.#events.filter(
      (event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId,
    );
  }

  /**
   * 以命令方式追加事件。
   * @param {object} command
   * @param {string} command.request_id 调用方请求编号（幂等键）
   * @param {string} command.fingerprint 命令业务内容指纹（由服务层对请求内容计算）
   * @param {Array} command.events 待追加事件草稿；须含 event_id（服务层按请求编号派生，
   *   以便同一命令内的事件互相引用），version 与 occurred_at 由存储分配
   * @param {string} [command.occurred_at]
   * @returns {{ events: Array, replayed: boolean }}
   */
  dispatch(command) {
    if (!command || typeof command.request_id !== "string" || command.request_id.trim() === "") {
      throw new DomainError("命令必须携带 request_id");
    }
    if (typeof command.fingerprint !== "string" || command.fingerprint === "") {
      throw new DomainError("命令必须携带内容指纹");
    }
    if (!Array.isArray(command.events) || command.events.length === 0) {
      throw new DomainError("命令必须产生至少一条事件");
    }

    const prior = this.#requests.get(command.request_id);
    if (prior) {
      if (prior.fingerprint !== command.fingerprint) {
        throw new ConflictError(`请求 ${command.request_id} 与已接收内容不一致，不构成重放`);
      }
      return { events: prior.events.map((id) => this.#byId.get(id)), replayed: true };
    }

    const occurredAt = command.occurred_at ?? new Date().toISOString();
    const appended = [];
    for (const draft of command.events) {
      for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "summary", "payload"]) {
        if (draft[field] === undefined) throw new DomainError(`事件草稿缺少字段：${field}`);
      }
      if (this.#byId.has(draft.event_id)) {
        throw new ConflictError(`事件标识 ${draft.event_id} 已存在`);
      }
      const key = `${draft.aggregate_type}:${draft.aggregate_id}`;
      const expected = this.#aggregateVersions.get(key) ?? 0;
      if (draft.expected_version !== undefined && draft.expected_version !== expected) {
        throw new ConcurrencyError(
          `聚合 ${draft.aggregate_type}/${draft.aggregate_id} 期望版本 ${draft.expected_version}，实际 ${expected}`,
        );
      }
      const event = {
        ...draft,
        occurred_at: occurredAt,
        version: expected + 1,
      };
      delete event.expected_version;
      this.#events.push(event);
      this.#byId.set(event.event_id, event);
      this.#aggregateVersions.set(key, event.version);
      appended.push(event);
    }
    this.#requests.set(command.request_id, {
      fingerprint: command.fingerprint,
      events: appended.map((e) => e.event_id),
    });
    this.#persist(command.request_id, command.fingerprint, appended);
    return { events: appended, replayed: false };
  }

  #persist(requestId, fingerprint, events) {
    if (!this.#filePath) return;
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const line = JSON.stringify({ request_id: requestId, fingerprint, events }) + "\n";
    appendFileSync(this.#filePath, line, "utf8");
  }

  #restore(record) {
    for (const event of record.events) {
      this.#events.push(event);
      this.#byId.set(event.event_id, event);
      this.#aggregateVersions.set(`${event.aggregate_type}:${event.aggregate_id}`, event.version);
    }
    this.#requests.set(record.request_id, {
      fingerprint: record.fingerprint,
      events: record.events.map((e) => e.event_id),
    });
  }
}

/** 内容指纹：同编号请求只有内容一致才算重放。键序无关，值序敏感。 */
export function fingerprintOf(value) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(value, canonicalReplacer));
  return hash.digest("hex");
}

function canonicalReplacer(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
  }
  return value;
}

/** 供测试/演示清空存储文件。 */
export function resetFile(filePath) {
  if (existsSync(filePath)) writeFileSync(filePath, "", "utf8");
}
