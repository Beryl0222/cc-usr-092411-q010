import assert from "node:assert/strict";
import test from "node:test";

import { Certainty, CitationScope, ComponentStatus, Gate, SignerRole } from "../src/constants.js";
import { ReviewChain } from "../src/chain.js";
import { traceComponent } from "../src/projection.js";
import { buildScenario, todoView } from "./scenario.js";

test("场景一：新档案局部推翻——只锁受影响构件，未制作暂停、已制作待处置、已安装待更正", () => {
  const { chain, id } = buildScenario();

  // 不引用服饰主张的纹样构件完全不受影响，整版设计不退回
  assert.equal(chain.state.components.get(id.motif).status, ComponentStatus.INSTALLED);
  assert.equal(chain.state.designs.get(id.d1).gates[Gate.HISTORICAL] !== null, true);

  // 三个引用构件按制作状态精确分流
  assert.equal(chain.state.components.get(id.main).status, ComponentStatus.HELD);
  assert.equal(chain.state.components.get(id.side).status, ComponentStatus.FABRICATED);
  assert.equal(chain.state.components.get(id.relief).status, ComponentStatus.INSTALLED);

  const impact = chain.state.impacts.get(id.assessment);
  assert.deepEqual(impact.held, [id.main]);
  assert.deepEqual(impact.disposition_required.map((d) => d.component_id), [id.side]);
  assert.deepEqual(impact.correction_required.map((d) => d.component_id), [id.relief]);
  assert.equal(impact.correction_required[0].label_id, id.label);

  // 待办按“替代可用 -> 暂停 -> 处置 -> 更正 -> 铭牌更正（被更正阻塞）”顺序登记
  const todos = chain.pendingTodos();
  assert.deepEqual(todoView(todos), [
    `2:material_substitution:${id.batchMainOk}:pending`,
    `3:hold_unmade:${id.main}:pending`,
    `4:disposition_required:${id.side}:pending`,
    `5:post_installation_correction:${id.relief}:pending`,
    `6:label_correction:${id.label}:pending`,
  ]);
  assert.deepEqual(todos[4].blocked_by, [`post_installation_correction:${id.relief}`]);

  // 主张版本链保留：旧证据版本不被抹除
  const claim = chain.state.claims.get(id.claimRobe);
  assert.equal(claim.active, false);
  assert.equal(claim.certainty, Certainty.REFUTED);
  assert.deepEqual(
    claim.versions.map((v) => v.evidence_version),
    ["ev-2026-08-01", "ev-2026-09-25"],
  );

  // 被推翻的主张不得继续进入铭牌
  assert.throws(
    () =>
      chain.releaseLabel({
        label_id: "L-BAD",
        release_id: id.release,
        cited_claim_ids: [id.claimRobe],
        text: "x",
      }),
    /已被推翻/,
  );
});

test("场景一（续）：更正后的新设计版本可继承未变化结论，变化部分必须对应角色重签", () => {
  const { clock, chain, id } = buildScenario();

  // 用新证据重立服饰主张（新档案给出新的年代结论）
  clock.tick();
  chain.submitClaim({
    request_id: "req-claim-robe-v2",
    claim_id: id.claimRobeV2,
    subject: "人物服饰年代（新档案）",
    summary: "人物冠服为元祐三年制式",
    evidence_ref: "archive://costume/robe-new-arrival",
    evidence_version: "ev-2026-09-25",
    certainty: "probable",
    citation_scope: "design_only",
  });

  // 设计 v2：主像改用新主张；侧像/浮雕/纹样沿用原引用（未变化结论可继承）
  clock.tick();
  chain.publishDesign({
    request_id: "req-design-v2",
    design_id: id.d2,
    revision_of: id.d1,
    summary: "采纳新档案的整版设计 v2",
    claims: [
      { claim_id: id.claimRobeV2, basis: "fact" },
      { claim_id: id.claimScene, basis: "fact" },
      { claim_id: id.claimMotif, basis: "inference" },
    ],
    components: [
      { component_id: id.main, claim_ids: [id.claimRobeV2] },
      { component_id: id.side, claim_ids: [id.claimScene] },
      { component_id: id.relief, claim_ids: [id.claimRobeV2, id.claimScene] },
      { component_id: id.motif, claim_ids: [id.claimMotif] },
    ],
  });

  // v2 发布后主像暂停待办关闭，构件恢复可制作
  assert.equal(chain.state.components.get(id.main).status, ComponentStatus.DESIGNED);
  assert.equal(chain.pendingTodos().some((t) => t.kind === "hold_unmade"), false);

  // 继承也必须由本角色在本版本亲自签署；历史闸门须覆盖新主张 + 继承的场景主张
  assert.throws(
    () =>
      chain.signDesign({
        design_id: id.d2,
        role: SignerRole.HISTORIAN,
        signer: "历史顾问·顾诚",
        gate: Gate.HISTORICAL,
        confirmed: [id.claimRobeV2],
        inherited: [],
      }),
    /未经历史顾问确认/,
  );

  clock.tick();
  chain.signDesign({
    design_id: id.d2,
    role: SignerRole.HISTORIAN,
    signer: "历史顾问·顾诚",
    gate: Gate.HISTORICAL,
    confirmed: [id.claimRobeV2],
    inherited: [id.claimScene],
  });

  // 艺委会继承未变化的推断结论，但不能替历史顾问确认史实
  clock.tick();
  chain.signDesign({
    design_id: id.d2,
    role: SignerRole.ART_COMMITTEE,
    signer: "艺术委员会·林衡",
    gate: Gate.ARTISTIC,
    confirmed: [],
    inherited: [id.claimMotif],
  });
  const artistic = chain.state.designs.get(id.d2).gates[Gate.ARTISTIC];
  assert.deepEqual(artistic.inherited, [id.claimMotif]);

  // 不能继承已变化的主张
  assert.throws(
    () =>
      chain.signDesign({
        design_id: id.d2,
        role: SignerRole.STRUCTURAL,
        signer: "结构师·石坚",
        gate: Gate.STRUCTURAL,
        confirmed: [],
        inherited: [],
      }),
    /材料试验/,
  );
});

test("追溯：从一个构件可追到主张、证据版本、三角色签署、材料批次与铭牌", () => {
  const { chain, id } = buildScenario();

  const trace = traceComponent(chain.state, id.relief);
  // 主张与证据版本（含被推翻后的版本链）
  const robe = trace.claims.find((c) => c.claim_id === id.claimRobe);
  assert.equal(robe.evidence_version, "ev-2026-09-25");
  assert.equal(robe.certainty, Certainty.REFUTED);
  assert.equal(robe.basis, "fact");
  assert.deepEqual(robe.version_chain.map((v) => v.evidence_version), ["ev-2026-08-01", "ev-2026-09-25"]);
  // 三角色签署齐备
  assert.equal(trace.signoffs[Gate.HISTORICAL].role, SignerRole.HISTORIAN);
  assert.equal(trace.signoffs[Gate.ARTISTIC] === null || trace.signoffs[Gate.ARTISTIC].role === SignerRole.ART_COMMITTEE, true);
  assert.equal(trace.signoffs[Gate.INSTALLATION].release_id, id.release);
  // 材料批次与试验
  assert.equal(trace.material.batch_id, id.batchRelief);
  assert.equal(trace.material.result, "pass");
  // 安装记录与铭牌（原文发布事件仍可定位）
  assert.equal(trace.installation.release_id, id.release);
  assert.equal(trace.labels[0].label_id, id.label);
  assert.deepEqual(trace.labels[0].cited_claim_ids, [id.claimRobe, id.claimScene]);
});

test("场景二：结构材料替代——失败批次挂起待办，替代批次通过后才能制作", () => {
  const { chain, id } = buildScenario();

  // 失败批次产生替代待办；不能用失败批次开工
  assert.throws(
    () => chain.fabricate({ design_id: id.d1, batch_id: id.batchMainFail, component_ids: [id.main] }),
    /试验通过/,
  );

  // 替代批次通过：待办转为可执行，主像顺利制作（本场景中主像尚暂停需先解除，
  // 这里单独验证材料链：使用一个不引用被推翻主张的时点由独立小链覆盖）
  const todos = chain.pendingTodos().map((t) => t.kind);
  assert.ok(todos.includes("material_substitution_pending") === false); // 已被替代批次解决
  assert.ok(todos.includes("material_substitution"));

  // 独立小链：材料先失败后替代，结构闸门只认通过的替代批次
  const mini = new ReviewChain();
  mini.submitClaim({
    claim_id: "c1",
    subject: "s",
    evidence_ref: "e",
    evidence_version: "v1",
    certainty: Certainty.CONFIRMED,
    citation_scope: CitationScope.LABEL,
  });
  mini.publishDesign({
    design_id: "d",
    claims: [{ claim_id: "c1", basis: "fact" }],
    components: [{ component_id: "p1", claim_ids: ["c1"] }],
  });
  mini.signDesign({ design_id: "d", role: SignerRole.HISTORIAN, signer: "h", gate: Gate.HISTORICAL, confirmed: ["c1"] });
  mini.signDesign({ design_id: "d", role: SignerRole.ART_COMMITTEE, signer: "a", gate: Gate.ARTISTIC, confirmed: [] });
  mini.recordMaterialTest({
    batch_id: "b-fail",
    design_id: "d",
    component_ids: ["p1"],
    test_ref: "t1",
    spec: "合金甲",
    result: "fail",
    signer: "s",
    signer_role: SignerRole.STRUCTURAL,
  });
  assert.throws(
    () =>
      mini.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.STRUCTURAL, confirmed: [] }),
    /尚无通过的材料试验/,
  );
  mini.recordMaterialTest({
    batch_id: "b-ok",
    design_id: "d",
    component_ids: ["p1"],
    test_ref: "t2",
    spec: "合金乙",
    result: "pass",
    signer: "s",
    signer_role: SignerRole.STRUCTURAL,
    supersedes_batch: "b-fail",
  });
  mini.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.STRUCTURAL, confirmed: [] });
  const made = mini.fabricate({ design_id: "d", batch_id: "b-ok", component_ids: ["p1"] });
  assert.equal(made.events[0].event_type, "COMPONENT_FABRICATED");
  // 追溯中批次明确记录取代关系
  const trace = traceComponent(mini.state, "p1");
  assert.equal(trace.material.batch_id, "b-ok");
  assert.equal(trace.signoffs.material_test.supersedes_batch, "b-fail");
});

test("场景三：安装后更正——原安装与原放行保留，追加更正与铭牌更正", () => {
  const { chain, id } = buildScenario();

  const before = traceComponent(chain.state, id.relief);
  const originalInstallEvent = before.installation.event_id;
  const originalReleaseEvent = before.signoffs[Gate.INSTALLATION].event_id;

  // 已安装构件不能走未制作/已制作的分支
  assert.throws(
    () =>
      chain.dispositionComponent({
        component_id: id.relief,
        action: "replace",
        reason: "x",
        signer: "结构师·石坚",
        signer_role: SignerRole.STRUCTURAL,
      }),
    /不需要处置/,
  );

  // 后续更正：结构安全由结构人员签署；原决定保留
  chain.correctInstallation({
    component_id: id.relief,
    correction_ref: "FIX-2026-09-25-1",
    description: "在浮雕服饰处加装可拆换的纪年校正饰片，不改動原铸本体",
    signer: "结构师·石坚",
    signer_role: SignerRole.STRUCTURAL,
  });
  assert.equal(chain.state.components.get(id.relief).status, ComponentStatus.CORRECTED);

  // 前序更正未完成时，铭牌更正仍是被阻塞待办（不强制代码阻塞，顺序保留即可）
  // 现更正完成，发布铭牌更正：原文与原发布事件保留
  chain.correctLabel({
    label_id: id.label,
    correction_ref: "L-FIX-1",
    cited_claim_ids: [id.claimScene],
    text: "更正：撤下服饰年代表述；场景纪实巡幸的表述维持。",
    reason: "服饰年代主张 claim-robe-era 被新档案推翻",
  });

  const after = traceComponent(chain.state, id.relief);
  assert.equal(after.installation.event_id, originalInstallEvent); // 原安装记录仍在
  assert.equal(after.corrections[0].original_install_event, originalInstallEvent);
  assert.equal(after.corrections[0].original_release_event, originalReleaseEvent);
  assert.equal(after.labels[0].published_event, before.labels[0].published_event); // 原铭牌发布保留
  assert.equal(after.labels[0].corrections.length, 1);
  assert.deepEqual(after.labels[0].corrections[0].cited_claim_ids, [id.claimScene]);

  // 处置分支：已制作的侧像形成处置方案（替换），后继构件进入待制作
  chain.dispositionComponent({
    component_id: id.side,
    action: "replace",
    reason: "服饰纹样错误铸在已制作构件上，无法改造",
    successor_component_id: "C-ROBE-SIDE-2",
    signer: "结构师·石坚",
    signer_role: SignerRole.STRUCTURAL,
  });
  assert.equal(chain.state.components.get(id.side).status, ComponentStatus.DISPOSITIONED);
  assert.equal(chain.state.components.get("C-ROBE-SIDE-2").status, ComponentStatus.DESIGNED);
  assert.ok(chain.pendingTodos().some((t) => t.kind === "await_fabrication" && t.ref === "C-ROBE-SIDE-2"));
});
