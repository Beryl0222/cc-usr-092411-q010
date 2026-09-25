/** 主题雕塑创作会审使用的领域事件信封。 */
export interface DomainEvent {
  /** 事件标识；由请求编号派生（`<request_id>#<序号>`），同一命令内事件可互相引用。 */
  event_id: string;
  event_type:
    | "CLAIM_SUBMITTED"
    | "CLAIM_REVISED"
    | "DESIGN_VERSION_PROPOSED"
    | "DESIGN_REVIEWED"
    | "MATERIAL_TESTED"
    | "COMPONENT_STATUS_CHANGED"
    | "COMPONENT_FABRICATED"
    | "COMPONENT_DISPOSITION_RECORDED"
    | "INSTALLATION_CLEARED"
    | "LABEL_RELEASED"
    | "LABEL_CORRECTED"
    | "WORK_ITEM_RAISED"
    | "WORK_ITEM_COMPLETED";
  aggregate_type:
    | "historical_claim"
    | "design_version"
    | "component"
    | "fabrication_batch"
    | "installation_release"
    | "plaque_label"
    | "work_item";
  aggregate_id: string;
  occurred_at: string;
  /** 聚合内单调递增版本，从 1 开始；并发写入按期望版本冲突拒绝。 */
  version: number;
  summary: string;
  /** 各事件类型的业务负载，形状由 src/validator.js 按 event_type 校验。 */
  payload: Record<string, unknown>;
}

/** 主张确定性等级：确证 / 旁证 / 推断 / 存疑。 */
export type CertaintyLevel = "confirmed" | "probable" | "inferred" | "disputed";

/** 允许引用范围：设计参考 / 铭牌引用 / 对外发布。 */
export type CitationScope = "design" | "label" | "publication";

/** 会审角色：历史顾问只确认史实，艺术委员会决定推断，结构人员只管材料与安装安全。 */
export type ReviewRole = "historian" | "art_committee" | "structural_engineer" | "designer" | "fabricator" | "curator" | "planner";
