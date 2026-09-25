import { ConflictError, DomainError } from "./errors.js";
import { ROLES } from "./events.js";
import {
  applyEvent,
  buildProjection,
  designSignoffGaps,
  effectiveCitedClaims,
} from "./projections.js";
import { EventStore, fingerprintOf } from "./store.js";
import { validateEvent } from "./validator.js";

/** 各角色在设计会审中允许作出的结论。 */
const ROLE_DECISIONS = {
  [ROLES.HISTORIAN]: ["facts_confirmed", "referred_back"],
  [ROLES.ART_COMMITTEE]: ["inference_accepted", "inference_rejected", "referred_back"],
};

const FINAL_DISPOSITIONS = ["rework", "substitute_material", "keep_with_annotation", "scrap"];

/**
 * 主题雕塑史实主张会审链服务。
 * 命令侧：先做请求判重（同编号且内容一致直接返回首次结果），再校验前置条件与职责，
 * 最后写入事件。事件一经写入不得改写，更正以追加后继事件完成。
 */
export class ReviewService {
  #store;
  #state;

  constructor(store) {
    this.#store = store;
    this.#state = buildProjection(store.all());
  }

  /** 从 JSONL 文件恢复服务（中断恢复入口）。 */
  static load(filePath) {
    return new ReviewService(new EventStore(filePath));
  }

  get store() {
    return this.#store;
  }

  get state() {
    return this.#state;
  }

  /** 当前待办队列，顺序与事件顺序一致，恢复后不变。 */
  openWorkItems() {
    return [...this.#state.workItems.values()].filter((item) => item.status === "open");
  }

  designGaps(designId) {
    return designSignoffGaps(this.#state, designId);
  }

  /** 登记史实主张：绑定证据版本、确定性等级与允许引用范围。 */
  submitClaim(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("submitClaim", request_id, content, occurred_at, () => {
      const { claim_id, statement, evidence_id, evidence_version, certainty, allowed_citation, historian } = content;
      if (this.#state.claims.has(claim_id)) throw new DomainError(`主张 ${claim_id} 已存在`);
      return [
        this.#draft(request_id, 1, "CLAIM_SUBMITTED", "historical_claim", claim_id, `登记史实主张 ${claim_id}`, {
          statement,
          evidence_id,
          evidence_version,
          certainty,
          allowed_citation,
          historian,
        }),
      ];
    });
  }

  /**
   * 修订史实主张（证据变化），并精确找出受影响构件：
   * 未制作的暂停，已制作的登记处置方案，已安装的保留原决定、通过铭牌更正跟进。
   * 修订与影响事件在同一命令内原子写入。
   */
  reviseClaim(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("reviseClaim", request_id, content, occurred_at, () => {
      const { claim_id, statement, evidence_id, evidence_version, certainty, allowed_citation, reason, historian, expected_version } = content;
      const claim = this.#state.claims.get(claim_id);
      if (!claim) throw new DomainError(`主张 ${claim_id} 不存在`);

      const revisionEventId = `${request_id}#1`;
      const drafts = [
        this.#draft(request_id, 1, "CLAIM_REVISED", "historical_claim", claim_id, `修订史实主张 ${claim_id}：${reason}`, {
          statement,
          evidence_id,
          evidence_version,
          certainty,
          allowed_citation,
          reason,
          historian,
          supersedes_version_event: claim.lastEventId,
        }, expected_version),
      ];

      // 受影响构件：其最新设计版本采用了该主张。按构件号排序，保证待办顺序确定。
      const affected = [...this.#state.components.values()]
        .filter((comp) => {
          const latestDesignId = comp.designs[comp.designs.length - 1];
          return latestDesignId && this.#state.designs.get(latestDesignId).basedOn.has(claim_id);
        })
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

      let seq = 0;
      let index = 1;
      const nextIndex = () => ++index;
      for (const comp of affected) {
        if (comp.status === "planned") {
          // 未制作：暂停
          drafts.push(
            this.#draft(request_id, nextIndex(), "COMPONENT_STATUS_CHANGED", "component", comp.code, `构件 ${comp.code} 暂停（主张 ${claim_id} 被修订）`, {
              from_status: "planned",
              to_status: "suspended",
              reason: `主张 ${claim_id} 被修订，未制作部分暂停`,
              trigger_event_id: revisionEventId,
            }),
          );
          drafts.push(this.#raiseWorkItem(request_id, nextIndex(), `wi-${request_id}-${++seq}`, "resolve_suspension", comp.code, revisionEventId, seq));
        } else if (comp.status === "fabricated") {
          // 已制作：形成处置方案（先登记待定，由策划负责人决定）
          drafts.push(
            this.#draft(request_id, nextIndex(), "COMPONENT_DISPOSITION_RECORDED", "component", comp.code, `构件 ${comp.code} 待处置（主张 ${claim_id} 被修订）`, {
              decision: "pending",
              rationale: `主张 ${claim_id} 被修订，已制作构件待处置`,
              trigger_event_id: revisionEventId,
            }),
          );
          drafts.push(this.#raiseWorkItem(request_id, nextIndex(), `wi-${request_id}-${++seq}`, "execute_disposition", comp.code, revisionEventId, seq));
        }
        // installed：保留原安装决定，不触碰构件，由下方铭牌更正跟进
      }

      // 铭牌：引用了该主张旧版本的已发布铭牌，按铭牌号排序出具更正待办
      const newVersion = claim.currentVersion + 1;
      const staleLabels = [...this.#state.labels.values()]
        .filter((label) =>
          effectiveCitedClaims(label).some((ref) => ref.claim_id === claim_id && ref.claim_version < newVersion),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const label of staleLabels) {
        if (this.#findOpenWorkItem("issue_label_correction", label.component_code)) continue;
        drafts.push(this.#raiseWorkItem(request_id, nextIndex(), `wi-${request_id}-${++seq}`, "issue_label_correction", label.component_code, revisionEventId, seq));
      }

      return drafts;
    });
  }

  /** 提交设计版本：明确采用哪些史实（含版本）与哪些艺术推断。 */
  proposeDesign(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("proposeDesign", request_id, content, occurred_at, () => {
      const { design_id, based_on_claims, artistic_inferences = [], components, designer, predecessor_event, expected_version } = content;
      if (this.#state.designs.has(design_id)) throw new DomainError(`设计版本 ${design_id} 已存在`);
      for (const ref of based_on_claims) {
        const claim = this.#state.claims.get(ref.claim_id);
        if (!claim) throw new DomainError(`主张 ${ref.claim_id} 不存在`);
        if (ref.claim_version !== claim.currentVersion) {
          throw new DomainError(`设计必须采用主张 ${ref.claim_id} 的当前版本 ${claim.currentVersion}，而非 ${ref.claim_version}`);
        }
        if (!claim.versions.get(ref.claim_version).allowed_citation.includes("design")) {
          throw new DomainError(`主张 ${ref.claim_id} 版本 ${ref.claim_version} 不允许在设计中引用`);
        }
      }
      for (const inf of artistic_inferences) {
        if (!based_on_claims.some((ref) => ref.claim_id === inf.basis_claim)) {
          throw new DomainError(`推断 ${inf.inference_id} 的依据主张 ${inf.basis_claim} 未被本版本采用`);
        }
      }
      if (predecessor_event !== undefined) {
        const pred = this.#state.eventsById.get(predecessor_event);
        if (!pred || pred.event_type !== "DESIGN_VERSION_PROPOSED") {
          throw new DomainError(`前序事件 ${predecessor_event} 不是有效的设计版本`);
        }
      }
      return [
        this.#draft(request_id, 1, "DESIGN_VERSION_PROPOSED", "design_version", design_id, `提交设计版本 ${design_id}`, {
          based_on_claims,
          artistic_inferences,
          components,
          designer,
          ...(predecessor_event !== undefined ? { predecessor_event } : {}),
        }, expected_version),
      ];
    });
  }

  /**
   * 设计会审签署。历史顾问只确认史实，艺术委员会只决定推断；
   * 签署职责不得互相代办（同一签署人不得在同一版本跨角色签署）；
   * 调用方可带 expected_version 做乐观并发，防止并发签署越过前序条件。
   */
  reviewDesign(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("reviewDesign", request_id, content, occurred_at, () => {
      const { design_id, role, decision, reviewer, scope_refs, expected_version } = content;
      const design = this.#state.designs.get(design_id);
      if (!design) throw new DomainError(`设计版本 ${design_id} 不存在`);
      if (design.referredBack) throw new DomainError(`设计版本 ${design_id} 已被退回，须提交新版本`);
      if (!ROLE_DECISIONS[role]?.includes(decision)) {
        throw new DomainError(`角色 ${role} 无权作出 ${decision} 结论，签署职责不得互相代办`);
      }
      const priorRole = design.signers.get(reviewer);
      if (priorRole && priorRole !== role) {
        throw new DomainError(`签署人 ${reviewer} 已以 ${priorRole} 身份签署本版本，不得跨职责代办`);
      }
      if (decision === "facts_confirmed") {
        for (const ref of scope_refs) {
          if (!design.basedOn.has(ref)) throw new DomainError(`${ref} 不是本版本采用的史实主张`);
        }
      } else if (decision === "inference_accepted" || decision === "inference_rejected") {
        for (const ref of scope_refs) {
          if (!design.inferences.has(ref)) throw new DomainError(`${ref} 不是本版本的艺术推断`);
        }
      }
      return [
        this.#draft(request_id, 1, "DESIGN_REVIEWED", "design_version", design_id, `设计版本 ${design_id} 会审：${role} 作出 ${decision}`, {
          role,
          decision,
          reviewer,
          scope_refs,
        }, expected_version),
      ];
    });
  }

  /** 材料批次试验：结构人员只对材料安全签署；前序条件是构件所属最新设计版本已通过会审。 */
  testMaterial(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("testMaterial", request_id, content, occurred_at, () => {
      const { batch_id, component_code, material_spec, passed, structural_engineer, replaces_batch, test_report, expected_version } = content;
      const comp = this.#requireComponent(component_code);
      if (comp.status === "suspended") throw new DomainError(`构件 ${component_code} 已暂停，须先完成主张复核`);
      if (comp.status === "scrapped") throw new DomainError(`构件 ${component_code} 已报废`);
      if (comp.status === "installed") throw new DomainError(`构件 ${component_code} 已安装，不得再试验`);
      this.#requireDesignSigned(comp);
      const existing = this.#state.batches.get(batch_id);
      if (existing && existing.component_code !== component_code) {
        throw new DomainError(`批次 ${batch_id} 属于构件 ${existing.component_code}`);
      }
      if (replaces_batch !== undefined) {
        const replaced = this.#state.batches.get(replaces_batch);
        if (!replaced) throw new DomainError(`被替代批次 ${replaces_batch} 不存在`);
        if (replaced.component_code !== component_code) {
          throw new DomainError(`被替代批次 ${replaces_batch} 不属于构件 ${component_code}`);
        }
      }
      return [
        this.#draft(request_id, 1, "MATERIAL_TESTED", "fabrication_batch", batch_id, `批次 ${batch_id} 材料试验${passed ? "通过" : "未通过"}`, {
          component_code,
          material_spec,
          passed,
          structural_engineer,
          ...(replaces_batch !== undefined ? { replaces_batch } : {}),
          ...(test_report !== undefined ? { test_report } : {}),
        }, expected_version),
      ];
    });
  }

  /** 构件制作：须状态为待制作，且所用批次最近一次试验通过。 */
  fabricateComponent(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("fabricateComponent", request_id, content, occurred_at, () => {
      const { component_code, batch_code, fabricator } = content;
      const comp = this.#requireComponent(component_code);
      if (comp.status !== "planned") throw new DomainError(`构件 ${component_code} 状态为 ${comp.status}，不能制作`);
      const batch = this.#state.batches.get(batch_code);
      if (!batch || batch.component_code !== component_code) {
        throw new DomainError(`批次 ${batch_code} 不属于构件 ${component_code}`);
      }
      const latestTest = batch.tests[batch.tests.length - 1];
      if (!latestTest || !latestTest.passed) throw new DomainError(`批次 ${batch_code} 尚未通过材料试验`);
      return [
        this.#draft(request_id, 1, "COMPONENT_FABRICATED", "component", component_code, `构件 ${component_code} 制作完成（批次 ${batch_code}）`, {
          batch_code,
          fabricator,
        }),
      ];
    });
  }

  /** 落实已制作构件的处置方案，办结对应待办。 */
  recordDisposition(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("recordDisposition", request_id, content, occurred_at, () => {
      const { component_code, decision, rationale, trigger_event_id, planner } = content;
      const comp = this.#requireComponent(component_code);
      if (comp.status !== "fabricated") throw new DomainError(`构件 ${component_code} 状态为 ${comp.status}，无需处置`);
      if (!FINAL_DISPOSITIONS.includes(decision)) {
        throw new DomainError(`处置决定必须是 ${FINAL_DISPOSITIONS.join(" / ")}`);
      }
      const item = this.#requireOpenWorkItem("execute_disposition", component_code, trigger_event_id);
      const drafts = [
        this.#draft(request_id, 1, "COMPONENT_DISPOSITION_RECORDED", "component", component_code, `构件 ${component_code} 处置决定：${decision}`, {
          decision,
          rationale,
          trigger_event_id,
          planner,
        }),
      ];
      let index = 1;
      if (decision === "scrap") {
        drafts.push(this.#statusChange(request_id, ++index, component_code, "fabricated", "scrapped", rationale, trigger_event_id));
      } else if (decision === "rework" || decision === "substitute_material") {
        drafts.push(this.#statusChange(request_id, ++index, component_code, "fabricated", "planned", `处置决定 ${decision}：${rationale}`, trigger_event_id));
      }
      drafts.push(this.#completeWorkItem(request_id, ++index, item, drafts[0].event_id));
      return drafts;
    });
  }

  /** 解除未制作构件的暂停：须有采用全部当前主张且已通过会审的新设计版本。 */
  resumeComponent(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("resumeComponent", request_id, content, occurred_at, () => {
      const { component_code, design_event_id, trigger_event_id, planner } = content;
      const comp = this.#requireComponent(component_code);
      if (comp.status !== "suspended") throw new DomainError(`构件 ${component_code} 状态为 ${comp.status}，不在暂停中`);
      const item = this.#requireOpenWorkItem("resolve_suspension", component_code, trigger_event_id);
      const designId = this.#requireSignedDesign(design_event_id, component_code);
      for (const [claimId, version] of this.#state.designs.get(designId).basedOn) {
        const claim = this.#state.claims.get(claimId);
        if (claim.currentVersion !== version) {
          throw new DomainError(`设计版本 ${designId} 采用的主张 ${claimId} 版本 ${version} 已被版本 ${claim.currentVersion} 取代`);
        }
      }
      const statusEvent = this.#statusChange(request_id, 1, component_code, "suspended", "planned", `依据设计版本 ${designId} 恢复制作`, trigger_event_id);
      return [statusEvent, this.#completeWorkItem(request_id, 2, item, statusEvent.event_id)];
    });
  }

  /** 安装放行：结构人员签署，须引用通过会审的设计版本与材料/处置依据。 */
  clearInstallation(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("clearInstallation", request_id, content, occurred_at, () => {
      const { component_code, structural_engineer, design_event_id, evidence_event_ids } = content;
      const comp = this.#requireComponent(component_code);
      if (comp.status !== "fabricated") throw new DomainError(`构件 ${component_code} 状态为 ${comp.status}，不能放行安装`);
      if (this.#state.installations.has(component_code)) throw new DomainError(`构件 ${component_code} 已放行，不得重复`);
      this.#requireSignedDesign(design_event_id, component_code);

      const latestFabrication = comp.fabrications[comp.fabrications.length - 1];
      let hasPassedTestForBatch = false;
      for (const evidenceId of evidence_event_ids) {
        const evidence = this.#state.eventsById.get(evidenceId);
        if (!evidence) throw new DomainError(`依据事件 ${evidenceId} 不存在`);
        if (evidence.event_type === "MATERIAL_TESTED") {
          const batch = this.#state.batches.get(evidence.aggregate_id);
          if (!batch || batch.component_code !== component_code || !evidence.payload.passed) {
            throw new DomainError(`依据事件 ${evidenceId} 不是本构件通过的材料试验`);
          }
          if (latestFabrication && evidence.aggregate_id === latestFabrication.batch_code) {
            hasPassedTestForBatch = true;
          }
        } else if (evidence.event_type === "COMPONENT_DISPOSITION_RECORDED") {
          if (evidence.aggregate_id !== component_code || evidence.payload.decision !== "keep_with_annotation") {
            throw new DomainError(`依据事件 ${evidenceId} 不是本构件的保留处置`);
          }
        } else {
          throw new DomainError(`依据事件 ${evidenceId} 的类型 ${evidence.event_type} 不能作为安装放行依据`);
        }
      }
      if (!hasPassedTestForBatch) {
        throw new DomainError(`安装放行须包含构件 ${component_code} 当前批次通过的材料试验`);
      }
      return [
        this.#draft(request_id, 1, "INSTALLATION_CLEARED", "installation_release", component_code, `构件 ${component_code} 安装放行`, {
          structural_engineer,
          design_event_id,
          evidence_event_ids,
        }),
      ];
    });
  }

  /** 发布铭牌：只引用当前版本且允许铭牌引用的主张。 */
  releaseLabel(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("releaseLabel", request_id, content, occurred_at, () => {
      const { label_id, component_code, cited_claims, text, curator, release_event_id } = content;
      if (this.#state.labels.has(label_id)) throw new DomainError(`铭牌 ${label_id} 已存在`);
      const installation = this.#state.installations.get(component_code);
      if (!installation) throw new DomainError(`构件 ${component_code} 尚未安装放行，铭牌不得发布`);
      if (installation.eventId !== release_event_id) {
        throw new DomainError(`release_event_id 与构件 ${component_code} 的放行事件不一致`);
      }
      this.#checkCitations(cited_claims);
      return [
        this.#draft(request_id, 1, "LABEL_RELEASED", "plaque_label", label_id, `铭牌 ${label_id} 发布`, {
          component_code,
          cited_claims,
          text,
          curator,
          release_event_id,
        }),
      ];
    });
  }

  /** 更正铭牌：原发布保留，更正以后继事件呈现，并办结更正待办。 */
  correctLabel(args) {
    const { request_id, occurred_at, ...content } = args;
    return this.#run("correctLabel", request_id, content, occurred_at, () => {
      const { label_id, original_release_event_id, correction_text, reason, trigger_event_id, cited_claims, curator } = content;
      const label = this.#state.labels.get(label_id);
      if (!label) throw new DomainError(`铭牌 ${label_id} 不存在`);
      if (label.release.eventId !== original_release_event_id) {
        throw new DomainError(`original_release_event_id 与铭牌 ${label_id} 的原发布事件不一致`);
      }
      const item = this.#requireOpenWorkItem("issue_label_correction", label.component_code, trigger_event_id);
      this.#checkCitations(cited_claims);
      const correction = this.#draft(request_id, 1, "LABEL_CORRECTED", "plaque_label", label_id, `铭牌 ${label_id} 更正：${reason}`, {
        original_release_event_id,
        correction_text,
        reason,
        trigger_event_id,
        cited_claims,
        curator,
      });
      return [correction, this.#completeWorkItem(request_id, 2, item, correction.event_id)];
    });
  }

  // ---- 内部工具 ----

  /**
   * 命令入口：先按 request_id 判重（重放直接返回首次结果，不再执行前置条件），
   * 新请求才构建事件草稿，按契约校验后写入存储并折叠进读模型。
   */
  #run(method, requestId, content, occurredAt, build) {
    const fingerprint = fingerprintOf([method, content]);
    const prior = this.#store.lookupRequest(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ConflictError(`请求 ${requestId} 与已接收内容不一致，不构成重放`);
      }
      return { events: prior.events, replayed: true };
    }
    const drafts = build();
    for (const draft of drafts) {
      const errors = validateEvent({ ...draft, occurred_at: occurredAt ?? new Date().toISOString(), version: 1 });
      if (errors.length > 0) throw new DomainError(`事件未通过契约校验：${errors.join("；")}`);
    }
    const { events } = this.#store.dispatch({ request_id: requestId, fingerprint, events: drafts, occurred_at: occurredAt });
    for (const event of events) applyEvent(this.#state, event);
    return { events, replayed: false };
  }

  #draft(requestId, index, eventType, aggregateType, aggregateId, summary, payload, expectedVersion) {
    const draft = {
      event_id: `${requestId}#${index}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      summary,
      payload,
    };
    if (expectedVersion !== undefined) draft.expected_version = expectedVersion;
    return draft;
  }

  #raiseWorkItem(requestId, index, workId, kind, componentCode, triggerEventId, sequence) {
    return this.#draft(requestId, index, "WORK_ITEM_RAISED", "work_item", workId, `产生待办 ${workId}（${kind}，构件 ${componentCode}）`, {
      kind,
      component_code: componentCode,
      trigger_event_id: triggerEventId,
      sequence,
    });
  }

  #completeWorkItem(requestId, index, item, resolutionEventId) {
    return this.#draft(requestId, index, "WORK_ITEM_COMPLETED", "work_item", item.id, `待办 ${item.id} 办结`, {
      resolution_event_id: resolutionEventId,
    });
  }

  #statusChange(requestId, index, componentCode, from, to, reason, triggerEventId) {
    return this.#draft(requestId, index, "COMPONENT_STATUS_CHANGED", "component", componentCode, `构件 ${componentCode} 状态 ${from} → ${to}`, {
      from_status: from,
      to_status: to,
      reason,
      trigger_event_id: triggerEventId,
    });
  }

  #requireComponent(componentCode) {
    const comp = this.#state.components.get(componentCode);
    if (!comp) throw new DomainError(`构件 ${componentCode} 不存在`);
    return comp;
  }

  /** 构件所属最新设计版本须已通过会审（材料试验、制作等的前序条件）。 */
  #requireDesignSigned(comp) {
    const latestDesignId = comp.designs[comp.designs.length - 1];
    if (!latestDesignId) throw new DomainError(`构件 ${comp.code} 不属于任何设计版本`);
    const gaps = designSignoffGaps(this.#state, latestDesignId);
    if (gaps.referredBack) throw new DomainError(`设计版本 ${latestDesignId} 已被退回`);
    if (gaps.missingFacts.length > 0 || gaps.missingInferences.length > 0) {
      throw new DomainError(`设计版本 ${latestDesignId} 尚未完成会审签署，不得进入后续环节`);
    }
    return latestDesignId;
  }

  #requireSignedDesign(designEventId, componentCode) {
    const event = this.#state.eventsById.get(designEventId);
    if (!event || event.event_type !== "DESIGN_VERSION_PROPOSED") {
      throw new DomainError(`${designEventId} 不是有效的设计版本事件`);
    }
    const designId = event.aggregate_id;
    const design = this.#state.designs.get(designId);
    if (!design.components.includes(componentCode)) {
      throw new DomainError(`设计版本 ${designId} 不包含构件 ${componentCode}`);
    }
    const gaps = designSignoffGaps(this.#state, designId);
    if (gaps.referredBack) throw new DomainError(`设计版本 ${designId} 已被退回`);
    if (gaps.missingFacts.length > 0 || gaps.missingInferences.length > 0) {
      throw new DomainError(`设计版本 ${designId} 尚未完成会审签署`);
    }
    return designId;
  }

  #checkCitations(citedClaims) {
    for (const ref of citedClaims) {
      const claim = this.#state.claims.get(ref.claim_id);
      if (!claim) throw new DomainError(`主张 ${ref.claim_id} 不存在`);
      if (ref.claim_version !== claim.currentVersion) {
        throw new DomainError(
          `主张 ${ref.claim_id} 的引用版本 ${ref.claim_version} 已被版本 ${claim.currentVersion} 取代，铭牌不得引用被修订的史实`,
        );
      }
      if (!claim.versions.get(ref.claim_version).allowed_citation.includes("label")) {
        throw new DomainError(`主张 ${ref.claim_id} 版本 ${ref.claim_version} 不允许在铭牌中引用`);
      }
    }
  }

  #findOpenWorkItem(kind, componentCode) {
    return [...this.#state.workItems.values()].find(
      (item) => item.status === "open" && item.kind === kind && item.component_code === componentCode,
    );
  }

  #requireOpenWorkItem(kind, componentCode, triggerEventId) {
    const item = [...this.#state.workItems.values()].find(
      (w) =>
        w.status === "open" &&
        w.kind === kind &&
        w.component_code === componentCode &&
        w.trigger_event_id === triggerEventId,
    );
    if (!item) {
      throw new DomainError(`构件 ${componentCode} 没有待办结的 ${kind} 待办（触发事件 ${triggerEventId}）`);
    }
    return item;
  }
}
