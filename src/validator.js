import {
  AGGREGATE_TYPES,
  CERTAINTY_LEVELS,
  CITATION_SCOPES,
  COMPONENT_STATUSES,
  DISPOSITION_DECISIONS,
  EVENT_AGGREGATE,
  EVENT_TYPES,
  ROLES,
  WORK_ITEM_KINDS,
} from "./events.js";

const envelopeRequired = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function isClaimRef(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        isNonEmptyString(item.claim_id) &&
        Number.isInteger(item.claim_version) &&
        item.claim_version >= 1,
    )
  );
}

/**
 * 校验事件信封与负载结构，返回中文错误信息数组；空数组表示通过。
 * 只做形状校验；跨聚合的业务前置条件（会审顺序、职责、版本继承）由 service 层负责。
 * 聚合标识即业务编号（主张号、构件号、批次号等），负载只携带跨聚合引用。
 */
export function validateEvent(record) {
  if (!record || typeof record !== "object") return ["记录必须是对象"];
  const errors = envelopeRequired
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record) {
    if (!EVENT_TYPES.includes(record.event_type)) {
      errors.push(`未知事件类型：${record.event_type}`);
    } else if ("aggregate_type" in record && EVENT_AGGREGATE[record.event_type] !== record.aggregate_type) {
      errors.push(
        `事件 ${record.event_type} 的聚合类型应为 ${EVENT_AGGREGATE[record.event_type]}，实际为 ${record.aggregate_type}`,
      );
    }
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "summary"]) {
    if (name in record && !isNonEmptyString(record[name])) errors.push(`${name} 必须是非空字符串`);
  }
  if ("occurred_at" in record && isNonEmptyString(record.occurred_at) && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法时间");
  }

  return [...errors, ...validatePayload(record)];
}

const payloadChecks = {
  CLAIM_SUBMITTED: (p) => checkClaim(p),
  CLAIM_REVISED: (p) => checkClaim(p, true),
  DESIGN_VERSION_PROPOSED: checkDesignProposed,
  DESIGN_REVIEWED: checkDesignReviewed,
  MATERIAL_TESTED: checkMaterialTested,
  COMPONENT_STATUS_CHANGED: checkComponentStatus,
  COMPONENT_FABRICATED: checkComponentFabricated,
  COMPONENT_DISPOSITION_RECORDED: checkDisposition,
  INSTALLATION_CLEARED: checkInstallationCleared,
  LABEL_RELEASED: checkLabelReleased,
  LABEL_CORRECTED: checkLabelCorrected,
  WORK_ITEM_RAISED: checkWorkRaised,
  WORK_ITEM_COMPLETED: checkWorkCompleted,
};

function validatePayload(record) {
  const check = payloadChecks[record.event_type];
  if (!check) return [];
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    return ["payload 必须是对象"];
  }
  return check(record.payload);
}

/** 主张负载：内容、证据版本、确定性等级、允许引用范围。 */
function checkClaim(p, revised = false) {
  const errors = [];
  if (!isNonEmptyString(p.statement)) errors.push("statement 必须是非空字符串");
  if (!isNonEmptyString(p.evidence_id)) errors.push("evidence_id 必须是非空字符串");
  if (!isNonEmptyString(p.evidence_version)) errors.push("evidence_version 必须是非空字符串");
  if (!CERTAINTY_LEVELS.includes(p.certainty))
    errors.push(`certainty 必须是 ${CERTAINTY_LEVELS.join(" / ")} 之一`);
  if (!Array.isArray(p.allowed_citation) || p.allowed_citation.length === 0)
    errors.push("allowed_citation 必须是非空数组");
  else if (!p.allowed_citation.every((s) => CITATION_SCOPES.includes(s)))
    errors.push(`allowed_citation 取值只能是 ${CITATION_SCOPES.join(" / ")}`);
  if (!isNonEmptyString(p.historian)) errors.push("historian 必须是非空字符串");
  if (revised) {
    if (!isNonEmptyString(p.reason)) errors.push("reason 必须说明修订理由");
    if (!isNonEmptyString(p.supersedes_version_event))
      errors.push("supersedes_version_event 必须指向被修订的主张版本事件");
  }
  return errors;
}

/** 设计版本负载：明确采用哪些史实（含版本）与哪些艺术推断。 */
function checkDesignProposed(p) {
  const errors = [];
  if (!isClaimRef(p.based_on_claims) || p.based_on_claims.length === 0)
    errors.push("based_on_claims 必须是 { claim_id, claim_version } 非空数组");
  if (!Array.isArray(p.artistic_inferences) || !p.artistic_inferences.every(isValidInference))
    errors.push("artistic_inferences 必须是 { inference_id, basis_claim, rationale } 数组");
  if (!isStringArray(p.components) || p.components.length === 0)
    errors.push("components 必须是非空字符串数组");
  if (!isNonEmptyString(p.designer)) errors.push("designer 必须是非空字符串");
  if ("predecessor_event" in p && !isNonEmptyString(p.predecessor_event))
    errors.push("predecessor_event 必须是非空字符串");
  return errors;
}

function isValidInference(item) {
  return (
    item &&
    typeof item === "object" &&
    isNonEmptyString(item.inference_id) &&
    isNonEmptyString(item.basis_claim) &&
    isNonEmptyString(item.rationale)
  );
}

/** 会审签署负载：角色、结论、覆盖范围。 */
function checkDesignReviewed(p) {
  const errors = [];
  if (!Object.values(ROLES).includes(p.role)) errors.push("role 必须是已知会审角色");
  if (!["facts_confirmed", "inference_accepted", "inference_rejected", "referred_back"].includes(p.decision))
    errors.push("decision 必须是 facts_confirmed / inference_accepted / inference_rejected / referred_back");
  if (!isNonEmptyString(p.reviewer)) errors.push("reviewer 必须是非空字符串");
  if (!isStringArray(p.scope_refs) || p.scope_refs.length === 0)
    errors.push("scope_refs 必须是非空字符串数组（本次签署覆盖的主张或推断编号）");
  return errors;
}

function checkMaterialTested(p) {
  const errors = [];
  if (!isNonEmptyString(p.component_code)) errors.push("component_code 必须是非空字符串");
  if (!isNonEmptyString(p.material_spec)) errors.push("material_spec 必须是非空字符串");
  if (typeof p.passed !== "boolean") errors.push("passed 必须是布尔值");
  if (!isNonEmptyString(p.structural_engineer)) errors.push("structural_engineer 必须是非空字符串");
  if ("replaces_batch" in p && !isNonEmptyString(p.replaces_batch))
    errors.push("replaces_batch 必须是非空字符串（被替代的原批次）");
  if ("test_report" in p && !isNonEmptyString(p.test_report)) errors.push("test_report 必须是非空字符串");
  return errors;
}

function checkComponentStatus(p) {
  const errors = [];
  if (!COMPONENT_STATUSES.includes(p.from_status))
    errors.push(`from_status 必须是 ${COMPONENT_STATUSES.join(" / ")} 之一`);
  if (!COMPONENT_STATUSES.includes(p.to_status))
    errors.push(`to_status 必须是 ${COMPONENT_STATUSES.join(" / ")} 之一`);
  if (!isNonEmptyString(p.reason)) errors.push("reason 必须是非空字符串");
  if ("trigger_event_id" in p && !isNonEmptyString(p.trigger_event_id))
    errors.push("trigger_event_id 必须是非空字符串");
  return errors;
}

function checkComponentFabricated(p) {
  const errors = [];
  if (!isNonEmptyString(p.batch_code)) errors.push("batch_code 必须是非空字符串");
  if (!isNonEmptyString(p.fabricator)) errors.push("fabricator 必须是非空字符串");
  return errors;
}

function checkDisposition(p) {
  const errors = [];
  if (!DISPOSITION_DECISIONS.includes(p.decision))
    errors.push(`decision 必须是 ${DISPOSITION_DECISIONS.join(" / ")} 之一`);
  if (!isNonEmptyString(p.rationale)) errors.push("rationale 必须是非空字符串");
  if (!isNonEmptyString(p.trigger_event_id)) errors.push("trigger_event_id 必须指向触发处置的修订事件");
  return errors;
}

function checkInstallationCleared(p) {
  const errors = [];
  if (!isNonEmptyString(p.structural_engineer)) errors.push("structural_engineer 必须是非空字符串");
  if (!isNonEmptyString(p.design_event_id)) errors.push("design_event_id 必须指向通过会审的设计版本事件");
  if (!isStringArray(p.evidence_event_ids) || p.evidence_event_ids.length === 0)
    errors.push("evidence_event_ids 必须是非空字符串数组（试验/处置等依据事件）");
  return errors;
}

function checkLabelReleased(p) {
  const errors = [];
  if (!isNonEmptyString(p.component_code)) errors.push("component_code 必须是非空字符串");
  if (!isClaimRef(p.cited_claims) || p.cited_claims.length === 0)
    errors.push("cited_claims 必须是 { claim_id, claim_version } 非空数组");
  if (!isNonEmptyString(p.text)) errors.push("text 必须是非空字符串");
  if (!isNonEmptyString(p.curator)) errors.push("curator 必须是非空字符串");
  if (!isNonEmptyString(p.release_event_id)) errors.push("release_event_id 必须指向安装放行事件");
  return errors;
}

function checkLabelCorrected(p) {
  const errors = [];
  if (!isNonEmptyString(p.original_release_event_id))
    errors.push("original_release_event_id 必须指向原发布事件");
  if (!isNonEmptyString(p.correction_text)) errors.push("correction_text 必须是非空字符串");
  if (!isNonEmptyString(p.reason)) errors.push("reason 必须是非空字符串");
  if (!isNonEmptyString(p.trigger_event_id)) errors.push("trigger_event_id 必须指向触发更正的修订事件");
  if (!isClaimRef(p.cited_claims) || p.cited_claims.length === 0)
    errors.push("cited_claims 必须是 { claim_id, claim_version } 非空数组（更正后引用的主张版本）");
  if (!isNonEmptyString(p.curator)) errors.push("curator 必须是非空字符串");
  return errors;
}

function checkWorkRaised(p) {
  const errors = [];
  if (!WORK_ITEM_KINDS.includes(p.kind)) errors.push(`kind 必须是 ${WORK_ITEM_KINDS.join(" / ")} 之一`);
  if (!isNonEmptyString(p.component_code)) errors.push("component_code 必须是非空字符串");
  if (!isNonEmptyString(p.trigger_event_id)) errors.push("trigger_event_id 必须指向产生待办的事件");
  if (!Number.isInteger(p.sequence) || p.sequence < 1) errors.push("sequence 必须是正整数");
  return errors;
}

function checkWorkCompleted(p) {
  const errors = [];
  if (!isNonEmptyString(p.resolution_event_id)) errors.push("resolution_event_id 必须指向办结事件");
  return errors;
}
