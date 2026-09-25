import { Certainty, ComponentStatus, Disposition, EventType, Gate, SignerRole } from "./constants.js";

/**
 * 纯函数状态投影：把只追加事件流归约为当前会审状态。
 * 不做 I/O；中断恢复时从头重放即可得到完全一致的状态（含待办顺序）。
 */
export function createState() {
  return {
    seq: 0,
    claims: new Map(), // claim_id -> 主张当前视图（含证据版本历史）
    designs: new Map(), // design_id -> 设计版本视图
    components: new Map(), // component_id -> 构件视图
    batches: new Map(), // batch_id -> 材料批次与试验
    releases: new Map(), // release_id -> 安装放行
    labels: new Map(), // label_id -> 铭牌（含更正链）
    impacts: new Map(), // assessment_id -> 影响评估
    todos: [], // 按创建顺序排列，稳定 seq
    eventIds: new Set(),
    requests: new Map(), // request_id -> { hash, event_ids }
  };
}

function pushTodo(state, todo) {
  const blocked_by = todo.blockedBy ?? [];
  // 去重：同一性质、同一对象的未完成待办不重复入队（评估命令重跑安全）。
  const exists = state.todos.some(
    (item) => item.status === "pending" && item.kind === todo.kind && item.ref === todo.ref,
  );
  if (exists) return;
  state.todos.push({
    seq: state.todos.length + 1,
    kind: todo.kind,
    ref: todo.ref,
    reason: todo.reason,
    blocked_by,
    status: "pending",
    created_event: todo.eventId,
    done_event: null,
  });
}

function resolveTodos(state, predicate, doneEvent) {
  for (const todo of state.todos) {
    if (todo.status === "pending" && predicate(todo)) {
      todo.status = "done";
      todo.done_event = doneEvent;
    }
  }
}

/**
 * 应用单个事件。返回 state（原地更新）。重复 event_id 被忽略，保证重放/重投安全。
 */
export function applyEvent(state, event) {
  if (state.eventIds.has(event.event_id)) return state;
  state.eventIds.add(event.event_id);
  state.seq += 1;
  const p = event.payload;

  switch (event.event_type) {
    case EventType.CLAIM_SUBMITTED: {
      state.claims.set(p.claim_id, {
        claim_id: p.claim_id,
        subject: p.subject,
        summary: p.summary,
        evidence_ref: p.evidence_ref,
        evidence_version: p.evidence_version,
        certainty: p.certainty,
        citation_scope: p.citation_scope,
        active: p.certainty !== Certainty.REFUTED,
        versions: [
          { event_id: event.event_id, at: event.occurred_at, evidence_ref: p.evidence_ref, evidence_version: p.evidence_version, certainty: p.certainty, citation_scope: p.citation_scope },
        ],
      });
      break;
    }

    case EventType.CLAIM_REVISED: {
      const claim = state.claims.get(p.claim_id);
      claim.versions.push({
        event_id: event.event_id,
        at: event.occurred_at,
        evidence_ref: p.evidence_ref,
        evidence_version: p.evidence_version,
        certainty: p.certainty,
        citation_scope: p.citation_scope,
        reason: p.reason,
        previous_evidence_version: claim.evidence_version,
        previous_certainty: claim.certainty,
      });
      claim.evidence_ref = p.evidence_ref;
      claim.evidence_version = p.evidence_version;
      claim.certainty = p.certainty;
      claim.citation_scope = p.citation_scope;
      if (p.summary) claim.summary = p.summary;
      claim.active = p.certainty !== Certainty.REFUTED;
      break;
    }

    case EventType.DESIGN_VERSION_PUBLISHED: {
      const prev = p.revision_of ? state.designs.get(p.revision_of) : null;
      state.designs.set(p.design_id, {
        design_id: p.design_id,
        revision_of: p.revision_of ?? null,
        basis: new Map(p.claims.map((entry) => [entry.claim_id, entry.basis])),
        component_ids: p.components.map((c) => c.component_id),
        gates: { [Gate.HISTORICAL]: null, [Gate.ARTISTIC]: null, [Gate.STRUCTURAL]: null, [Gate.INSTALLATION]: null },
        published_event: event.event_id,
      });
      for (const c of p.components) {
        const existing = state.components.get(c.component_id);
        state.components.set(c.component_id, {
          ...(existing ?? { corrections: [], disposition_history: [] }),
          component_id: c.component_id,
          design_id: p.design_id,
          claim_ids: c.claim_ids,
          // 新版设计已采纳更正结论：曾被暂停的未制作构件恢复制作。
          status: existing?.status === ComponentStatus.HELD ? ComponentStatus.DESIGNED : (existing?.status ?? ComponentStatus.DESIGNED),
          batch_id: existing?.batch_id ?? null,
        });
      }
      if (prev) {
        resolveTodos(
          state,
          (todo) => todo.kind === "hold_unmade" && p.components.some((c) => c.component_id === todo.ref),
          event.event_id,
        );
      }
      break;
    }

    case EventType.DESIGN_SIGNED: {
      const design = state.designs.get(p.design_id);
      design.gates[p.gate] = {
        role: p.role,
        signer: p.signer,
        event_id: event.event_id,
        at: event.occurred_at,
        gate: p.gate,
        inherited: p.inherited ?? [],
        confirmed: p.confirmed ?? [],
        evidence_versions: p.evidence_versions ?? {},
        note: p.note ?? null,
      };
      break;
    }

    case EventType.MATERIAL_TESTED: {
      state.batches.set(p.batch_id, {
        batch_id: p.batch_id,
        design_id: p.design_id,
        component_ids: [...p.component_ids],
        test_ref: p.test_ref,
        spec: p.spec,
        result: p.result,
        signer: p.signer,
        event_id: event.event_id,
        at: event.occurred_at,
        supersedes_batch: p.supersedes_batch ?? null,
      });
      if (p.result === "pass" && p.supersedes_batch) {
        pushTodo(state, {
          kind: "material_substitution",
          ref: p.batch_id,
          reason: `批次 ${p.supersedes_batch} 试验未通过，替代材料批次 ${p.batch_id} 试验通过，可用于制作`,
          eventId: event.event_id,
        });
        resolveTodos(state, (todo) => todo.kind === "material_substitution_pending" && todo.ref === p.supersedes_batch, event.event_id);
      }
      if (p.result === "fail") {
        pushTodo(state, {
          kind: "material_substitution_pending",
          ref: p.batch_id,
          reason: `批次 ${p.batch_id}（${p.spec}）试验未通过，结构人员须另选替代材料`,
          eventId: event.event_id,
        });
      }
      break;
    }

    case EventType.COMPONENT_FABRICATED: {
      for (const componentId of p.component_ids) {
        const component = state.components.get(componentId);
        component.status = ComponentStatus.FABRICATED;
        component.batch_id = p.batch_id;
        component.fabricated_event = event.event_id;
        component.disposition_history.push({ type: "fabricated", batch_id: p.batch_id, event_id: event.event_id, at: event.occurred_at });
      }
      resolveTodos(state, (todo) => todo.kind === "await_fabrication" && p.component_ids.includes(todo.ref), event.event_id);
      resolveTodos(state, (todo) => todo.kind === "material_substitution" && todo.ref === p.batch_id, event.event_id);
      break;
    }

    case EventType.COMPONENT_HELD: {
      for (const componentId of p.component_ids) {
        const component = state.components.get(componentId);
        if (component.status === ComponentStatus.DESIGNED || component.status === ComponentStatus.HELD) {
          component.status = ComponentStatus.HELD;
          component.held_event = event.event_id;
        }
      }
      break;
    }

    case EventType.IMPACT_ASSESSED: {
      state.impacts.set(p.assessment_id, {
        assessment_id: p.assessment_id,
        claim_id: p.claim_id,
        evidence_version: p.evidence_version,
        held: p.held,
        disposition_required: p.disposition_required,
        correction_required: p.correction_required,
        event_id: event.event_id,
      });
      for (const componentId of p.held) {
        pushTodo(state, {
          kind: "hold_unmade",
          ref: componentId,
          reason: `引用的主张 ${p.claim_id} 被新证据推翻，未制作构件暂停`,
          eventId: event.event_id,
        });
      }
      for (const item of p.disposition_required) {
        pushTodo(state, {
          kind: "disposition_required",
          ref: item.component_id,
          reason: `已制作构件受主张 ${p.claim_id} 影响，须形成处置方案`,
          eventId: event.event_id,
        });
      }
      for (const item of p.correction_required) {
        pushTodo(state, {
          kind: "post_installation_correction",
          ref: item.component_id,
          reason: `已安装构件受主张 ${p.claim_id} 影响，须通过后续更正保留原决定`,
          eventId: event.event_id,
        });
        if (item.label_id) {
          pushTodo(state, {
            kind: "label_correction",
            ref: item.label_id,
            reason: `铭牌 ${item.label_id} 引用的主张 ${p.claim_id} 已变化，须更正发布`,
            blockedBy: [`post_installation_correction:${item.component_id}`],
            eventId: event.event_id,
          });
        }
      }
      break;
    }

    case EventType.COMPONENT_DISPOSITIONED: {
      const component = state.components.get(p.component_id);
      component.status = ComponentStatus.DISPOSITIONED;
      component.disposition_history.push({
        type: "disposition",
        action: p.action,
        reason: p.reason,
        new_batch_id: p.new_batch_id ?? null,
        successor_component_id: p.successor_component_id ?? null,
        event_id: event.event_id,
        at: event.occurred_at,
      });
      resolveTodos(state, (todo) => todo.kind === "disposition_required" && todo.ref === p.component_id, event.event_id);
      if (p.action === Disposition.REPLACE && p.successor_component_id) {
        state.components.set(p.successor_component_id, {
          component_id: p.successor_component_id,
          design_id: component.design_id,
          claim_ids: component.claim_ids,
          status: ComponentStatus.DESIGNED,
          batch_id: null,
          corrections: [],
          disposition_history: [
            { type: "successor_of", predecessor: p.component_id, event_id: event.event_id, at: event.occurred_at },
          ],
        });
        pushTodo(state, {
          kind: "await_fabrication",
          ref: p.successor_component_id,
          reason: `构件 ${p.component_id} 处置为替换，待制作后继构件 ${p.successor_component_id}`,
          eventId: event.event_id,
        });
      }
      break;
    }

    case EventType.INSTALLATION_CLEARED: {
      state.releases.set(p.release_id, {
        release_id: p.release_id,
        design_id: p.design_id,
        component_ids: [...p.component_ids],
        signer: p.signer,
        event_id: event.event_id,
        at: event.occurred_at,
      });
      const design = state.designs.get(p.design_id);
      design.gates[Gate.INSTALLATION] = {
        role: SignerRole.STRUCTURAL,
        signer: p.signer,
        event_id: event.event_id,
        at: event.occurred_at,
        gate: Gate.INSTALLATION,
        inherited: [],
        confirmed: [...p.component_ids],
        evidence_versions: {},
        note: p.note ?? null,
      };
      break;
    }

    case EventType.COMPONENT_INSTALLED: {
      for (const componentId of p.component_ids) {
        const component = state.components.get(componentId);
        component.status = ComponentStatus.INSTALLED;
        component.installed = { release_id: p.release_id, event_id: event.event_id, at: event.occurred_at };
      }
      break;
    }

    case EventType.INSTALLATION_CORRECTED: {
      const component = state.components.get(p.component_id);
      component.status = ComponentStatus.CORRECTED;
      component.corrections.push({
        correction_ref: p.correction_ref,
        description: p.description,
        signer: p.signer,
        original_install_event: p.original_install_event,
        original_release_event: p.original_release_event,
        event_id: event.event_id,
        at: event.occurred_at,
      });
      resolveTodos(state, (todo) => todo.kind === "post_installation_correction" && todo.ref === p.component_id, event.event_id);
      break;
    }

    case EventType.LABEL_RELEASED: {
      state.labels.set(p.label_id, {
        label_id: p.label_id,
        release_id: p.release_id,
        cited_claim_ids: [...p.cited_claim_ids],
        text: p.text,
        published_event: event.event_id,
        published_at: event.occurred_at,
        corrections: [],
      });
      break;
    }

    case EventType.LABEL_CORRECTED: {
      const label = state.labels.get(p.label_id);
      label.corrections.push({
        correction_ref: p.correction_ref,
        cited_claim_ids: [...p.cited_claim_ids],
        text: p.text,
        reason: p.reason,
        event_id: event.event_id,
        at: event.occurred_at,
      });
      resolveTodos(state, (todo) => todo.kind === "label_correction" && todo.ref === p.label_id, event.event_id);
      break;
    }

    default:
      throw new Error(`未知事件类型：${event.event_type}`);
  }
  return state;
}

export function replay(events) {
  const state = createState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** 待办队列：按创建顺序（seq 升序）；事件流确定后顺序即确定，重放不变。 */
export function pendingTodos(state) {
  return state.todos.filter((todo) => todo.status === "pending").sort((a, b) => a.seq - b.seq);
}

/**
 * 从一个构件反向追溯：主张/证据版本 -> 三角色签署 -> 材料批次/试验 ->
 * 安装放行 -> 铭牌（含更正链）-> 安装后更正（原安装/放行决定保留）。
 */
export function traceComponent(state, componentId) {
  const component = state.components.get(componentId);
  if (!component) throw new Error(`构件不存在：${componentId}`);

  const design = state.designs.get(component.design_id);
  const claims = component.claim_ids.map((claimId) => {
    const claim = state.claims.get(claimId);
    return {
      claim_id: claimId,
      basis: design?.basis.get(claimId) ?? null,
      evidence_ref: claim?.evidence_ref ?? null,
      evidence_version: claim?.evidence_version ?? null,
      certainty: claim?.certainty ?? null,
      citation_scope: claim?.citation_scope ?? null,
      active: claim?.active ?? false,
      version_chain: (claim?.versions ?? []).map((v) => ({
        evidence_version: v.evidence_version,
        certainty: v.certainty,
        event_id: v.event_id,
        at: v.at,
      })),
    };
  });

  const batch = component.batch_id ? state.batches.get(component.batch_id) ?? null : null;
  const releaseId = component.installed?.release_id ?? null;
  const release = releaseId ? state.releases.get(releaseId) ?? null : null;

  const signoffs = design
    ? {
        [Gate.HISTORICAL]: design.gates[Gate.HISTORICAL],
        [Gate.ARTISTIC]: design.gates[Gate.ARTISTIC],
        material_test: batch
          ? {
              batch_id: batch.batch_id,
              test_ref: batch.test_ref,
              spec: batch.spec,
              result: batch.result,
              signer: batch.signer,
              event_id: batch.event_id,
              supersedes_batch: batch.supersedes_batch,
            }
          : null,
        [Gate.INSTALLATION]: release
          ? { release_id: release.release_id, signer: release.signer, event_id: release.event_id, at: release.at }
          : null,
      }
    : null;

  const labels = [];
  for (const label of state.labels.values()) {
    if (release && label.release_id === release.release_id) {
      labels.push({
        label_id: label.label_id,
        published_event: label.published_event,
        cited_claim_ids: label.cited_claim_ids,
        corrections: label.corrections,
      });
    }
  }

  return {
    component_id: componentId,
    design_id: component.design_id,
    status: component.status,
    claims,
    signoffs,
    material: batch
      ? { batch_id: batch.batch_id, spec: batch.spec, test_ref: batch.test_ref, result: batch.result, signer: batch.signer }
      : null,
    installation: component.installed ?? null,
    corrections: component.corrections ?? [],
    disposition_history: component.disposition_history ?? [],
    labels,
  };
}
