import assert from "node:assert/strict";
import test from "node:test";

import { traceComponent } from "../src/trace.js";
import { AT, buildBaseReview, buildFabrication, makeService, REVISE_COSTUME } from "./helpers.js";

test("安装后更正：原发布保留，更正为后继事件并办结待办", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  const item = svc.openWorkItems().find((i) => i.kind === "issue_label_correction");
  assert.equal(item.component_code, "CMP-WARRIOR");
  assert.equal(item.trigger_event_id, "req-revise-costume#1");

  svc.correctLabel({
    request_id: "req-correct-label",
    label_id: "LBL-WARRIOR",
    original_release_event_id: "req-label-warrior#1",
    correction_text: "武士俑（西汉中期服饰，据 ARC-009 更正）",
    reason: "服饰年代主张被修订",
    trigger_event_id: "req-revise-costume#1",
    cited_claims: [
      { claim_id: "CLM-COSTUME", claim_version: 2 },
      { claim_id: "CLM-LAYOUT", claim_version: 1 },
    ],
    curator: "cur-01",
    occurred_at: AT,
  });

  // 原发布保留，更正为后继记录
  const label = svc.state.labels.get("LBL-WARRIOR");
  assert.equal(label.release.text, "武士俑（东汉晚期服饰）");
  assert.equal(label.corrections.length, 1);
  assert.equal(
    label.corrections[0].cited_claims.find((r) => r.claim_id === "CLM-COSTUME").claim_version,
    2,
  );

  // 待办办结，安装决定未被触碰
  assert.ok(!svc.openWorkItems().some((i) => i.kind === "issue_label_correction"));
  assert.equal(svc.state.components.get("CMP-WARRIOR").status, "installed");
  assert.ok(svc.state.installations.has("CMP-WARRIOR"));

  // 追溯同时呈现发布与更正
  const trace = traceComponent(svc.state, "CMP-WARRIOR");
  assert.equal(trace.labels[0].release.text, "武士俑（东汉晚期服饰）");
  assert.equal(trace.labels[0].corrections[0].correction_text, "武士俑（西汉中期服饰，据 ARC-009 更正）");
  assert.equal(
    trace.labels[0].effective_cited_claims.find((r) => r.claim_id === "CLM-COSTUME").claim_version,
    2,
  );
  // 服饰主张在追溯中显示采用版本与当前版本的差异
  const costume = trace.claims.find((c) => c.claim_id === "CLM-COSTUME");
  assert.equal(costume.claim_version, 1);
  assert.equal(costume.current_version, 2);
});

test("更正必须引用当前版本主张，且须有对应更正待办", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);
  svc.reviseClaim(REVISE_COSTUME);

  // 引用旧版本更正 → 拒绝
  assert.throws(
    () =>
      svc.correctLabel({
        request_id: "req-correct-1",
        label_id: "LBL-WARRIOR",
        original_release_event_id: "req-label-warrior#1",
        correction_text: "仍引用旧版本",
        reason: "r",
        trigger_event_id: "req-revise-costume#1",
        cited_claims: [{ claim_id: "CLM-COSTUME", claim_version: 1 }],
        curator: "cur-01",
        occurred_at: AT,
      }),
    /已被版本 2 取代/,
  );

  // 触发事件不匹配 → 拒绝
  assert.throws(
    () =>
      svc.correctLabel({
        request_id: "req-correct-2",
        label_id: "LBL-WARRIOR",
        original_release_event_id: "req-label-warrior#1",
        correction_text: "更正",
        reason: "r",
        trigger_event_id: "req-nonexistent#1",
        cited_claims: [
          { claim_id: "CLM-COSTUME", claim_version: 2 },
          { claim_id: "CLM-LAYOUT", claim_version: 1 },
        ],
        curator: "cur-01",
        occurred_at: AT,
      }),
    /没有待办结的/,
  );
});

test("未被修订波及的铭牌不产生更正待办", () => {
  const svc = makeService();
  buildBaseReview(svc);
  buildFabrication(svc);

  // 修订一个没有任何设计采用的主张：先登记，再修订
  svc.submitClaim({
    request_id: "req-claim-unused",
    claim_id: "CLM-UNUSED",
    statement: "未被采用的考证",
    evidence_id: "E-0",
    evidence_version: "v1",
    certainty: "disputed",
    allowed_citation: ["design"],
    historian: "his-01",
    occurred_at: AT,
  });
  svc.reviseClaim({
    request_id: "req-revise-unused",
    claim_id: "CLM-UNUSED",
    statement: "修订后的考证",
    evidence_id: "E-0",
    evidence_version: "v2",
    certainty: "probable",
    allowed_citation: ["design"],
    reason: "补充证据",
    historian: "his-01",
    occurred_at: AT,
  });

  assert.equal(svc.openWorkItems().length, 0);
  assert.equal(svc.state.components.get("CMP-HORSE").status, "planned");
  assert.equal(svc.state.components.get("CMP-WARRIOR").status, "installed");
});
