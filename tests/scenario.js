import { readFile } from "node:fs/promises";

import { ReviewChain } from "../src/chain.js";

/** 可控时钟：事件标识与发生时间完全确定，便于断言与重放对比。 */
export class ManualClock {
  constructor(start = "2026-09-20T09:00:00.000Z") {
    this.t = new Date(start);
  }
  now() {
    return this.t;
  }
  tick(seconds = 60) {
    this.t = new Date(this.t.getTime() + seconds * 1000);
    return this.t;
  }
}

export const IDS = Object.freeze({
  claimRobe: "claim-robe-era",
  claimRobeV2: "claim-robe-era-v2",
  claimScene: "claim-scene",
  claimMotif: "claim-motif",
  d1: "design-v1",
  d2: "design-v2",
  main: "C-ROBE-MAIN",
  side: "C-ROBE-SIDE",
  relief: "C-ROBE-RELIEF",
  motif: "C-MOTIF",
  batchMainFail: "B-MAIN-A",
  batchMainOk: "B-MAIN-B",
  batchSide: "B-SIDE",
  batchRelief: "B-RELIEF",
  release: "R-0925-1",
  label: "L-01",
  assessment: "IA-robe-1",
});

/**
 * 场景命令序列：推进到“新档案到达、影响评估完成”的检查点。
 * 同一服饰主张被三类构件引用：主像服饰（未制作）、侧像服饰（已制作）、
 * 背景浮雕服饰（已安装且铭牌已发布）；另有不引用该主张的构件作为对照。
 * run(method, command) 可注入内存链（同步）或持久化服务（异步）。
 */
export function scenarioCommands(id) {
  return [
    ["submitClaim", {
      request_id: "req-claim-robe",
      claim_id: id.claimRobe,
      subject: "人物服饰年代",
      summary: "人物所着冠服为元丰年早期制式",
      evidence_ref: "archive://costume/robe",
      evidence_version: "ev-2026-08-01",
      certainty: "confirmed",
      citation_scope: "label",
    }],
    ["submitClaim", {
      claim_id: id.claimScene,
      subject: "整体场景",
      summary: "场景为某次历史巡幸的纪实性再现",
      evidence_ref: "archive://scene/record",
      evidence_version: "ev-2026-08-01",
      certainty: "confirmed",
      citation_scope: "label",
    }],
    ["submitClaim", {
      claim_id: id.claimMotif,
      subject: "配景纹样复原",
      summary: "边缘纹样为后世同类器物纹样的推断性复原",
      evidence_ref: "study://motif/analogy",
      evidence_version: "ev-2026-08-01",
      certainty: "probable",
      citation_scope: "design_only",
    }],
    ["publishDesign", {
      request_id: "req-design-v1",
      design_id: id.d1,
      summary: "整版设计 v1",
      claims: [
        { claim_id: id.claimRobe, basis: "fact" },
        { claim_id: id.claimScene, basis: "fact" },
        { claim_id: id.claimMotif, basis: "inference" },
      ],
      components: [
        { component_id: id.main, claim_ids: [id.claimRobe] },
        { component_id: id.side, claim_ids: [id.claimRobe] },
        { component_id: id.relief, claim_ids: [id.claimRobe, id.claimScene] },
        { component_id: id.motif, claim_ids: [id.claimMotif] },
      ],
    }],
    ["signDesign", { design_id: id.d1, role: "historian", signer: "历史顾问·顾诚", gate: "historical", confirmed: [id.claimRobe, id.claimScene] }],
    ["signDesign", { design_id: id.d1, role: "art_committee", signer: "艺术委员会·林衡", gate: "artistic", confirmed: [id.claimMotif] }],
    ["recordMaterialTest", { batch_id: id.batchMainFail, design_id: id.d1, component_ids: [id.main], test_ref: "T-001", spec: "青铜合金 ZCu-1", result: "fail", signer: "结构师·石坚", signer_role: "structural" }],
    ["recordMaterialTest", { batch_id: id.batchMainOk, design_id: id.d1, component_ids: [id.main], test_ref: "T-002", spec: "青铜合金 ZCu-2", result: "pass", signer: "结构师·石坚", signer_role: "structural", supersedes_batch: id.batchMainFail }],
    ["recordMaterialTest", { batch_id: id.batchSide, design_id: id.d1, component_ids: [id.side], test_ref: "T-003", spec: "青铜合金 ZCu-2", result: "pass", signer: "结构师·石坚", signer_role: "structural" }],
    ["recordMaterialTest", { batch_id: id.batchRelief, design_id: id.d1, component_ids: [id.relief, id.motif], test_ref: "T-004", spec: "青铜合金 ZCu-3", result: "pass", signer: "结构师·石坚", signer_role: "structural" }],
    ["signDesign", { design_id: id.d1, role: "structural", signer: "结构师·石坚", gate: "structural", confirmed: [], inherited: [] }],
    ["fabricate", { design_id: id.d1, batch_id: id.batchSide, component_ids: [id.side] }],
    ["fabricate", { design_id: id.d1, batch_id: id.batchRelief, component_ids: [id.relief, id.motif] }],
    ["clearInstallation", { release_id: id.release, design_id: id.d1, component_ids: [id.relief, id.motif], signer: "结构师·石坚", signer_role: "structural" }],
    ["install", { release_id: id.release, component_ids: [id.relief, id.motif] }],
    ["releaseLabel", { label_id: id.label, release_id: id.release, cited_claim_ids: [id.claimRobe, id.claimScene], text: "铭文：人物冠服为元丰年早期制式，场景纪实巡幸。" }],
    ["reviseClaim", {
      request_id: "req-revise-robe",
      claim_id: id.claimRobe,
      evidence_ref: "archive://costume/robe-new-arrival",
      evidence_version: "ev-2026-09-25",
      certainty: "refuted",
      citation_scope: "internal",
      reason: "新到档案比对服饰纹样与颁赐记录，元丰年早期制式结论被推翻",
    }],
    ["assessImpact", { request_id: "req-impact-robe", assessment_id: id.assessment, claim_id: id.claimRobe }],
  ];
}

/** 同步内存版场景。 */
export function buildScenario() {
  const clock = new ManualClock();
  const chain = new ReviewChain({ now: () => clock.now() });
  const id = IDS;
  for (const [method, command] of scenarioCommands(id)) {
    clock.tick();
    chain[method](command);
  }
  return { clock, chain, id };
}

export async function loadSchema() {
  return JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
}

export const todoView = (todos) => todos.map((t) => `${t.seq}:${t.kind}:${t.ref}:${t.status}`);
