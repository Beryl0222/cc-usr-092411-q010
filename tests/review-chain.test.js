import assert from "node:assert/strict";
import test from "node:test";

import { traceComponent } from "../src/trace.js";
import { validateEvent } from "../src/validator.js";
import { AT, buildBaseReview, buildFabrication, makeService } from "./helpers.js";

test("完整会审链：主张→设计→会审→试验→制作→安装→铭牌，全部事件符合契约", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);

  for (const event of svc.store.all()) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 应通过契约校验`);
  }
  assert.equal(svc.state.components.get("CMP-WARRIOR").status, "installed");
  assert.equal(svc.state.components.get("CMP-BANNER").status, "fabricated");
  assert.equal(svc.state.components.get("CMP-HORSE").status, "planned");
  assert.equal(svc.state.components.get("CMP-PLINTH").status, "planned");
  assert.equal(svc.openWorkItems().length, 0);
});

test("从一个构件可追到主张、证据、签署、材料批次和铭牌", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);

  const trace = traceComponent(svc.state, "CMP-WARRIOR");
  assert.equal(trace.status, "installed");

  // 主张与证据版本
  const costume = trace.claims.find((c) => c.claim_id === "CLM-COSTUME");
  assert.equal(costume.claim_version, 1);
  assert.equal(costume.evidence_id, "ARC-001");
  assert.equal(costume.evidence_version, "v1");
  assert.equal(costume.certainty, "probable");
  assert.deepEqual(costume.allowed_citation, ["design", "label"]);

  // 会审签署：历史顾问确认史实，艺术委员会接受推断
  assert.ok(trace.design_reviews.some((r) => r.scope === "facts" && r.ref === "CLM-COSTUME" && r.reviewer === "his-01"));
  assert.ok(trace.design_reviews.some((r) => r.scope === "inferences" && r.ref === "INF-BANNER-COLOR" && r.reviewer === "art-01"));

  // 材料批次与结构签署
  assert.equal(trace.material_batches.length, 1);
  assert.equal(trace.material_batches[0].batch_id, "BATCH-W1");
  assert.equal(trace.material_batches[0].tests[0].structural_engineer, "eng-01");
  assert.equal(trace.material_batches[0].tests[0].passed, true);

  // 安装放行与铭牌
  assert.equal(trace.installation.structural_engineer, "eng-01");
  assert.deepEqual(trace.installation.evidence_event_ids, ["req-test-w1#1"]);
  assert.equal(trace.labels.length, 1);
  assert.equal(trace.labels[0].label_id, "LBL-WARRIOR");
  assert.equal(trace.labels[0].release.text, "武士俑（东汉晚期服饰）");
  assert.equal(trace.labels[0].corrections.length, 0);
});

test("前序条件：设计未完成会审不得材料试验", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "s",
    evidence_id: "E-1",
    evidence_version: "v1",
    certainty: "confirmed",
    allowed_citation: ["design"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.proposeDesign({
    request_id: "req-d1",
    design_id: "DV-1",
    based_on_claims: [{ claim_id: "CLM-A", claim_version: 1 }],
    components: ["CMP-1"],
    designer: "des-01",
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.testMaterial({
        request_id: "req-t1",
        batch_id: "B-1",
        component_code: "CMP-1",
        material_spec: "青铜",
        passed: true,
        structural_engineer: "eng-01",
        occurred_at: AT,
      }),
    /尚未完成会审/,
  );
});

test("前序条件：试验未通过不得制作，未制作不得安装，未安装不得发铭牌", () => {
  const svc = makeService();
  buildBaseReview(svc);

  svc.testMaterial({
    request_id: "req-test-h1",
    batch_id: "BATCH-H1",
    component_code: "CMP-HORSE",
    material_spec: "铸铁",
    passed: false,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.fabricateComponent({
        request_id: "req-fab-horse",
        component_code: "CMP-HORSE",
        batch_code: "BATCH-H1",
        fabricator: "fab-01",
        occurred_at: AT,
      }),
    /尚未通过材料试验/,
  );
  assert.throws(
    () =>
      svc.clearInstallation({
        request_id: "req-inst-horse",
        component_code: "CMP-HORSE",
        structural_engineer: "eng-01",
        design_event_id: "req-design-main#1",
        evidence_event_ids: ["req-test-h1#1"],
        occurred_at: AT,
      }),
    /不能放行安装/,
  );
  assert.throws(
    () =>
      svc.releaseLabel({
        request_id: "req-label-horse",
        label_id: "LBL-HORSE",
        component_code: "CMP-HORSE",
        cited_claims: [{ claim_id: "CLM-LAYOUT", claim_version: 1 }],
        text: "战马",
        curator: "cur-01",
        release_event_id: "req-inst-horse#1",
        occurred_at: AT,
      }),
    /尚未安装放行/,
  );
});

test("铭牌只能引用允许 label 范围的主张", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-INTERNAL",
    statement: "内部考证，不对外",
    evidence_id: "E-9",
    evidence_version: "v1",
    certainty: "inferred",
    allowed_citation: ["design"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.submitClaim({
    request_id: "req-c2",
    claim_id: "CLM-PUB",
    statement: "可公开史实",
    evidence_id: "E-10",
    evidence_version: "v1",
    certainty: "confirmed",
    allowed_citation: ["design", "label"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.proposeDesign({
    request_id: "req-d1",
    design_id: "DV-1",
    based_on_claims: [
      { claim_id: "CLM-INTERNAL", claim_version: 1 },
      { claim_id: "CLM-PUB", claim_version: 1 },
    ],
    components: ["CMP-1"],
    designer: "des-01",
    occurred_at: AT,
  });
  svc.reviewDesign({
    request_id: "req-r1",
    design_id: "DV-1",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "his-01",
    scope_refs: ["CLM-INTERNAL", "CLM-PUB"],
    occurred_at: AT,
  });
  svc.testMaterial({
    request_id: "req-t1",
    batch_id: "B-1",
    component_code: "CMP-1",
    material_spec: "石材",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.fabricateComponent({ request_id: "req-f1", component_code: "CMP-1", batch_code: "B-1", fabricator: "fab-01", occurred_at: AT });
  svc.clearInstallation({
    request_id: "req-i1",
    component_code: "CMP-1",
    structural_engineer: "eng-01",
    design_event_id: "req-d1#1",
    evidence_event_ids: ["req-t1#1"],
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.releaseLabel({
        request_id: "req-l1",
        label_id: "LBL-1",
        component_code: "CMP-1",
        cited_claims: [
          { claim_id: "CLM-PUB", claim_version: 1 },
          { claim_id: "CLM-INTERNAL", claim_version: 1 },
        ],
        text: "说明牌",
        curator: "cur-01",
        release_event_id: "req-i1#1",
        occurred_at: AT,
      }),
    /不允许在铭牌中引用/,
  );
});
