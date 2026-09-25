/** 主题雕塑创作会审使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload: Record<string, unknown>;
  /** 触发本事件的前序事件（如影响评估 -> 构件暂停）。 */
  causation_id: string | null;
  /** 幂等请求编号；同编号仅在内容一致时重放。 */
  request_id: string | null;
  /** 请求业务内容的规范化哈希。 */
  request_hash: string | null;
}

export type DomainEventType =
  | "CLAIM_SUBMITTED"
  | "CLAIM_REVISED"
  | "DESIGN_VERSION_PUBLISHED"
  | "DESIGN_SIGNED"
  | "MATERIAL_TESTED"
  | "COMPONENT_FABRICATED"
  | "COMPONENT_HELD"
  | "IMPACT_ASSESSED"
  | "COMPONENT_DISPOSITIONED"
  | "INSTALLATION_CLEARED"
  | "COMPONENT_INSTALLED"
  | "INSTALLATION_CORRECTED"
  | "LABEL_RELEASED"
  | "LABEL_CORRECTED";

export type AggregateType =
  | "historical_claim"
  | "design_version"
  | "fabrication_batch"
  | "installation_release"
  | "label"
  | "component";

/** 史实确定性等级。 */
export type Certainty = "confirmed" | "probable" | "disputed" | "refuted";

/** 主张允许被引用的范围。 */
export type CitationScope = "label" | "design_only" | "internal";

/** 设计中引用主张的性质：史实或艺术推断。 */
export type ClaimBasis = "fact" | "inference";

/** 三类签署角色，职责互不重叠。 */
export type SignerRole = "historian" | "art_committee" | "structural";

/** 设计会审闸门，按序推进。 */
export type Gate = "historical" | "artistic" | "structural" | "installation";

/** 构件生命周期状态。 */
export type ComponentStatus =
  | "designed"
  | "held"
  | "fabricated"
  | "dispositioned"
  | "installed"
  | "corrected";

/** 已制作构件的处置动作。 */
export type DispositionAction = "replace" | "keep" | "rework";

/** 证据变化后构件所处的处置分支。 */
export type ImpactBranch = "held" | "disposition_required" | "correction_required";

/** 待办事项；seq 决定中断恢复后的处理顺序。 */
export interface Todo {
  seq: number;
  kind:
    | "hold_unmade"
    | "disposition_required"
    | "post_installation_correction"
    | "label_correction"
    | "material_substitution"
    | "material_substitution_pending"
    | "await_fabrication";
  ref: string;
  reason: string;
  blocked_by: string[];
  status: "pending" | "done";
  created_event: string;
  done_event: string | null;
}
