import { createHash } from "node:crypto";

import { validateEvent } from "./validator.js";

/**
 * 不可变事件信封。事件一旦写入日志，其标识、发生时间、版本与载荷不得原地改写；
 * 任何业务更正都必须产生后继事件。
 */
export function makeEvent({ eventId, eventType, aggregateType, aggregateId, occurredAt, version, summary, payload = {}, causationId = null, requestId = null, requestHash = null }) {
  const event = {
    event_id: eventId,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version,
    summary,
    payload,
    causation_id: causationId,
    request_id: requestId,
    request_hash: requestHash,
  };
  const errors = validateEvent(event);
  if (errors.length > 0) throw new Error(`事件信封不合法：${errors.join("；")}`);
  return Object.freeze(event);
}

/**
 * 顺序可重现的事件标识生成器：时间戳 + 链内序号（由调用方传入 state.seq+1）。
 * 同一命令产生多个事件时序号自然递增；不同链实例互不干扰，便于重放对比。
 */
export function newEventId(now, seq) {
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `evt-${stamp}-${seq.toString(16).padStart(4, "0")}`;
}

/**
 * 请求重放判定：同编号请求只有内容一致才算重放。
 * 对命令的业务内容做规范化哈希；同 request_id 且哈希相同 -> 重放；
 * 同 request_id 但哈希不同 -> 冲突，拒绝。
 */
export function contentHash(command) {
  const { request_id: _ignore, ...rest } = command;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
