/**
 * 主题雕塑创作会审的领域常量约定。
 * contracts/domain.schema.json 中的枚举必须与此处保持一致（由契约测试守护）。
 */

/** 领域事件类型。 */
export const EVENT_TYPES = Object.freeze([
  "CLAIM_SUBMITTED", // 史实主张登记
  "CLAIM_REVISED", // 史实主张修订（证据变化触发）
  "DESIGN_VERSION_PROPOSED", // 设计版本提交
  "DESIGN_REVIEWED", // 设计会审签署（史实确认 / 推断接受）
  "MATERIAL_TESTED", // 材料批次试验
  "COMPONENT_STATUS_CHANGED", // 构件状态变更（登记/暂停/恢复/报废）
  "COMPONENT_FABRICATED", // 构件制作完成
  "COMPONENT_DISPOSITION_RECORDED", // 已制作构件处置方案
  "INSTALLATION_CLEARED", // 安装放行
  "LABEL_RELEASED", // 铭牌发布
  "LABEL_CORRECTED", // 铭牌更正（原发布保留）
  "WORK_ITEM_RAISED", // 待办产生
  "WORK_ITEM_COMPLETED", // 待办办结
]);

/** 聚合类型。 */
export const AGGREGATE_TYPES = Object.freeze([
  "historical_claim",
  "design_version",
  "component",
  "fabrication_batch",
  "installation_release",
  "plaque_label",
  "work_item",
]);

/** 事件类型到聚合类型的归属。 */
export const EVENT_AGGREGATE = Object.freeze({
  CLAIM_SUBMITTED: "historical_claim",
  CLAIM_REVISED: "historical_claim",
  DESIGN_VERSION_PROPOSED: "design_version",
  DESIGN_REVIEWED: "design_version",
  MATERIAL_TESTED: "fabrication_batch",
  COMPONENT_STATUS_CHANGED: "component",
  COMPONENT_FABRICATED: "component",
  COMPONENT_DISPOSITION_RECORDED: "component",
  INSTALLATION_CLEARED: "installation_release",
  LABEL_RELEASED: "plaque_label",
  LABEL_CORRECTED: "plaque_label",
  WORK_ITEM_RAISED: "work_item",
  WORK_ITEM_COMPLETED: "work_item",
});

/**
 * 会审角色。签署职责按角色划分，不得互相代办：
 * 历史顾问只确认史实，艺术委员会决定是否接受推断，结构人员只对材料与安装安全签署。
 */
export const ROLES = Object.freeze({
  HISTORIAN: "historian", // 历史顾问：登记/修订主张，确认设计采用的史实
  ART_COMMITTEE: "art_committee", // 艺术委员会：决定是否接受艺术推断
  STRUCTURAL_ENGINEER: "structural_engineer", // 结构人员：材料试验与安装放行签署
  DESIGNER: "designer", // 设计负责：提交设计版本
  FABRICATOR: "fabricator", // 制作方：按放行结论制作构件
  CURATOR: "curator", // 策展方：发布与更正铭牌
  PLANNER: "planner", // 策划负责人：处置决策与暂停解除
});

/** 主张确定性等级：确证 / 旁证 / 推断 / 存疑。 */
export const CERTAINTY_LEVELS = Object.freeze(["confirmed", "probable", "inferred", "disputed"]);

/** 主张允许被引用的范围：设计参考 / 铭牌引用 / 对外发布。 */
export const CITATION_SCOPES = Object.freeze(["design", "label", "publication"]);

/** 构件状态。 */
export const COMPONENT_STATUSES = Object.freeze(["planned", "suspended", "fabricated", "installed", "scrapped"]);

/** 已制作构件的处置决定。 */
export const DISPOSITION_DECISIONS = Object.freeze([
  "pending", // 待定（影响分析时先登记）
  "rework", // 返工重做
  "substitute_material", // 以替代材料/结构重新制作
  "keep_with_annotation", // 保留并加注说明
  "scrap", // 报废
]);

/** 待办类型。 */
export const WORK_ITEM_KINDS = Object.freeze([
  "resolve_suspension", // 解除未制作构件的暂停
  "execute_disposition", // 落实已制作构件的处置方案
  "issue_label_correction", // 对已发布铭牌出具更正
]);
