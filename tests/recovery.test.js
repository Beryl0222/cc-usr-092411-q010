import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Gate, SignerRole } from "../src/constants.js";
import { ReviewChain } from "../src/chain.js";
import { validateEvent } from "../src/validator.js";
import { ReviewService } from "../src/service.js";
import { ManualClock, scenarioCommands, todoView, IDS } from "./scenario.js";

test("场景四：中断恢复——从日志重放后待办顺序、状态与事件逐位一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-log-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const clock = new ManualClock();

    // 运行到一半（铭牌已发布、新档案尚未到达）模拟进程中断
    const svc1 = new ReviewService(logPath, { now: () => clock.now() });
    await svc1.load();
    const commandsAll = scenarioCommands(IDS);
    for (let i = 0; i < 16; i++) {
      clock.tick();
      await svc1.execute(commandsAll[i][0], commandsAll[i][1]);
    }
    const todosAtBreak = todoView(svc1.pendingTodos());

    // 新实例从日志恢复，继续执行剩余命令
    const svc2 = new ReviewService(logPath, { now: () => clock.now() });
    const restoredCount = await svc2.load();
    assert.equal(restoredCount, 16);
    assert.deepEqual(todoView(svc2.pendingTodos()), todosAtBreak);

    for (let i = 16; i < commandsAll.length; i++) {
      clock.tick();
      await svc2.execute(commandsAll[i][0], commandsAll[i][1]);
    }

    // 最终状态与一次性内存执行完全一致
    const expected = buildInMemory();
    assert.deepEqual(todoView(svc2.pendingTodos()), todoView(expected.chain.pendingTodos()));

    const written = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    const inMemory = expected.chain.history;
    assert.equal(written.length, inMemory.length);
    for (let i = 0; i < written.length; i++) {
      assert.deepEqual(written[i], inMemory[i]);
    }

    // 再做一次全新恢复：待办顺序仍不变（seq 稳定）
    const svc3 = new ReviewService(logPath);
    await svc3.load();
    assert.deepEqual(todoView(svc3.pendingTodos()), todoView(expected.chain.pendingTodos()));
    assert.deepEqual(
      svc3.pendingTodos().map((t) => [t.seq, t.kind, t.ref]),
      [
        [2, "material_substitution", IDS.batchMainOk],
        [3, "hold_unmade", IDS.main],
        [4, "disposition_required", IDS.side],
        [5, "post_installation_correction", IDS.relief],
        [6, "label_correction", IDS.label],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("幂等：同编号请求内容一致才算重放，内容不同即冲突", () => {
  const chain = new ReviewChain();
  const cmd = {
    request_id: "req-1",
    claim_id: "c1",
    subject: "s",
    evidence_ref: "e",
    evidence_version: "v1",
    certainty: "confirmed",
    citation_scope: "label",
  };
  const first = chain.submitClaim(cmd);
  assert.equal(first.replayed, false);
  assert.equal(first.events.length, 1);

  const again = chain.submitClaim({ ...cmd });
  assert.equal(again.replayed, true);
  assert.equal(again.events[0].event_id, first.events[0].event_id);
  assert.equal(chain.history.length, 1); // 重放不产生新事件

  assert.throws(
    () => chain.submitClaim({ ...cmd, evidence_version: "v2" }),
    (err) => err.code === "REQUEST_CONFLICT",
  );

  // 恢复后仍记得请求：同内容重放、异内容冲突
  const restored = ReviewChain.restore(chain.history);
  const replayAfterRestore = restored.submitClaim({ ...cmd });
  assert.equal(replayAfterRestore.replayed, true);
  assert.throws(() => restored.submitClaim({ ...cmd, certainty: "probable" }), (err) => err.code === "REQUEST_CONFLICT");
});

test("签署职责：角色不能代办，并发签署不得越过前序闸门", () => {
  const chain = new ReviewChain();
  chain.submitClaim({ claim_id: "c1", subject: "s", evidence_ref: "e", evidence_version: "v1", certainty: "confirmed", citation_scope: "label" });
  chain.submitClaim({ claim_id: "c2", subject: "s2", evidence_ref: "e2", evidence_version: "v1", certainty: "probable", citation_scope: "design_only" });
  chain.publishDesign({
    design_id: "d",
    claims: [
      { claim_id: "c1", basis: "fact" },
      { claim_id: "c2", basis: "inference" },
    ],
    components: [{ component_id: "p1", claim_ids: ["c1", "c2"] }],
  });

  // 艺委会不能抢在历史闸门之前
  assert.throws(
    () => chain.signDesign({ design_id: "d", role: SignerRole.ART_COMMITTEE, signer: "a", gate: Gate.ARTISTIC, confirmed: ["c2"] }),
    /前序闸门/,
  );
  // 历史顾问不能签艺术推断
  assert.throws(
    () => chain.signDesign({ design_id: "d", role: SignerRole.HISTORIAN, signer: "h", gate: Gate.HISTORICAL, confirmed: ["c1", "c2"] }),
    /不得签署艺术推断/,
  );
  // 角色与闸门必须匹配（结构人员不能签历史闸门）
  assert.throws(
    () => chain.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.HISTORICAL, confirmed: ["c1"] }),
    /无权在闸门/,
  );

  chain.signDesign({ design_id: "d", role: SignerRole.HISTORIAN, signer: "h", gate: Gate.HISTORICAL, confirmed: ["c1"] });

  // 结构闸门不能越过艺术闸门
  assert.throws(
    () => chain.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.STRUCTURAL, confirmed: [] }),
    /前序闸门/,
  );
  chain.signDesign({ design_id: "d", role: SignerRole.ART_COMMITTEE, signer: "a", gate: Gate.ARTISTIC, confirmed: ["c2"] });

  // 结构人员不能在签署时确认史实
  assert.throws(
    () => chain.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.STRUCTURAL, confirmed: ["c1"] }),
    /不得对史实主张/,
  );

  // 非结构人员不能登记材料试验 / 放行安装
  assert.throws(
    () =>
      chain.recordMaterialTest({
        batch_id: "b1",
        design_id: "d",
        component_ids: ["p1"],
        test_ref: "t",
        spec: "合金",
        result: "pass",
        signer: "h",
        signer_role: SignerRole.HISTORIAN,
      }),
    /只有结构人员/,
  );

  // 未通过材料试验，结构闸门不放行；通过后按序完成
  chain.recordMaterialTest({ batch_id: "b1", design_id: "d", component_ids: ["p1"], test_ref: "t", spec: "合金", result: "pass", signer: "s", signer_role: SignerRole.STRUCTURAL });
  chain.signDesign({ design_id: "d", role: SignerRole.STRUCTURAL, signer: "s", gate: Gate.STRUCTURAL, confirmed: [] });
  assert.ok(chain.state.designs.get("d").gates[Gate.STRUCTURAL]);
});

test("全部持久化事件都符合信封契约", async () => {
  const { chain } = buildInMemory();
  for (const event of chain.history) {
    assert.deepEqual(validateEvent(event), []);
    assert.equal(typeof event.payload, "object");
  }
});

// ---- 辅助 ----

function buildInMemory() {
  const clock = new ManualClock();
  const chain = new ReviewChain({ now: () => clock.now() });
  for (const [method, command] of scenarioCommands(IDS)) {
    clock.tick();
    chain[method](command);
  }
  return { clock, chain };
}
