import { DomainError } from "./errors.js";
import { designSignoffGaps, effectiveCitedClaims } from "./projections.js";

/**
 * 追溯查询：从一个构件追到主张、证据、签署、材料批次和铭牌。
 * 返回普通对象，可直接序列化。
 */
export function traceComponent(state, componentCode) {
  const comp = state.components.get(componentCode);
  if (!comp) throw new DomainError(`构件 ${componentCode} 不存在`);

  // 主张与证据：构件各设计版本采用过的主张（按 主张@版本 去重）
  const claims = [];
  const seenClaims = new Set();
  for (const designId of comp.designs) {
    const design = state.designs.get(designId);
    for (const [claimId, version] of design.basedOn) {
      const key = `${claimId}@${version}`;
      if (seenClaims.has(key)) continue;
      seenClaims.add(key);
      const claim = state.claims.get(claimId);
      const content = claim.versions.get(version);
      claims.push({
        claim_id: claimId,
        claim_version: version,
        current_version: claim.currentVersion,
        statement: content.statement,
        evidence_id: content.evidence_id,
        evidence_version: content.evidence_version,
        certainty: content.certainty,
        allowed_citation: content.allowed_citation,
        adopted_by: designId,
        claim_event_id: content.eventId,
      });
    }
  }

  // 签署：设计会审（史实确认/推断决定）与结构签署（材料试验、安装放行）
  const designReviews = [];
  for (const designId of comp.designs) {
    const design = state.designs.get(designId);
    for (const [claimId, conf] of design.factConfirmations) {
      designReviews.push({ design_id: designId, scope: "facts", ref: claimId, decision: "facts_confirmed", ...conf });
    }
    for (const [infId, dec] of design.inferenceDecisions) {
      designReviews.push({ design_id: designId, scope: "inferences", ref: infId, ...dec });
    }
  }

  const batches = [...state.batches.values()]
    .filter((batch) => batch.component_code === componentCode)
    .map((batch) => ({
      batch_id: batch.id,
      tests: batch.tests.map((test) => ({ ...test })),
    }));

  const installation = state.installations.get(componentCode) ?? null;

  const labels = [...state.labels.values()]
    .filter((label) => label.component_code === componentCode)
    .map((label) => ({
      label_id: label.id,
      release: { ...label.release },
      corrections: label.corrections.map((c) => ({ ...c })),
      effective_cited_claims: effectiveCitedClaims(label),
    }));

  return {
    component_code: componentCode,
    status: comp.status,
    design_versions: comp.designs.map((designId) => {
      const gaps = designSignoffGaps(state, designId);
      return {
        design_id: designId,
        event_id: state.designs.get(designId).eventId,
        fully_signed:
          !gaps.referredBack && gaps.missingFacts.length === 0 && gaps.missingInferences.length === 0,
      };
    }),
    claims,
    design_reviews: designReviews,
    material_batches: batches,
    fabrications: comp.fabrications.map((f) => ({ ...f })),
    dispositions: comp.dispositions.map((d) => ({ ...d })),
    status_history: comp.statusHistory.map((h) => ({ ...h })),
    installation: installation ? { ...installation } : null,
    labels,
  };
}
