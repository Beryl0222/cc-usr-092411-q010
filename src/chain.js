import {
  Certainty,
  CitationScope,
  ComponentStatus,
  Disposition,
  EventType,
  AggregateType,
  Gate,
  GATE_ORDER,
  SignerRole,
} from "./constants.js";
import { contentHash, makeEvent, newEventId } from "./events.js";
import { applyEvent, createState, pendingTodos } from "./projection.js";

/**
 * 会审链命令分派器：所有业务规则在此校验，合法命令产出一个或多个只追加事件。
 * 纯内存状态 + 可注入时钟；持久化由 EventLog 负责。
 */
export class ReviewChain {
  constructor({ now } = {}) {
    this.state = createState();
    this.history = [];
    this.clock = now ?? (() => new Date());
    this._currentRequest = null;
  }

  /** 从既有事件流恢复（中断恢复）：状态与待办顺序由重放确定。 */
  static restore(events, options = {}) {
    const chain = new ReviewChain(options);
    for (const event of events) {
      applyEvent(chain.state, event);
      chain.history.push(event);
      if (event.request_id) {
        const ids = chain.state.requests.get(event.request_id)?.event_ids ?? [];
        ids.push(event.event_id);
        chain.state.requests.set(event.request_id, { hash: event.request_hash ?? null, event_ids: ids });
      }
    }
    return chain;
  }

  _append(eventType, aggregateType, aggregateId, summary, payload, { causationId = null } = {}) {
    const event = makeEvent({
      eventId: newEventId(this.clock(), this.state.seq + 1),
      eventType,
      aggregateType,
      aggregateId,
      occurredAt: this.clock().toISOString(),
      version: this.state.seq + 1,
      summary,
      payload,
      causationId: causationId,
      requestId: this._currentRequest?.id ?? null,
      requestHash: this._currentRequest?.hash ?? null,
    });
    applyEvent(this.state, event);
    this.history.push(event);
    return event;
  }

  /** 幂等屏障：同编号请求仅在内容一致时重放已产出的事件，否则报冲突。 */
  _idempotency(command) {
    const requestId = command.request_id;
    if (!requestId) return null;
    const seen = this.state.requests.get(requestId);
    const hash = contentHash(command);
    if (seen) {
      if (seen.hash !== hash) {
        const err = new Error(`请求编号 ${requestId} 已用于不同内容，拒绝作为重放处理`);
        err.code = "REQUEST_CONFLICT";
        throw err;
      }
      return { replay: true, event_ids: seen.event_ids };
    }
    return { replay: false, hash };
  }

  _commitRequest(requestId, hash, events) {
    if (requestId) this.state.requests.set(requestId, { hash, event_ids: events.map((e) => e.event_id) });
  }

  _run(command, fn) {
    const guard = this._idempotency(command);
    if (guard?.replay) {
      return { replayed: true, events: guard.event_ids.map((id) => this.history.find((e) => e.event_id === id)) };
    }
    this._currentRequest = command.request_id ? { id: command.request_id, hash: guard?.hash ?? null } : null;
    try {
      const events = fn();
      this._commitRequest(command.request_id, guard?.hash, events);
      return { replayed: false, events };
    } finally {
      this._currentRequest = null;
    }
  }

  // ---- 史实主张 -------------------------------------------------------

  /** 登记主张：绑定证据版本、确定性等级与允许引用范围。 */
  submitClaim(command) {
    return this._run(command, () => {
      const c = command;
      assertValidCertainty(c.certainty);
      assertValidScope(c.citation_scope);
      if (this.state.claims.has(c.claim_id)) throw new Error(`主张已存在：${c.claim_id}`);
      if (c.certainty === Certainty.REFUTED) throw new Error("新登记主张不得直接为 refuted，推翻必须经 CLAIM_REVISED 表达");
      const event = this._append(
        EventType.CLAIM_SUBMITTED,
        AggregateType.HISTORICAL_CLAIM,
        c.claim_id,
        c.summary ?? `登记史实主张 ${c.claim_id}`,
        {
          claim_id: c.claim_id,
          subject: c.subject,
          summary: c.summary ?? null,
          evidence_ref: c.evidence_ref,
          evidence_version: c.evidence_version,
          certainty: c.certainty,
          citation_scope: c.citation_scope,
        },
      );
      return [event];
    });
  }

  /** 证据变化导致主张重评（局部推翻也走这里），只追加，不改写原事件。 */
  reviseClaim(command) {
    return this._run(command, () => {
      const c = command;
      const claim = this.state.claims.get(c.claim_id);
      if (!claim) throw new Error(`主张不存在：${c.claim_id}`);
      assertValidCertainty(c.certainty);
      assertValidScope(c.citation_scope);
      if (c.evidence_version === claim.evidence_version && c.certainty === claim.certainty) {
        throw new Error("证据版本与确定性均未变化，不构成主张修订");
      }
      const event = this._append(
        EventType.CLAIM_REVISED,
        AggregateType.HISTORICAL_CLAIM,
        c.claim_id,
        c.summary ?? `主张 ${c.claim_id} 依据证据 ${c.evidence_version} 重评为 ${c.certainty}`,
        {
          claim_id: c.claim_id,
          summary: c.summary ?? null,
          evidence_ref: c.evidence_ref ?? claim.evidence_ref,
          evidence_version: c.evidence_version,
          certainty: c.certainty,
          citation_scope: c.citation_scope,
          reason: c.reason,
        },
      );
      return [event];
    });
  }

  // ---- 设计版本 -------------------------------------------------------

  /**
   * 发布设计版本：明确每个构件采用哪些主张，以及各引用属于史实(fact)还是艺术推断(inference)。
   * revision_of 指向前一版本时，未变化构件/结论允许被后继签署继承。
   */
  publishDesign(command) {
    return this._run(command, () => {
      const c = command;
      if (this.state.designs.has(c.design_id)) throw new Error(`设计版本已存在：${c.design_id}`);
      if (c.revision_of && !this.state.designs.has(c.revision_of)) throw new Error(`前序设计版本不存在：${c.revision_of}`);
      for (const entry of c.claims ?? []) {
        const claim = this.state.claims.get(entry.claim_id);
        if (!claim) throw new Error(`设计引用了不存在的主张：${entry.claim_id}`);
        if (!claim.active) throw new Error(`主张 ${entry.claim_id} 已非现行版本，不得被新设计采用`);
        if (!["fact", "inference"].includes(entry.basis)) throw new Error(`主张 ${entry.claim_id} 的 basis 必须是 fact 或 inference`);
        if (entry.basis === "inference" && claim.citation_scope === CitationScope.LABEL && claim.certainty === Certainty.CONFIRMED) {
          // 确凿史实当然也可以被当作推断的素材，但必须以 fact 引用，避免稀释签署语义。
          throw new Error(`确凿且可入铭牌的主张 ${entry.claim_id} 应以 fact 引用`);
        }
      }
      for (const comp of c.components ?? []) {
        if (!comp.claim_ids?.length) throw new Error(`构件 ${comp.component_id} 必须至少引用一条主张`);
        for (const claimId of comp.claim_ids) {
          if (!(c.claims ?? []).some((entry) => entry.claim_id === claimId)) {
            throw new Error(`构件 ${comp.component_id} 引用的主张 ${claimId} 未在设计主张清单中声明`);
          }
        }
      }
      const event = this._append(
        EventType.DESIGN_VERSION_PUBLISHED,
        AggregateType.DESIGN_VERSION,
        c.design_id,
        c.summary ?? `发布设计版本 ${c.design_id}`,
        {
          design_id: c.design_id,
          revision_of: c.revision_of ?? null,
          claims: c.claims.map((entry) => ({ claim_id: entry.claim_id, basis: entry.basis })),
          components: c.components.map((comp) => ({ component_id: comp.component_id, claim_ids: [...comp.claim_ids] })),
        },
      );
      return [event];
    });
  }

  /**
   * 角色签署。硬性规则：
   * - 角色与闸门绑定，historian 只签史实、art_committee 只签推断、structural 只签材料/安装；
   * - 必须按闸门顺序推进，并发到达也不得越过前序条件；
   * - 相邻版本允许继承未变化结论（inherited 引用原签署），但本版本仍须对应角色亲自签署，
   *   任何角色不得代办其他闸门。
   */
  signDesign(command) {
    return this._run(command, () => {
      const c = command;
      const design = this.state.designs.get(c.design_id);
      if (!design) throw new Error(`设计版本不存在：${c.design_id}`);
      const gate = c.gate;
      if (gate !== gateOfRole(c.role)) throw new Error(`角色 ${c.role} 无权在闸门 ${gate} 签署`);
      if (design.gates[gate]) throw new Error(`闸门 ${gate} 已完成签署，不得重复签署`);

      const gateIndex = GATE_ORDER.indexOf(gate);
      for (const prior of GATE_ORDER.slice(0, gateIndex)) {
        if (design.gates[prior]) continue;
        // 允许在没有前序版本时直接报缺前序；有前序版本时也必须先在本版本补签/继承前序闸门。
        throw new Error(`闸门 ${gate} 的前序闸门 ${prior} 尚未完成，不得并发越过`);
      }

      const inherited = c.inherited ?? [];
      const confirmed = c.confirmed ?? [];
      const allClaims = [...inherited, ...confirmed];
      const basisClaims = [...design.basis.entries()];

      if (inherited.length) {
        if (!design.revision_of) throw new Error("只有相邻的后继设计版本才能继承结论");
        const prev = this.state.designs.get(design.revision_of);
        for (const claimId of inherited) {
          if (!design.basis.has(claimId)) throw new Error(`继承对象 ${claimId} 不在本版本主张清单中`);
          const unchanged = prev.basis.has(claimId) && this._claimVersionAt(prev, claimId)?.evidence_version === this.state.claims.get(claimId)?.evidence_version;
          if (!unchanged) throw new Error(`主张 ${claimId} 相对前序版本已变化，不能继承，必须重新签署`);
        }
      }

      if (gate === Gate.HISTORICAL) {
        // 历史顾问只确认史实：清单内全部 fact 引用必须覆盖，且不得包含 inference。
        const factIds = basisClaims.filter(([, basis]) => basis === "fact").map(([id]) => id);
        const covered = new Set(allClaims);
        for (const id of factIds) if (!covered.has(id)) throw new Error(`史实主张 ${id} 未经历史顾问确认`);
        for (const id of allClaims) {
          if (design.basis.get(id) !== "fact") throw new Error(`历史顾问不得签署艺术推断 ${id}`);
          const claim = this.state.claims.get(id);
          if (![Certainty.CONFIRMED, Certainty.PROBABLE].includes(claim.certainty)) {
            throw new Error(`主张 ${id} 当前确定性 ${claim.certainty}，历史顾问不能确认`);
          }
        }
      }

      if (gate === Gate.ARTISTIC) {
        const inferenceIds = basisClaims.filter(([, basis]) => basis === "inference").map(([id]) => id);
        const covered = new Set(allClaims);
        for (const id of inferenceIds) if (!covered.has(id)) throw new Error(`艺术推断 ${id} 未经艺术委员会接受`);
        for (const id of allClaims) {
          if (design.basis.get(id) !== "inference") throw new Error(`艺术委员会不得替历史顾问确认史实 ${id}`);
        }
      }

      if (gate === Gate.STRUCTURAL) {
        // 结构设计闸门：不评价史实/艺术，只确认每个构件拟用材料已有通过的结构试验。
        if (allClaims.length) throw new Error("结构闸门不得对史实主张或艺术推断签署");
        const passedBatches = [...this.state.batches.values()].filter((b) => b.design_id === c.design_id && b.result === "pass");
        const untested = design.component_ids.filter((id) => {
          const comp = this.state.components.get(id);
          if (comp?.status === ComponentStatus.HELD) return false; // 暂停构件退出本版本制作范围
          return !passedBatches.some((b) => b.component_ids.includes(id));
        });
        if (untested.length) throw new Error(`构件尚无通过的材料试验，结构闸门不能签署：${untested.join("、")}`);
      }

      const evidenceVersions = {};
      for (const id of confirmed) {
        if (c.role === SignerRole.HISTORIAN) evidenceVersions[id] = this.state.claims.get(id).evidence_version;
      }

      const event = this._append(
        EventType.DESIGN_SIGNED,
        AggregateType.DESIGN_VERSION,
        c.design_id,
        `${roleLabel(c.role)} 完成 ${gate} 闸门签署：${c.signer}`,
        {
          design_id: c.design_id,
          role: c.role,
          signer: c.signer,
          gate,
          inherited,
          confirmed,
          evidence_versions: evidenceVersions,
          note: c.note ?? null,
        },
      );
      return [event];
    });
  }

  _claimVersionAt(design, claimId) {
    const claim = this.state.claims.get(claimId);
    if (!claim) return null;
    // 找到设计发布事件之前的最新主张版本。
    let picked = null;
    for (const v of claim.versions) {
      if (v.event_id <= design.published_event) picked = v;
    }
    return picked ?? claim.versions[0];
  }

  // ---- 材料试验与制作 -------------------------------------------------

  recordMaterialTest(command) {
    return this._run(command, () => {
      const c = command;
      if (c.signer_role !== SignerRole.STRUCTURAL) throw new Error("只有结构人员可以登记材料试验");
      const design = this.state.designs.get(c.design_id);
      if (!design) throw new Error(`设计版本不存在：${c.design_id}`);
      if (!["pass", "fail"].includes(c.result)) throw new Error("result 必须是 pass 或 fail");
      for (const id of c.component_ids) {
        const comp = this.state.components.get(id);
        if (!comp || comp.design_id !== c.design_id) throw new Error(`构件 ${id} 不属于设计 ${c.design_id}`);
      }
      if (c.supersedes_batch && !this.state.batches.has(c.supersedes_batch)) {
        throw new Error(`被替代批次不存在：${c.supersedes_batch}`);
      }
      const event = this._append(
        EventType.MATERIAL_TESTED,
        AggregateType.FABRICATION_BATCH,
        c.batch_id,
        `材料批次 ${c.batch_id}（${c.spec}）试验结果：${c.result === "pass" ? "通过" : "未通过"}`,
        {
          batch_id: c.batch_id,
          design_id: c.design_id,
          component_ids: [...c.component_ids],
          test_ref: c.test_ref,
          spec: c.spec,
          result: c.result,
          signer: c.signer,
          supersedes_batch: c.supersedes_batch ?? null,
        },
      );
      return [event];
    });
  }

  fabricate(command) {
    return this._run(command, () => {
      const c = command;
      const design = this.state.designs.get(c.design_id);
      if (!design) throw new Error(`设计版本不存在：${c.design_id}`);
      if (!design.gates[Gate.STRUCTURAL]) throw new Error("结构闸门未签署，不得开工制作");
      const batch = this.state.batches.get(c.batch_id);
      if (!batch) throw new Error(`材料批次不存在：${c.batch_id}`);
      if (batch.result !== "pass") throw new Error("只有试验通过的批次才能投入制作");
      for (const id of c.component_ids) {
        const comp = this.state.components.get(id);
        if (!comp || comp.design_id !== c.design_id) throw new Error(`构件 ${id} 不属于设计 ${c.design_id}`);
        if (comp.status === ComponentStatus.HELD) throw new Error(`构件 ${id} 已暂停，等待更正后的设计版本`);
        if ([ComponentStatus.FABRICATED, ComponentStatus.INSTALLED, ComponentStatus.CORRECTED].includes(comp.status)) {
          throw new Error(`构件 ${id} 已完成制作/安装，不得重复制作`);
        }
        // 未制作构件若引用了已非现行（被推翻/重评）的主张，必须等更正后的设计版本。
        for (const claimId of comp.claim_ids) {
          const claim = this.state.claims.get(claimId);
          if (!claim?.active) throw new Error(`构件 ${id} 引用的主张 ${claimId} 已非现行，须先采用更正后的设计版本`);
        }
      }
      const event = this._append(
        EventType.COMPONENT_FABRICATED,
        AggregateType.COMPONENT,
        c.component_ids.join("+"),
        `使用批次 ${c.batch_id} 制作构件：${c.component_ids.join("、")}`,
        { design_id: c.design_id, batch_id: c.batch_id, component_ids: [...c.component_ids] },
      );
      return [event];
    });
  }

  // ---- 局部影响分析 ---------------------------------------------------

  /**
   * 证据变化后精确锁定受影响构件（按构件实际引用，而非整版退回）：
   * 未制作 -> 暂停；已制作 -> 处置方案；已安装 -> 后续更正（保留原决定）。
   */
  assessImpact(command) {
    return this._run(command, () => {
      const c = command;
      const claim = this.state.claims.get(c.claim_id);
      if (!claim) throw new Error(`主张不存在：${c.claim_id}`);

      const impacted = [...this.state.components.values()].filter((comp) => comp.claim_ids.includes(c.claim_id));
      const held = [];
      const dispositionRequired = [];
      const correctionRequired = [];
      for (const comp of impacted) {
        if (comp.status === ComponentStatus.DESIGNED || comp.status === ComponentStatus.HELD) {
          held.push(comp.component_id);
        } else if (comp.status === ComponentStatus.FABRICATED || comp.status === ComponentStatus.DISPOSITIONED) {
          dispositionRequired.push({ component_id: comp.component_id, status: comp.status, batch_id: comp.batch_id });
        } else if (comp.status === ComponentStatus.INSTALLED || comp.status === ComponentStatus.CORRECTED) {
          const label = [...this.state.labels.values()].find(
            (l) => l.release_id === comp.installed.release_id && l.cited_claim_ids.includes(c.claim_id),
          );
          correctionRequired.push({
            component_id: comp.component_id,
            release_id: comp.installed.release_id,
            label_id: label?.label_id ?? null,
          });
        }
      }

      const events = [];
      const assessmentId = c.assessment_id;
      const assessed = this._append(
        EventType.IMPACT_ASSESSED,
        AggregateType.HISTORICAL_CLAIM,
        c.claim_id,
        `主张 ${c.claim_id}（证据 ${claim.evidence_version}）影响评估：暂停 ${held.length}，处置 ${dispositionRequired.length}，更正 ${correctionRequired.length}`,
        {
          assessment_id: assessmentId,
          claim_id: c.claim_id,
          evidence_version: claim.evidence_version,
          held,
          disposition_required: dispositionRequired,
          correction_required: correctionRequired,
        },
      );
      events.push(assessed);

      if (held.length) {
        events.push(
          this._append(
            EventType.COMPONENT_HELD,
            AggregateType.COMPONENT,
            held.join("+"),
            `未制作构件暂停：${held.join("、")}`,
            { claim_id: c.claim_id, assessment_id: assessmentId, component_ids: held },
            { causationId: assessed.event_id },
          ),
        );
      }
      return events;
    });
  }

  dispositionComponent(command) {
    return this._run(command, () => {
      const c = command;
      const comp = this.state.components.get(c.component_id);
      if (!comp) throw new Error(`构件不存在：${c.component_id}`);
      if (c.signer_role !== SignerRole.STRUCTURAL) throw new Error("已制作构件的处置方案由结构人员签署");
      if (![Disposition.REPLACE, Disposition.KEEP, Disposition.REWORK].includes(c.action)) throw new Error("处置动作非法");
      if (![ComponentStatus.FABRICATED, ComponentStatus.DISPOSITIONED].includes(comp.status)) {
        throw new Error(`构件 ${c.component_id} 状态 ${comp.status} 不需要处置；未制作应暂停，已安装应更正`);
      }
      const event = this._append(
        EventType.COMPONENT_DISPOSITIONED,
        AggregateType.COMPONENT,
        c.component_id,
        `构件 ${c.component_id} 处置：${c.action}`,
        {
          component_id: c.component_id,
          action: c.action,
          reason: c.reason,
          new_batch_id: c.new_batch_id ?? null,
          successor_component_id: c.successor_component_id ?? null,
          signer: c.signer,
        },
      );
      return [event];
    });
  }

  // ---- 安装放行与安装后更正 -------------------------------------------

  clearInstallation(command) {
    return this._run(command, () => {
      const c = command;
      if (c.signer_role !== SignerRole.STRUCTURAL) throw new Error("安装放行只能由结构人员签署");
      const design = this.state.designs.get(c.design_id);
      if (!design) throw new Error(`设计版本不存在：${c.design_id}`);
      if (!design.gates[Gate.STRUCTURAL]) throw new Error("结构闸门未签署，不得放行安装");
      for (const id of c.component_ids) {
        const comp = this.state.components.get(id);
        if (!comp || comp.design_id !== c.design_id) throw new Error(`构件 ${id} 不属于设计 ${c.design_id}`);
        if (![ComponentStatus.FABRICATED, ComponentStatus.DISPOSITIONED].includes(comp.status)) {
          throw new Error(`构件 ${id} 状态 ${comp.status}，未达到可安装条件`);
        }
        const batch = this.state.batches.get(comp.batch_id);
        if (!batch || batch.result !== "pass") throw new Error(`构件 ${id} 缺少通过的材料试验`);
      }
      const event = this._append(
        EventType.INSTALLATION_CLEARED,
        AggregateType.INSTALLATION_RELEASE,
        c.release_id,
        `结构人员 ${c.signer} 放行安装 ${c.component_ids.length} 个构件`,
        {
          release_id: c.release_id,
          design_id: c.design_id,
          component_ids: [...c.component_ids],
          signer: c.signer,
          note: c.note ?? null,
        },
      );
      return [event];
    });
  }

  install(command) {
    return this._run(command, () => {
      const c = command;
      const release = this.state.releases.get(c.release_id);
      if (!release) throw new Error(`安装放行不存在：${c.release_id}`);
      for (const id of c.component_ids) {
        if (!release.component_ids.includes(id)) throw new Error(`构件 ${id} 不在放行单 ${c.release_id} 内`);
        const comp = this.state.components.get(id);
        if (comp.status === ComponentStatus.INSTALLED) throw new Error(`构件 ${id} 已安装`);
      }
      const event = this._append(
        EventType.COMPONENT_INSTALLED,
        AggregateType.INSTALLATION_RELEASE,
        c.release_id,
        `按放行单安装构件：${c.component_ids.join("、")}`,
        { release_id: c.release_id, component_ids: [...c.component_ids] },
      );
      return [event];
    });
  }

  /** 安装后更正：原安装与原放行事件保留，只追加更正记录并保留可追溯链。 */
  correctInstallation(command) {
    return this._run(command, () => {
      const c = command;
      if (c.signer_role !== SignerRole.STRUCTURAL) throw new Error("安装更正的结构安全部分由结构人员签署");
      const comp = this.state.components.get(c.component_id);
      if (!comp) throw new Error(`构件不存在：${c.component_id}`);
      if (comp.status !== ComponentStatus.INSTALLED && !(comp.status === ComponentStatus.CORRECTED)) {
        throw new Error(`构件 ${c.component_id} 尚未安装，不能走安装后更正`);
      }
      const originalInstall = comp.installed;
      const release = this.state.releases.get(originalInstall.release_id);
      const event = this._append(
        EventType.INSTALLATION_CORRECTED,
        AggregateType.COMPONENT,
        c.component_id,
        `已安装构件 ${c.component_id} 后续更正：${c.correction_ref}（原安装决定保留）`,
        {
          component_id: c.component_id,
          correction_ref: c.correction_ref,
          description: c.description,
          signer: c.signer,
          original_install_event: originalInstall.event_id,
          original_release_event: release.event_id,
        },
      );
      return [event];
    });
  }

  // ---- 铭牌 -----------------------------------------------------------

  releaseLabel(command) {
    return this._run(command, () => {
      const c = command;
      if (this.state.labels.has(c.label_id)) throw new Error(`铭牌已发布：${c.label_id}`);
      const release = this.state.releases.get(c.release_id);
      if (!release) throw new Error(`安装放行不存在：${c.release_id}`);
      for (const claimId of c.cited_claim_ids) {
        const claim = this.state.claims.get(claimId);
        if (!claim) throw new Error(`铭牌引用了不存在的主张：${claimId}`);
        if (!claim.active || claim.certainty === Certainty.REFUTED) throw new Error(`铭牌不得引用已被推翻的主张 ${claimId}`);
        if (claim.citation_scope !== CitationScope.LABEL) throw new Error(`主张 ${claimId} 的引用范围不包含铭牌`);
        if (claim.certainty !== Certainty.CONFIRMED) throw new Error(`只有确凿主张可进入铭牌，${claimId} 为 ${claim.certainty}`);
      }
      const event = this._append(
        EventType.LABEL_RELEASED,
        AggregateType.LABEL,
        c.label_id,
        `发布铭牌 ${c.label_id}，引用 ${c.cited_claim_ids.length} 条确凿主张`,
        {
          label_id: c.label_id,
          release_id: c.release_id,
          cited_claim_ids: [...c.cited_claim_ids],
          text: c.text,
        },
      );
      return [event];
    });
  }

  /** 铭牌更正：原文与原发布事件保留，追加更正版本；不得借更正引入新的越界引用。 */
  correctLabel(command) {
    return this._run(command, () => {
      const c = command;
      const label = this.state.labels.get(c.label_id);
      if (!label) throw new Error(`铭牌不存在：${c.label_id}`);
      for (const claimId of c.cited_claim_ids) {
        const claim = this.state.claims.get(claimId);
        if (!claim || !claim.active || claim.certainty === Certainty.REFUTED || claim.citation_scope !== CitationScope.LABEL || claim.certainty !== Certainty.CONFIRMED) {
          throw new Error(`更正后的铭牌仍不能引用主张 ${claimId}`);
        }
      }
      const event = this._append(
        EventType.LABEL_CORRECTED,
        AggregateType.LABEL,
        c.label_id,
        `铭牌 ${c.label_id} 更正发布：${c.correction_ref}`,
        {
          label_id: c.label_id,
          correction_ref: c.correction_ref,
          cited_claim_ids: [...c.cited_claim_ids],
          text: c.text,
          reason: c.reason,
        },
      );
      return [event];
    });
  }

  pendingTodos() {
    return pendingTodos(this.state);
  }
}

function gateOfRole(role) {
  switch (role) {
    case SignerRole.HISTORIAN:
      return Gate.HISTORICAL;
    case SignerRole.ART_COMMITTEE:
      return Gate.ARTISTIC;
    case SignerRole.STRUCTURAL:
      return Gate.STRUCTURAL;
    default:
      throw new Error(`未知签署角色：${role}`);
  }
}

function roleLabel(role) {
  return {
    [SignerRole.HISTORIAN]: "历史顾问",
    [SignerRole.ART_COMMITTEE]: "艺术委员会",
    [SignerRole.STRUCTURAL]: "结构人员",
  }[role];
}

function assertValidCertainty(value) {
  if (!Object.values(Certainty).includes(value)) throw new Error(`确定性等级非法：${value}`);
}

function assertValidScope(value) {
  if (!Object.values(CitationScope).includes(value)) throw new Error(`引用范围非法：${value}`);
}
