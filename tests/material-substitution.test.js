import assert from "node:assert/strict";
import test from "node:test";

import { traceComponent } from "../src/trace.js";
import { AT, buildBaseReview, makeService } from "./helpers.js";

test("结构替代：原批次试验失败，替代批次通过后制作并安装，两个批次都在追溯链上", () => {
  const svc = makeService();
  buildBaseReview(svc);

  // 原批次试验失败
  svc.testMaterial({
    request_id: "req-test-h1",
    batch_id: "BATCH-H1",
    component_code: "CMP-HORSE",
    material_spec: "铸铁 ZT-2026-03",
    passed: false,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.fabricateComponent({
        request_id: "req-fab-h1",
        component_code: "CMP-HORSE",
        batch_code: "BATCH-H1",
        fabricator: "fab-01",
        occurred_at: AT,
      }),
    /尚未通过材料试验/,
  );

  // 替代批次（结构替代），试验通过
  svc.testMaterial({
    request_id: "req-test-h2",
    batch_id: "BATCH-H2",
    component_code: "CMP-HORSE",
    material_spec: "复合材料 FH-2026-01",
    passed: true,
    structural_engineer: "eng-01",
    replaces_batch: "BATCH-H1",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-h2",
    component_code: "CMP-HORSE",
    batch_code: "BATCH-H2",
    fabricator: "fab-01",
    occurred_at: AT,
  });
  svc.clearInstallation({
    request_id: "req-inst-h2",
    component_code: "CMP-HORSE",
    structural_engineer: "eng-01",
    design_event_id: "req-design-main#1",
    evidence_event_ids: ["req-test-h2#1"],
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-HORSE").status, "installed");

  // 追溯：两个批次与替代关系可见
  const trace = traceComponent(svc.state, "CMP-HORSE");
  assert.deepEqual(
    trace.material_batches.map((b) => b.batch_id).sort(),
    ["BATCH-H1", "BATCH-H2"],
  );
  const original = trace.material_batches.find((b) => b.batch_id === "BATCH-H1");
  const substitute = trace.material_batches.find((b) => b.batch_id === "BATCH-H2");
  assert.equal(original.tests[0].passed, false);
  assert.equal(substitute.tests[0].passed, true);
  assert.equal(substitute.tests[0].replaces_batch, "BATCH-H1");
  assert.equal(trace.fabrications[0].batch_code, "BATCH-H2");
});

test("替代批次必须属于同一构件", () => {
  const svc = makeService();
  buildBaseReview(svc);
  svc.testMaterial({
    request_id: "req-test-w1",
    batch_id: "BATCH-W1",
    component_code: "CMP-WARRIOR",
    material_spec: "青铜",
    passed: false,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.testMaterial({
        request_id: "req-test-h1",
        batch_id: "BATCH-H1",
        component_code: "CMP-HORSE",
        material_spec: "复合材料",
        passed: true,
        structural_engineer: "eng-01",
        replaces_batch: "BATCH-W1",
        occurred_at: AT,
      }),
    /不属于构件 CMP-HORSE/,
  );
});

test("安装放行必须包含当前批次通过的试验，失败批次不能充数", () => {
  const svc = makeService();
  buildBaseReview(svc);
  svc.testMaterial({
    request_id: "req-test-b1",
    batch_id: "BATCH-B1",
    component_code: "CMP-BANNER",
    material_spec: "锻铜",
    passed: false,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  svc.testMaterial({
    request_id: "req-test-b2",
    batch_id: "BATCH-B2",
    component_code: "CMP-BANNER",
    material_spec: "替代合金",
    passed: true,
    structural_engineer: "eng-01",
    replaces_batch: "BATCH-B1",
    occurred_at: AT,
  });
  svc.fabricateComponent({
    request_id: "req-fab-b2",
    component_code: "CMP-BANNER",
    batch_code: "BATCH-B2",
    fabricator: "fab-01",
    occurred_at: AT,
  });

  // 只附失败批次的试验 → 拒绝
  assert.throws(
    () =>
      svc.clearInstallation({
        request_id: "req-inst-bad",
        component_code: "CMP-BANNER",
        structural_engineer: "eng-01",
        design_event_id: "req-design-main#1",
        evidence_event_ids: ["req-test-b1#1"],
        occurred_at: AT,
      }),
    /不是本构件通过的材料试验/,
  );

  // 附通过批次但不是制作所用批次 → 拒绝
  svc.testMaterial({
    request_id: "req-test-b3",
    batch_id: "BATCH-B3",
    component_code: "CMP-BANNER",
    material_spec: "另一种合金",
    passed: true,
    structural_engineer: "eng-01",
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.clearInstallation({
        request_id: "req-inst-bad2",
        component_code: "CMP-BANNER",
        structural_engineer: "eng-01",
        design_event_id: "req-design-main#1",
        evidence_event_ids: ["req-test-b3#1"],
        occurred_at: AT,
      }),
    /当前批次通过的材料试验/,
  );

  // 正确的当前批次 → 放行
  svc.clearInstallation({
    request_id: "req-inst-ok",
    component_code: "CMP-BANNER",
    structural_engineer: "eng-01",
    design_event_id: "req-design-main#1",
    evidence_event_ids: ["req-test-b2#1"],
    occurred_at: AT,
  });
  assert.equal(svc.state.components.get("CMP-BANNER").status, "installed");
});
