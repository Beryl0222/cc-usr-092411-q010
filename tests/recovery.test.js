import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReviewService } from "../src/service.js";
import { traceComponent } from "../src/trace.js";
import {
  AT,
  buildBaseReview,
  buildFabrication,
  proposeMainV2,
  REVISE_COSTUME,
} from "./helpers.js";

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "review-chain-"));
  const file = join(dir, "events.jsonl");
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("中断恢复：待办顺序不变，状态与事件数一致", () => {
  withTempStore((file) => {
    // 第一阶段：建链、修订、办结一项后“崩溃”（丢弃内存实例）
    const svc1 = ReviewService.load(file);
    buildBaseReview(svc1);
    buildFabrication(svc1);
    svc1.reviseClaim(REVISE_COSTUME);
    const orderBefore = svc1.openWorkItems().map((i) => i.id);
    assert.deepEqual(orderBefore, [
      "wi-req-revise-costume-1",
      "wi-req-revise-costume-2",
      "wi-req-revise-costume-3",
    ]);

    svc1.correctLabel({
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
    const remaining = svc1.openWorkItems().map((i) => i.id);
    const sizeBefore = svc1.store.size;

    // 恢复：待办顺序与崩溃前一致
    const svc2 = ReviewService.load(file);
    assert.deepEqual(svc2.openWorkItems().map((i) => i.id), remaining);
    assert.equal(svc2.store.size, sizeBefore);
    assert.equal(svc2.state.claims.get("CLM-COSTUME").currentVersion, 2);
    assert.equal(svc2.state.components.get("CMP-HORSE").status, "suspended");
    assert.equal(svc2.state.labels.get("LBL-WARRIOR").corrections.length, 1);

    // 恢复后继续办结：处置旗帜
    svc2.recordDisposition({
      request_id: "req-disp-banner",
      component_code: "CMP-BANNER",
      decision: "keep_with_annotation",
      rationale: "整体场景不受影响，保留并加注",
      trigger_event_id: "req-revise-costume#1",
      planner: "pln-01",
      occurred_at: AT,
    });
    assert.deepEqual(
      svc2.openWorkItems().map((i) => i.id),
      ["wi-req-revise-costume-2"],
    );

    // 再次恢复：顺序仍一致
    const svc3 = ReviewService.load(file);
    assert.deepEqual(
      svc3.openWorkItems().map((i) => i.id),
      ["wi-req-revise-costume-2"],
    );

    // 办结最后一项：新版本继承 + 恢复战马
    proposeMainV2(svc3);
    svc3.reviewDesign({
      request_id: "req-review-main2-facts",
      design_id: "DV-MAIN-2",
      role: "historian",
      decision: "facts_confirmed",
      reviewer: "his-01",
      scope_refs: ["CLM-COSTUME"],
      occurred_at: AT,
    });
    svc3.resumeComponent({
      request_id: "req-resume-horse",
      component_code: "CMP-HORSE",
      design_event_id: "req-design-main-2#1",
      trigger_event_id: "req-revise-costume#1",
      planner: "pln-01",
      occurred_at: AT,
    });
    assert.equal(svc3.openWorkItems().length, 0);

    const svc4 = ReviewService.load(file);
    assert.equal(svc4.openWorkItems().length, 0);
    assert.equal(svc4.store.size, svc3.store.size);
    assert.deepEqual(traceComponent(svc4.state, "CMP-WARRIOR"), traceComponent(svc3.state, "CMP-WARRIOR"));
  });
});

test("中断恢复：同编号请求重放不产生新事件，内容不一致报冲突", () => {
  withTempStore((file) => {
    const svc1 = ReviewService.load(file);
    buildBaseReview(svc1);
    buildFabrication(svc1);
    svc1.reviseClaim(REVISE_COSTUME);
    const sizeBefore = svc1.store.size;

    // 恢复后重放同一修订命令：返回首次结果，不新增事件
    const svc2 = ReviewService.load(file);
    const replay = svc2.reviseClaim(REVISE_COSTUME);
    assert.equal(replay.replayed, true);
    assert.equal(replay.events[0].event_id, "req-revise-costume#1");
    assert.equal(svc2.store.size, sizeBefore);
    // 待办不因重放而重复
    assert.deepEqual(
      svc2.openWorkItems().map((i) => i.id),
      ["wi-req-revise-costume-1", "wi-req-revise-costume-2", "wi-req-revise-costume-3"],
    );

    // 同编号不同内容：冲突
    assert.throws(
      () => svc2.reviseClaim({ ...REVISE_COSTUME, statement: "另一种表述" }),
      /不构成重放/,
    );
    assert.equal(svc2.store.size, sizeBefore);
  });
});

test("中断恢复：已接收命令在崩溃点前后行为一致（含部分完成的命令）", () => {
  withTempStore((file) => {
    const svc1 = ReviewService.load(file);
    buildBaseReview(svc1);
    // 同编号重放整个基础链中的每个命令：全部识别为重放
    const svc2 = ReviewService.load(file);
    const sizeBefore = svc2.store.size;
    const before = svc2.store.all().map((e) => e.event_id);
    // 重放提交设计命令
    const replay = svc2.proposeDesign({
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
    assert.equal(replay.replayed, true);
    assert.equal(svc2.store.size, sizeBefore);
    assert.deepEqual(
      svc2.store.all().map((e) => e.event_id),
      before,
    );
  });
});
