import assert from "node:assert/strict";
import test from "node:test";

import { ConflictError } from "../src/errors.js";
import { AT, buildBaseReview, makeService, proposeMainV2, REVISE_COSTUME } from "./helpers.js";

test("职责不可代办：历史顾问不能接受推断，艺术委员会不能确认史实，结构人员不能会审设计", () => {
  const svc = makeService();
  buildBaseReview(svc);

  assert.throws(
    () =>
      svc.reviewDesign({
        request_id: "req-bad-1",
        design_id: "DV-MAIN-1",
        role: "historian",
        decision: "inference_accepted",
        reviewer: "his-99",
        scope_refs: ["INF-BANNER-COLOR"],
        occurred_at: AT,
      }),
    /无权/,
  );
  assert.throws(
    () =>
      svc.reviewDesign({
        request_id: "req-bad-2",
        design_id: "DV-MAIN-1",
        role: "art_committee",
        decision: "facts_confirmed",
        reviewer: "art-99",
        scope_refs: ["CLM-COSTUME"],
        occurred_at: AT,
      }),
    /无权/,
  );

  // 结构人员只能出现在材料试验与安装放行；会审事件没有其角色位置
  assert.throws(
    () =>
      svc.reviewDesign({
        request_id: "req-bad-3",
        design_id: "DV-MAIN-1",
        role: "structural_engineer",
        decision: "facts_confirmed",
        reviewer: "eng-01",
        scope_refs: ["CLM-COSTUME"],
        occurred_at: AT,
      }),
    /无权/,
  );
});

test("同一签署人不得在同一设计版本跨角色签署", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "s",
    evidence_id: "E",
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
    artistic_inferences: [{ inference_id: "INF-1", basis_claim: "CLM-A", rationale: "r" }],
    components: ["CMP-1"],
    designer: "des-01",
    occurred_at: AT,
  });
  svc.reviewDesign({
    request_id: "req-r1",
    design_id: "DV-1",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "double-agent",
    scope_refs: ["CLM-A"],
    occurred_at: AT,
  });
  assert.throws(
    () =>
      svc.reviewDesign({
        request_id: "req-r2",
        design_id: "DV-1",
        role: "art_committee",
        decision: "inference_accepted",
        reviewer: "double-agent",
        scope_refs: ["INF-1"],
        occurred_at: AT,
      }),
    /不得跨职责代办/,
  );
});

test("相邻版本继承未变化结论：只重签变化的主张，未变化史实与推断继承", () => {
  const svc = makeService();
  buildBaseReview(svc);
  svc.reviseClaim(REVISE_COSTUME);
  proposeMainV2(svc);

  // 新版本尚缺：变化的服饰主张确认；布局史实与旗帜推断可从前序版本继承
  let gaps = svc.designGaps("DV-MAIN-2");
  assert.deepEqual(gaps.missingFacts, ["CLM-COSTUME"]);
  assert.deepEqual(gaps.missingInferences, []);

  // 只补历史顾问对新服饰版本的确认
  svc.reviewDesign({
    request_id: "req-review-main2-facts",
    design_id: "DV-MAIN-2",
    role: "historian",
    decision: "facts_confirmed",
    reviewer: "his-01",
    scope_refs: ["CLM-COSTUME"],
    occurred_at: AT,
  });
  gaps = svc.designGaps("DV-MAIN-2");
  assert.deepEqual(gaps.missingFacts, []);
  assert.deepEqual(gaps.missingInferences, []);

  // 继承的是结论而非签署：新版本自己的事件里没有艺术委员会签署
  const ownReviews = svc.store
    .eventsOf("design_version", "DV-MAIN-2")
    .filter((e) => e.event_type === "DESIGN_REVIEWED");
  assert.equal(ownReviews.length, 1);
  assert.equal(ownReviews[0].payload.role, "historian");
});

test("推断依据或理由变化时不继承接受结论", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "s",
    evidence_id: "E",
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
    artistic_inferences: [{ inference_id: "INF-1", basis_claim: "CLM-A", rationale: "旧理由" }],
    components: ["CMP-1"],
    designer: "des-01",
    occurred_at: AT,
  });
  svc.reviewDesign({ request_id: "req-r1", design_id: "DV-1", role: "historian", decision: "facts_confirmed", reviewer: "his-01", scope_refs: ["CLM-A"], occurred_at: AT });
  svc.reviewDesign({ request_id: "req-r2", design_id: "DV-1", role: "art_committee", decision: "inference_accepted", reviewer: "art-01", scope_refs: ["INF-1"], occurred_at: AT });

  svc.proposeDesign({
    request_id: "req-d2",
    design_id: "DV-2",
    based_on_claims: [{ claim_id: "CLM-A", claim_version: 1 }],
    artistic_inferences: [{ inference_id: "INF-1", basis_claim: "CLM-A", rationale: "新理由" }],
    components: ["CMP-1"],
    designer: "des-01",
    predecessor_event: "req-d1#1",
    occurred_at: AT,
  });
  const gaps = svc.designGaps("DV-2");
  assert.deepEqual(gaps.missingFacts, []);
  assert.deepEqual(gaps.missingInferences, ["INF-1"]);
});

test("被退回的设计版本不可继承", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "s",
    evidence_id: "E",
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
  svc.reviewDesign({ request_id: "req-r1", design_id: "DV-1", role: "historian", decision: "referred_back", reviewer: "his-01", scope_refs: ["CLM-A"], occurred_at: AT });

  svc.proposeDesign({
    request_id: "req-d2",
    design_id: "DV-2",
    based_on_claims: [{ claim_id: "CLM-A", claim_version: 1 }],
    components: ["CMP-1"],
    designer: "des-01",
    predecessor_event: "req-d1#1",
    occurred_at: AT,
  });
  const gaps = svc.designGaps("DV-2");
  assert.deepEqual(gaps.missingFacts, ["CLM-A"]);
});

test("乐观并发：expected_version 不匹配的签署被拒绝，防止越过前序条件", () => {
  const svc = makeService();
  svc.submitClaim({
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "s",
    evidence_id: "E",
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
    artistic_inferences: [{ inference_id: "INF-1", basis_claim: "CLM-A", rationale: "r" }],
    components: ["CMP-1"],
    designer: "des-01",
    occurred_at: AT,
  });

  // 设计聚合当前版本为 1（提交事件），两个并发签署都期望 version=1
  const sign = (override = {}) =>
    svc.reviewDesign({
      request_id: "req-r1",
      design_id: "DV-1",
      role: "historian",
      decision: "facts_confirmed",
      reviewer: "his-01",
      scope_refs: ["CLM-A"],
      expected_version: 1,
      occurred_at: AT,
      ...override,
    });

  sign();
  assert.throws(() => sign({ request_id: "req-r2" }), /期望版本 1，实际 2/);
});

test("同编号请求内容一致才算重放，内容不一致报冲突且不产生事件", () => {
  const svc = makeService();
  const args = {
    request_id: "req-c1",
    claim_id: "CLM-A",
    statement: "原表述",
    evidence_id: "E",
    evidence_version: "v1",
    certainty: "confirmed",
    allowed_citation: ["design"],
    historian: "his-01",
    occurred_at: AT,
  };
  const first = svc.submitClaim(args);
  assert.equal(first.replayed, false);

  // 同编号同内容：重放，返回首次事件，不新增
  const replay = svc.submitClaim(args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.events[0].event_id, first.events[0].event_id);
  assert.equal(svc.store.size, 1);

  // 同编号不同内容：冲突
  assert.throws(() => svc.submitClaim({ ...args, statement: "偷换表述" }), ConflictError);
  assert.equal(svc.store.size, 1);
});
