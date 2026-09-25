import assert from "node:assert/strict";
import test from "node:test";

import {
  AT,
  buildBaseReview,
  buildFabrication,
  makeService,
  proposeMainV2,
  REVISE_COSTUME,
} from "./helpers.js";

test("局部推翻：未制作暂停、已制作处置、已安装保留并产生铭牌更正待办，不受影响部分照常", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);

  const { events } = svc.reviseClaim(REVISE_COSTUME);

  // 主张进入版本 2，原版本保留可查
  const claim = svc.state.claims.get("CLM-COSTUME");
  assert.equal(claim.currentVersion, 2);
  assert.ok(claim.versions.has(1));
  assert.equal(claim.versions.get(2).evidence_id, "ARC-009");

  // 修订与影响事件原子写入同一命令
  const types = events.map((e) => `${e.event_type}:${e.aggregate_id}`);
  assert.deepEqual(types, [
    "CLAIM_REVISED:CLM-COSTUME",
    "COMPONENT_DISPOSITION_RECORDED:CMP-BANNER",
    "WORK_ITEM_RAISED:wi-req-revise-costume-1",
    "COMPONENT_STATUS_CHANGED:CMP-HORSE",
    "WORK_ITEM_RAISED:wi-req-revise-costume-2",
    "WORK_ITEM_RAISED:wi-req-revise-costume-3",
  ]);

  // 未制作 → 暂停；已制作 → 待定处置；已安装 → 保留原决定；基座不受影响
  assert.equal(svc.state.components.get("CMP-HORSE").status, "suspended");
  assert.equal(svc.state.components.get("CMP-BANNER").status, "fabricated");
  assert.equal(svc.state.components.get("CMP-BANNER").dispositions.at(-1).decision, "pending");
  assert.equal(svc.state.components.get("CMP-WARRIOR").status, "installed");
  assert.equal(svc.state.components.get("CMP-PLINTH").status, "planned");

  // 待办顺序确定：处置（旗帜）→ 解除暂停（战马）→ 铭牌更正（武士）
  const items = svc.openWorkItems();
  assert.deepEqual(
    items.map((i) => [i.id, i.kind, i.component_code]),
    [
      ["wi-req-revise-costume-1", "execute_disposition", "CMP-BANNER"],
      ["wi-req-revise-costume-2", "resolve_suspension", "CMP-HORSE"],
      ["wi-req-revise-costume-3", "issue_label_correction", "CMP-WARRIOR"],
    ],
  );

  // 不受影响的基座照常推进：试验、制作
  svc.testMaterial({
    request_id: "req-test-p1",
    batch_id: "BATCH-P1",
    component_code: "CMP-PLINTH",
    material_spec: "花岗岩 HG-2026-05",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-plinth",
    component_code: "CMP-PLINTH",
    batch_code: "BATCH-P1",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-PLINTH").status, "fabricated");
});

test("局部推翻后：暂停构件不得试验或制作，铭牌不得再引用旧版本主张", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  assert.throws(
    () =>
      svc.testMaterial({
        request_id: "req-test-h9",
        batch_id: "BATCH-H9",
        component_code: "CMP-HORSE",
        material_spec: "青铜",
        passed: true,
        structural_engineer: "eng-01",
        occurred_at: AT,
      }),
    /已暂停/,
  );
  assert.throws(
    () =>
      svc.fabricateComponent({
        request_id: "req-fab-h9",
        component_code: "CMP-HORSE",
        batch_code: "BATCH-W1",
        fabricator: "fab-01",
        occurred_at: AT,
      }),
    /状态为 suspended/,
  );

  // 已安装构件的新铭牌若引用被推翻的旧版本 → 拒绝
  assert.throws(
    () =>
      svc.releaseLabel({
        request_id: "req-label-warrior-2",
        label_id: "LBL-WARRIOR-2",
        component_code: "CMP-WARRIOR",
        cited_claims: [{ claim_id: "CLM-COSTUME", claim_version: 1 }],
        text: "武士俑（东汉晚期服饰）",
        curator: "cur-01",
        release_event_id: "req-inst-warrior#1",
        occurred_at: AT,
      }),
    /已被版本 2 取代/,
  );
});

test("解除暂停：新设计版本继承未变化结论，签署差异后恢复制作", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  // 新设计版本采用修订后的服饰主张；未变化结论继承
  proposeMainV2(svc);
  assert.deepEqual(svc.designGaps("DV-MAIN-2").missingFacts, ["CLM-COSTUME"]);
  svc.reviewDesign({
    request_id: "req-review-main2-facts",
    design_id: "DV-MAIN-2",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "his-01",
    scope_refs: ["CLM-COSTUME"],
    occurred_at: AT,
  });

  // 恢复战马制作，办结对应待办
  svc.resumeComponent({
    request_id: "req-resume-horse",
    component_code: "CMP-HORSE",
    design_event_id: "req-design-main-2#1",
    trigger_event_id: "req-revise-costume#1",
    planner: "pln-01",
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-HORSE").status, "planned");
  assert.ok(!svc.openWorkItems().some((i) => i.kind === "resolve_suspension"));

  // 恢复后可正常试验与制作
  svc.testMaterial({
    request_id: "req-test-h1",
    batch_id: "BATCH-H1",
    component_code: "CMP-HORSE",
    material_spec: "青铜 QN-2026-12",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-horse",
    component_code: "CMP-HORSE",
    batch_code: "BATCH-H1",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-HORSE").status, "fabricated");
});

test("解除暂停拒绝沿用被修订主张的旧设计版本", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  // 直接用旧版本 DV-MAIN-1（仍采用 CLM-COSTUME@1）恢复 → 拒绝
  assert.throws(
    () =>
      svc.resumeComponent({
        request_id: "req-resume-horse",
        component_code: "CMP-HORSE",
        design_event_id: "req-design-main#1",
        trigger_event_id: "req-revise-costume#1",
        planner: "pln-01",
        occurred_at: AT,
      }),
    /已被版本 2 取代/,
  );
});

test("已制作构件处置：保留加注后可放行安装，原通过试验不浪费", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  svc.recordDisposition({
    request_id: "req-disp-banner",
    component_code: "CMP-BANNER",
    decision: "keep_with_annotation",
    rationale: "整体场景不受影响，保留构件并加注说明",
    trigger_event_id: "req-revise-costume#1",
    planner: "pln-01",
    occurred_at: AT,
  });
  assert.ok(!svc.openWorkItems().some((i) => i.kind === "execute_disposition"));
  assert.equal(svc.state.components.get("CMP-BANNER").status, "fabricated");

  // 依据：原通过试验 + 保留处置 → 放行安装
  svc.clearInstallation({
    request_id: "req-inst-banner",
    component_code: "CMP-BANNER",
    structural_engineer: "eng-01",
    design_event_id: "req-design-main#1",
    evidence_event_ids: ["req-test-b1#1", "req-disp-banner#1"],
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-BANNER").status, "installed");
});

test("已制作构件处置：替代材料重新制作（结构替代）", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  svc.recordDisposition({
    request_id: "req-disp-banner",
    component_code: "CMP-BANNER",
    decision: "substitute_material",
    rationale: "以替代材料重新制作旗帜构件",
    trigger_event_id: "req-revise-costume#1",
    planner: "pln-01",
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-BANNER").status, "planned");

  svc.testMaterial({
    request_id: "req-test-b2",
    batch_id: "BATCH-B2",
    component_code: "CMP-BANNER",
    material_spec: "替代合金 TH-2026-02",
    passed: true,
    structural_engineer: "eng-01",
    replaces_batch: "BATCH-B1",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-banner-2",
    component_code: "CMP-BANNER",
    batch_code: "BATCH-B2",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-BANNER").status, "fabricated");
});

test("处置决定前不得放行，待定处置不构成安装依据", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  // 待定（pending）处置事件不能作为放行依据
  assert.throws(
    () =>
      svc.clearInstallation({
        request_id: "req-inst-banner",
        component_code: "CMP-BANNER",
        structural_engineer: "eng-01",
        design_event_id: "req-design-main#1",
        evidence_event_ids: ["req-test-b1#1", "req-revise-costume#2"],
        occurred_at: AT,
      }),
    /不是本构件的保留处置/,
  );
});
