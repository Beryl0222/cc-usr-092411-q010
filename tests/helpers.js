import { ReviewService } from "../src/service.js";
import { EventStore } from "../src/store.js";

export const AT = "2026-09-25T09:00:00+08:00";

export function makeService(filePath = null) {
  return new ReviewService(new EventStore(filePath));
}

/**
 * 基础会审场景：
 * - CLM-COSTUME（服饰年代，证据 ARC-001 v1，旁证，允许设计+铭牌引用）
 * - CLM-LAYOUT（队列布局，证据 ARC-002 v1，确证，允许全部引用）
 * - DV-MAIN-1 主雕塑：采用两条主张，含推断 INF-BANNER-COLOR，构件 武士/战马/旗帜
 * - DV-BASE-1 基座：只采用布局主张，构件 基座（不受服饰主张影响）
 * 两个设计版本均完成会审签署。
 */
export function buildBaseReview(svc) {
  svc.submitClaim({
    request_id: "req-claim-costume",
    claim_id: "CLM-COSTUME",
    statement: "主像人物服饰为东汉晚期制式",
    evidence_id: "ARC-001",
    evidence_version: "v1",
    certainty: "probable",
    allowed_citation: ["design", "label"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.submitClaim({
    request_id: "req-claim-layout",
    claim_id: "CLM-LAYOUT",
    statement: "仪仗队列为三列纵阵",
    evidence_id: "ARC-002",
    evidence_version: "v1",
    certainty: "confirmed",
    allowed_citation: ["design", "label", "publication"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.proposeDesign({
    request_id: "req-design-main",
    design_id: "DV-MAIN-1",
    based_on_claims: [
      { claim_id: "CLM-COSTUME", claim_version: 1 },
      { claim_id: "CLM-LAYOUT", claim_version: 1 },
    ],
    artistic_inferences: [
      { inference_id: "INF-BANNER-COLOR", basis_claim: "CLM-LAYOUT", rationale: "同时期壁画佐证旗帜为绛红" },
    ],
    components: ["CMP-WARRIOR", "CMP-HORSE", "CMP-BANNER"],
    designer: "des-01",
    occurred_at: AT,
  });
  svc.proposeDesign({
    request_id: "req-design-base",
    design_id: "DV-BASE-1",
    based_on_claims: [{ claim_id: "CLM-LAYOUT", claim_version: 1 }],
    components: ["CMP-PLINTH"],
    designer: "des-01",
    occurred_at: AT,
  });
  svc.reviewDesign({
    request_id: "req-review-main-facts",
    design_id: "DV-MAIN-1",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "his-01",
    scope_refs: ["CLM-COSTUME", "CLM-LAYOUT"],
    occurred_at: AT,
  });
  svc.reviewDesign({
    request_id: "req-review-main-infs",
    design_id: "DV-MAIN-1",
    role: "art_committee",
    decision: "inference_accepted",
    reviewer: "art-01",
    scope_refs: ["INF-BANNER-COLOR"],
    occurred_at: AT,
  });
  svc.reviewDesign({
    request_id: "req-review-base-facts",
    design_id: "DV-BASE-1",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "his-01",
    scope_refs: ["CLM-LAYOUT"],
    occurred_at: AT,
  });
}

/**
 * 制作与安装场景：
 * - CMP-WARRIOR：试验通过 → 制作 → 安装放行 → 发布铭牌（引用服饰+布局主张 v1）
 * - CMP-BANNER：试验通过 → 制作（未安装）
 * - CMP-HORSE：保持未制作
 * - CMP-PLINTH：保持未制作
 */
export function buildFabrication(svc) {
  svc.testMaterial({
    request_id: "req-test-w1",
    batch_id: "BATCH-W1",
    component_code: "CMP-WARRIOR",
    material_spec: "青铜 QN-2026-11",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-warrior",
    component_code: "CMP-WARRIOR",
    batch_code: "BATCH-W1",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  svc.testMaterial({
    request_id: "req-test-b1",
    batch_id: "BATCH-B1",
    component_code: "CMP-BANNER",
    material_spec: "锻铜 DT-2026-07",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-banner",
    component_code: "CMP-BANNER",
    batch_code: "BATCH-B1",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  svc.clearInstallation({
    request_id: "req-inst-warrior",
    component_code: "CMP-WARRIOR",
    structural_engineer: "eng-01",
    design_event_id: "req-design-main#1",
    evidence_event_ids: ["req-test-w1#1"],
    occurred_at: AT,
  });
  svc.releaseLabel({
    request_id: "req-label-warrior",
    label_id: "LBL-WARRIOR",
    component_code: "CMP-WARRIOR",
    cited_claims: [
      { claim_id: "CLM-COSTUME", claim_version: 1 },
      { claim_id: "CLM-LAYOUT", claim_version: 1 },
    ],
    text: "武士俑（东汉晚期服饰）",
    curator: "cur-01",
    release_event_id: "req-inst-warrior#1",
    occurred_at: AT,
  });
}

/** 新档案推翻服饰年代：CLM-COSTUME 修订至 v2。 */
export const REVISE_COSTUME = {
  request_id: "req-revise-costume",
  claim_id: "CLM-COSTUME",
  statement: "主像人物服饰更正为西汉中期制式",
  evidence_id: "ARC-009",
  evidence_version: "v1",
  certainty: "confirmed",
  allowed_citation: ["design", "label"],
  reason: "新到档案 ARC-009 推翻原服饰年代认定",
  historian: "his-01",
  occurred_at: AT,
};

/** 修订后的新主设计版本：继承未变化结论，只重签变化的主张。 */
export function proposeMainV2(svc) {
  svc.proposeDesign({
    request_id: "req-design-main-2",
    design_id: "DV-MAIN-2",
    based_on_claims: [
      { claim_id: "CLM-COSTUME", claim_version: 2 },
      { claim_id: "CLM-LAYOUT", claim_version: 1 },
    ],
    artistic_inferences: [
      { inference_id: "INF-BANNER-COLOR", basis_claim: "CLM-LAYOUT", rationale: "同时期壁画佐证旗帜为绛红" },
    ],
    components: ["CMP-WARRIOR", "CMP-HORSE", "CMP-BANNER"],
    designer: "des-01",
    predecessor_event: "req-design-main#1",
    occurred_at: AT,
  });
}
