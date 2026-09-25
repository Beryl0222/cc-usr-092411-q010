/**
 * 会审链领域常量：事件类型、聚合类型、确定性等级、引用范围、签署角色、闸门、构件状态。
 */

export const EventType = Object.freeze({
  CLAIM_SUBMITTED: "CLAIM_SUBMITTED",
  CLAIM_REVISED: "CLAIM_REVISED",
  DESIGN_VERSION_PUBLISHED: "DESIGN_VERSION_PUBLISHED",
  DESIGN_SIGNED: "DESIGN_SIGNED",
  MATERIAL_TESTED: "MATERIAL_TESTED",
  INSTALLATION_CLEARED: "INSTALLATION_CLEARED",
  COMPONENT_FABRICATED: "COMPONENT_FABRICATED",
  COMPONENT_INSTALLED: "COMPONENT_INSTALLED",
  LABEL_RELEASED: "LABEL_RELEASED",
  IMPACT_ASSESSED: "IMPACT_ASSESSED",
  COMPONENT_HELD: "COMPONENT_HELD",
  COMPONENT_DISPOSITIONED: "COMPONENT_DISPOSITIONED",
  INSTALLATION_CORRECTED: "INSTALLATION_CORRECTED",
  LABEL_CORRECTED: "LABEL_CORRECTED",
});

export const AggregateType = Object.freeze({
  HISTORICAL_CLAIM: "historical_claim",
  DESIGN_VERSION: "design_version",
  FABRICATION_BATCH: "fabrication_batch",
  INSTALLATION_RELEASE: "installation_release",
  LABEL: "label",
  COMPONENT: "component",
});

/** 史实确定性等级：只允许沿等级收紧或在新证据下重评。 */
export const Certainty = Object.freeze({
  CONFIRMED: "confirmed", // 确凿：可进入铭牌
  PROBABLE: "probable", // 较可信：可用于设计，不进入铭牌
  DISPUTED: "disputed", // 存疑：仅限内部研究
  REFUTED: "refuted", // 被新档案推翻
});

/** 主张允许被引用的范围。 */
export const CitationScope = Object.freeze({
  LABEL: "label", // 可用于铭牌（隐含也可用于设计）
  DESIGN_ONLY: "design_only", // 仅可用于设计
  INTERNAL: "internal", // 仅供内部研究，不得对外引用
});

/** 三类签署角色，职责互不重叠、不得代办。 */
export const SignerRole = Object.freeze({
  HISTORIAN: "historian", // 历史顾问：只确认史实
  ART_COMMITTEE: "art_committee", // 艺术委员会：只决定是否接受艺术推断
  STRUCTURAL: "structural", // 结构人员：只对材料与安装安全签署
});

/** 设计会审闸门，按顺序推进；并发签署不得越过前序条件。 */
export const Gate = Object.freeze({
  HISTORICAL: "historical",
  ARTISTIC: "artistic",
  STRUCTURAL: "structural",
  INSTALLATION: "installation",
});

export const GATE_ORDER = Object.freeze([Gate.HISTORICAL, Gate.ARTISTIC, Gate.STRUCTURAL, Gate.INSTALLATION]);

/** 构件生命周期状态。 */
export const ComponentStatus = Object.freeze({
  DESIGNED: "designed", // 已设计，未制作
  HELD: "held", // 未制作部分：证据变化后暂停
  FABRICATED: "fabricated", // 已制作，未安装
  DISPOSITIONED: "dispositioned", // 已制作部分：已形成处置方案（替换/留用/改造）
  INSTALLED: "installed", // 已安装
  CORRECTED: "corrected", // 已安装内容：经后续更正，原决定保留可溯
});

/** 已制作构件的处置动作。 */
export const Disposition = Object.freeze({
  REPLACE: "replace",
  KEEP: "keep",
  REWORK: "rework",
});
