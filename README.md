# 主题雕塑创作会审

本仓库保存主题雕塑史实主张会审链服务的领域资料、事件实现与自动化测试，供业务团队在统一语义上继续建设。

## 要解决的问题

新档案可能只推翻主题雕塑中某个人物的服饰年代，而不影响整体场景：

- 制作方若把整版设计退回，会浪费已通过结构试验的构件；
- 若什么都不做，铭牌会继续引用错误史实。

因此系统在**史实主张、设计会审、材料试验、安装放行、铭牌发布**五类事件上建立可追溯的会审链：

- 每条主张绑定**证据版本、确定性等级、允许引用范围**；
- 设计版本明确**采用哪些史实（含版本）与哪些艺术推断**；
- **历史顾问只确认史实，艺术委员会决定是否接受推断，结构人员只对材料与安装安全签署**；
- 证据变化时**精确找出受影响构件**：未制作部分暂停，已制作部分形成处置方案，已安装内容通过后续更正保留原决定；
- 相邻设计版本可**继承**未变化结论，但签署职责不得互相代办，并发签署不得越过前序条件；
- 同编号请求只有内容一致才算重放；
- 从一个构件即可追到主张、证据、签署、材料批次和铭牌。

## 目录

- `contracts/domain.schema.json`：领域事件信封契约（事件类型/聚合类型枚举）。
- `data/sample.json`：可用于联调的中文样例记录。
- `src/events.js`：领域常量（事件、聚合、角色、确定性、引用范围、构件状态、待办类型）。
- `src/validator.js`：事件信封与各类事件 `payload` 的结构校验（业务前置条件在 service 层）。
- `src/store.js`：追加式事件存储——请求幂等（request_id + 内容指纹）、聚合乐观并发、可选 JSONL 持久化与恢复。
- `src/projections.js`：事件折叠成读模型；相邻设计版本的结论继承在此计算。
- `src/service.js`：会审命令与全部业务规则（职责分离、前序条件、修订影响分析、待办队列）。
- `src/trace.js`：构件 → 主张/证据/签署/材料批次/铭牌的追溯查询。
- `tests/`：契约测试与业务场景测试。

## 事件与聚合

| 事件 | 聚合 | 说明 |
| --- | --- | --- |
| `CLAIM_SUBMITTED` / `CLAIM_REVISED` | historical_claim | 主张登记/修订；修订保留全部历史版本，不改写原事件 |
| `DESIGN_VERSION_PROPOSED` | design_version | 提交设计版本，显式列出采用的主张版本与艺术推断 |
| `DESIGN_REVIEWED` | design_version | 会审签署：`facts_confirmed`（历史顾问）/ `inference_accepted|rejected`（艺术委员会）/ `referred_back` |
| `MATERIAL_TESTED` | fabrication_batch | 材料试验，结构人员签署；`replaces_batch` 表示结构替代 |
| `COMPONENT_STATUS_CHANGED` | component | planned → suspended → planned / fabricated → installed / scrapped |
| `COMPONENT_FABRICATED` | component | 制作完成，绑定材料批次 |
| `COMPONENT_DISPOSITION_RECORDED` | component | 已制作构件处置：rework / substitute_material / keep_with_annotation / scrap |
| `INSTALLATION_CLEARED` | installation_release | 安装放行（结构人员），引用通过会审的设计与试验/处置依据 |
| `LABEL_RELEASED` / `LABEL_CORRECTED` | plaque_label | 铭牌发布与更正；原发布保留，更正为后继事件 |
| `WORK_ITEM_RAISED` / `WORK_ITEM_COMPLETED` | work_item | 证据变化自动产生的待办（解除暂停/落实处置/出具更正） |

## 关键规则

1. **证据驱动的精确影响分析**：修订主张时，按“采用该主张的最新设计版本”反查构件——`planned` 暂停，`fabricated` 登记处置，`installed` 不动构件、对引用旧版本的铭牌产生更正待办；不受影响的构件与设计版本照常推进。
2. **职责不可代办**：历史顾问的签署只能是史实确认；艺术委员会只能决定推断；结构人员只出现在材料试验与安装放行。同一签署人不得在同一设计版本跨角色签署。
3. **前序条件**：材料试验要求所属设计已完成两类签署；制作要求批次最近一次试验通过；安装放行要求构件已制作且当前批次试验通过；铭牌只能引用主张当前版本且该版本允许 `label` 引用。
4. **版本继承**：新设计版本通过 `predecessor_event` 指向前序版本；主张编号+版本未变则继承史实确认，推断编号+依据+理由未变则继承接受结论。被退回（referred_back）的版本不可继承。
5. **并发与幂等**：命令可带 `expected_version` 做乐观并发；`request_id` 相同且事件内容指纹一致才返回首次结果（重放），内容不一致报冲突。
6. **中断恢复**：以 JSONL 持久化的存储按写入顺序重放；待办顺序由事件顺序与序号决定，恢复后不变。

## 本地检查

```bash
npm test     # node --test，全部场景测试
npm run build # 对 src 下全部模块做语法检查
```

不需要另行启动外部基础设施；持久化测试使用临时 JSONL 文件。
