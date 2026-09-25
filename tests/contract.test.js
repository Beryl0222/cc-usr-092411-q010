import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES } from "../src/events.js";
import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("契约枚举与领域常量一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.event_type.enum, [...EVENT_TYPES]);
  assert.deepEqual(schema.properties.aggregate_type.enum, [...AGGREGATE_TYPES]);
});

test("信封校验拒绝缺字段、未知类型与非法版本", () => {
  assert.ok(validateEvent({}).length > 0);
  const base = {
    event_id: "e1",
    event_type: "CLAIM_SUBMITTED",
    aggregate_type: "historical_claim",
    aggregate_id: "CLM-X",
    occurred_at: "2026-09-25T00:00:00+08:00",
    version: 1,
    summary: "测试",
    payload: {
      statement: "s",
      evidence_id: "E",
      evidence_version: "v1",
      certainty: "confirmed",
      allowed_citation: ["design"],
      historian: "h",
    },
  };
  assert.deepEqual(validateEvent(base), []);
  assert.ok(validateEvent({ ...base, event_type: "NOPE" }).some((e) => e.includes("未知事件类型")));
  assert.ok(validateEvent({ ...base, aggregate_type: "component" }).some((e) => e.includes("聚合类型应为")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((e) => e.includes("version")));
  assert.ok(validateEvent({ ...base, payload: { ...base.payload, certainty: "maybe" } }).some((e) => e.includes("certainty")));
  assert.ok(validateEvent({ ...base, payload: { ...base.payload, allowed_citation: ["label", "sky"] } }).some((e) => e.includes("allowed_citation")));
});
