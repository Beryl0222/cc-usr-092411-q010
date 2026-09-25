const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"];

const eventTypes = new Set([
  "CLAIM_SUBMITTED",
  "CLAIM_REVISED",
  "DESIGN_VERSION_PUBLISHED",
  "DESIGN_SIGNED",
  "MATERIAL_TESTED",
  "COMPONENT_FABRICATED",
  "COMPONENT_HELD",
  "IMPACT_ASSESSED",
  "COMPONENT_DISPOSITIONED",
  "INSTALLATION_CLEARED",
  "COMPONENT_INSTALLED",
  "INSTALLATION_CORRECTED",
  "LABEL_RELEASED",
  "LABEL_CORRECTED",
]);

const aggregateTypes = new Set([
  "historical_claim",
  "design_version",
  "fabrication_batch",
  "installation_release",
  "label",
  "component",
]);

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !eventTypes.has(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !aggregateTypes.has(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  return errors;
}
