/** 前置条件或职责校验失败（业务规则拒绝）。 */
export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = "DomainError";
  }
}

/** 同编号请求的内容与已接收记录不一致，不构成重放。 */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

/** 聚合版本与调用方期望不一致（并发修改）。 */
export class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
