import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AggregateType, EventType } from "../src/constants.js";
import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("代码常量与 JSON Schema 的事件/聚合枚举保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), Object.values(EventType).sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), Object.values(AggregateType).sort());
  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"]) {
    assert.ok(name in schema.properties, `schema 缺少字段 ${name}`);
  }
});
