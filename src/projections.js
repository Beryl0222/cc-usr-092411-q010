/**
 * 投影：把事件日志折叠成会审链读模型。
 * 纯函数，无副作用；重启后按原顺序重放即可恢复相同状态。
 */
export function buildProjection(events) {
  const state = {
    eventsById: new Map(), // event_id -> event
    claims: new Map(), // 主张号 -> { id, currentVersion, versions: Map(版本 -> 内容), lastEventId }
    designs: new Map(), // 设计版本号 -> 设计记录
    components: new Map(), // 构件号 -> 构件记录
    batches: new Map(), // 批次号 -> { id, component_code, tests: [] }
    installations: new Map(), // 构件号 -> 放行记录
    labels: new Map(), // 铭牌号 -> 铭牌记录
    workItems: new Map(), // 待办号 -> 待办记录（Map 保持插入顺序即待办顺序）
  };
  for (const event of events) applyEvent(state, event);
  return state;
}

export function applyEvent(state, event) {
  state.eventsById.set(event.event_id, event);
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "CLAIM_SUBMITTED": {
      state.claims.set(event.aggregate_id, {
        id: event.aggregate_id,
        currentVersion: event.version,
        versions: new Map([[event.version, claimContent(event)]]),
        lastEventId: event.event_id,
      });
      break;
    }
    case "CLAIM_REVISED": {
      const claim = state.claims.get(event.aggregate_id);
      claim.currentVersion = event.version;
      claim.versions.set(event.version, claimContent(event));
      claim.lastEventId = event.event_id;
      break;
    }
    case "DESIGN_VERSION_PROPOSED": {
      state.designs.set(event.aggregate_id, {
        id: event.aggregate_id,
        eventId: event.event_id,
        basedOn: new Map(p.based_on_claims.map((ref) => [ref.claim_id, ref.claim_version])),
        inferences: new Map(
          p.artistic_inferences.map((inf) => [
            inf.inference_id,
            { basis_claim: inf.basis_claim, rationale: inf.rationale },
          ]),
        ),
        components: [...p.components],
        designer: p.designer,
        predecessorEvent: p.predecessor_event ?? null,
        referredBack: false,
        factConfirmations: new Map(), // 主张号 -> { reviewer, eventId }
        inferenceDecisions: new Map(), // 推断号 -> { decision, reviewer, eventId }
        signers: new Map(), // 签署人 -> 角色（职责分离校验用）
      });
      for (const code of p.components) {
        ensureComponent(state, code).designs.push(event.aggregate_id);
      }
      break;
    }
    case "DESIGN_REVIEWED": {
      const design = state.designs.get(event.aggregate_id);
      if (p.decision === "referred_back") {
        design.referredBack = true;
      } else if (p.decision === "facts_confirmed") {
        for (const ref of p.scope_refs) {
          design.factConfirmations.set(ref, { reviewer: p.reviewer, eventId: event.event_id });
        }
      } else {
        for (const ref of p.scope_refs) {
          design.inferenceDecisions.set(ref, {
            decision: p.decision,
            reviewer: p.reviewer,
            eventId: event.event_id,
          });
        }
      }
      design.signers.set(p.reviewer, p.role);
      break;
    }
    case "MATERIAL_TESTED": {
      let batch = state.batches.get(event.aggregate_id);
      if (!batch) {
        batch = { id: event.aggregate_id, component_code: p.component_code, tests: [] };
        state.batches.set(event.aggregate_id, batch);
      }
      batch.tests.push({
        eventId: event.event_id,
        material_spec: p.material_spec,
        passed: p.passed,
        structural_engineer: p.structural_engineer,
        replaces_batch: p.replaces_batch ?? null,
        test_report: p.test_report ?? null,
      });
      break;
    }
    case "COMPONENT_STATUS_CHANGED": {
      const comp = ensureComponent(state, event.aggregate_id);
      comp.statusHistory.push({
        from: p.from_status,
        to: p.to_status,
        reason: p.reason,
        trigger: p.trigger_event_id ?? null,
        eventId: event.event_id,
      });
      comp.status = p.to_status;
      break;
    }
    case "COMPONENT_FABRICATED": {
      const comp = ensureComponent(state, event.aggregate_id);
      comp.fabrications.push({ eventId: event.event_id, batch_code: p.batch_code, fabricator: p.fabricator });
      comp.status = "fabricated";
      break;
    }
    case "COMPONENT_DISPOSITION_RECORDED": {
      const comp = ensureComponent(state, event.aggregate_id);
      comp.dispositions.push({
        eventId: event.event_id,
        decision: p.decision,
        rationale: p.rationale,
        trigger: p.trigger_event_id,
      });
      break;
    }
    case "INSTALLATION_CLEARED": {
      state.installations.set(event.aggregate_id, {
        eventId: event.event_id,
        structural_engineer: p.structural_engineer,
        design_event_id: p.design_event_id,
        evidence_event_ids: [...p.evidence_event_ids],
      });
      ensureComponent(state, event.aggregate_id).status = "installed";
      break;
    }
    case "LABEL_RELEASED": {
      state.labels.set(event.aggregate_id, {
        id: event.aggregate_id,
        component_code: p.component_code,
        release: {
          eventId: event.event_id,
          cited_claims: p.cited_claims,
          text: p.text,
          curator: p.curator,
          release_event_id: p.release_event_id,
        },
        corrections: [],
      });
      break;
    }
    case "LABEL_CORRECTED": {
      const label = state.labels.get(event.aggregate_id);
      label.corrections.push({
        eventId: event.event_id,
        original_release_event_id: p.original_release_event_id,
        correction_text: p.correction_text,
        reason: p.reason,
        trigger_event_id: p.trigger_event_id,
        cited_claims: p.cited_claims,
        curator: p.curator,
      });
      break;
    }
    case "WORK_ITEM_RAISED": {
      state.workItems.set(event.aggregate_id, {
        id: event.aggregate_id,
        kind: p.kind,
        component_code: p.component_code,
        trigger_event_id: p.trigger_event_id,
        sequence: p.sequence,
        status: "open",
        resolution_event_id: null,
      });
      break;
    }
    case "WORK_ITEM_COMPLETED": {
      const item = state.workItems.get(event.aggregate_id);
      item.status = "done";
      item.resolution_event_id = p.resolution_event_id;
      break;
    }
    default:
      break;
  }
}

function claimContent(event) {
  const p = event.payload;
  return {
    eventId: event.event_id,
    statement: p.statement,
    evidence_id: p.evidence_id,
    evidence_version: p.evidence_version,
    certainty: p.certainty,
    allowed_citation: [...p.allowed_citation],
    historian: p.historian,
  };
}

function ensureComponent(state, code) {
  let comp = state.components.get(code);
  if (!comp) {
    comp = { code, status: "planned", designs: [], dispositions: [], fabrications: [], statusHistory: [] };
    state.components.set(code, comp);
  }
  return comp;
}

/** 铭牌当前生效的引用（最后一次更正优先，否则原发布）。 */
export function effectiveCitedClaims(label) {
  return label.corrections.length > 0
    ? label.corrections[label.corrections.length - 1].cited_claims
    : label.release.cited_claims;
}

/**
 * 设计版本的会审缺口。
 * 相邻版本继承：主张编号与采用版本均未变化，继承前序版本的史实确认；
 * 推断编号、依据主张与理由均未变化，继承前序版本的接受结论。
 * 签署职责不可继承：继承的只是结论，签署人记录仍属于原版本。
 */
export function designSignoffGaps(state, designId) {
  const design = state.designs.get(designId);
  if (!design) return { referredBack: false, missingFacts: [], missingInferences: [], unknown: true };
  if (design.referredBack) {
    return {
      referredBack: true,
      missingFacts: [...design.basedOn.keys()],
      missingInferences: [...design.inferences.keys()],
    };
  }
  const facts = coveredFacts(state, designId, new Map());
  const inferences = coveredInferences(state, designId, new Map());
  return {
    referredBack: false,
    missingFacts: [...design.basedOn.keys()].filter((id) => !facts.has(id)),
    missingInferences: [...design.inferences.keys()].filter((id) => !inferences.has(id)),
  };
}

export function designFullySigned(state, designId) {
  const gaps = designSignoffGaps(state, designId);
  return !gaps.referredBack && !gaps.unknown && gaps.missingFacts.length === 0 && gaps.missingInferences.length === 0;
}

function coveredFacts(state, designId, memo) {
  if (memo.has(designId)) return memo.get(designId);
  const design = state.designs.get(designId);
  const covered = new Set(design.factConfirmations.keys());
  const pred = predecessorDesign(state, design);
  if (pred && !pred.referredBack) {
    for (const claimId of coveredFacts(state, pred.id, memo)) {
      if (design.basedOn.get(claimId) !== undefined && design.basedOn.get(claimId) === pred.basedOn.get(claimId)) {
        covered.add(claimId);
      }
    }
  }
  memo.set(designId, covered);
  return covered;
}

function coveredInferences(state, designId, memo) {
  if (memo.has(designId)) return memo.get(designId);
  const design = state.designs.get(designId);
  const covered = new Set(
    [...design.inferenceDecisions]
      .filter(([, dec]) => dec.decision === "inference_accepted")
      .map(([id]) => id),
  );
  const pred = predecessorDesign(state, design);
  if (pred && !pred.referredBack) {
    for (const infId of coveredInferences(state, pred.id, memo)) {
      const own = design.inferences.get(infId);
      const prev = pred.inferences.get(infId);
      if (own && prev && own.basis_claim === prev.basis_claim && own.rationale === prev.rationale) {
        covered.add(infId);
      }
    }
  }
  memo.set(designId, covered);
  return covered;
}

function predecessorDesign(state, design) {
  if (!design.predecessorEvent) return null;
  const event = state.eventsById.get(design.predecessorEvent);
  if (!event || event.event_type !== "DESIGN_VERSION_PROPOSED") return null;
  return state.designs.get(event.aggregate_id) ?? null;
}
