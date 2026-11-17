/*
 * The D3 requirement as a change of the config repository (ADR-0052, ADR-0054): "Purchase orders for high-risk
 * commodities need a valid supplier due-diligence statement before release." The same edit the modelling agent makes in
 * scripts/liquid/scenario-business.mjs, for the tutorial's path without a model. Only what is missing is added, so it
 * also applies to a repository where an earlier run left the attribute, the class or the action.
 */

export const DD_RULE = 'due_diligence_for_high_risk_material';
export const DD_TITLE = 'Due diligence before releasing high-risk commodities';
export const ddCheck = {
  subject: { class: 'PurchaseOrder', input: 'poId' },
  when: { path: 'sku.commodity_risk', equals: 'high' },
  require: { exists: { class: 'DueDiligenceStatement', where: { supplier: { path: 'supplier' }, sanctions_checked: { equals: true } } } },
  message: '{subject.id} needs a valid due-diligence statement of supplier {subject.supplier} before release: {subject.sku} is a high-risk commodity',
};

const NL = '\n';
const CHECK_YAML = [
  'checks:',
  `  ${DD_RULE}:`,
  '    description: Purchase orders for high-risk commodities need a valid supplier due-diligence statement before release (D3).',
  '    subject: { class: PurchaseOrder, input: poId }',
  '    when: { path: sku.commodity_risk, equals: high }',
  '    require: { exists: { class: DueDiligenceStatement, where: { supplier: { path: supplier }, sanctions_checked: { equals: true } } } }',
  `    message: "${ddCheck.message}"`,
  '',
].join(NL);

/** The next minor version (an additive change). */
export const bumpMinor = (v: string) => {
  const [a, b] = v.split('.').map(Number);
  return `${a}.${(b ?? 0) + 1}.0`;
};

export function buildDueDiligenceChange(f: { schema: string; actions: string; roles: string; version: string }): Array<{ path: string; content: string }> {
  const hasDds = /\n {2}DueDiligenceStatement:\n/.test(f.schema);
  let schema = f.schema.replace(/^version: .*$/m, `version: ${bumpMinor(f.version)}`);
  if (!/\n {6}commodity_risk:/.test(schema)) schema = schema.replace(/(\n {2}Material:\n(?:.*\n)*? {4}attributes:\n)/, `$1      commodity_risk: { range: CommodityRisk, description: Risk class of the commodity for supplier due diligence (D3) }${NL}`);
  if (!/\n {2}CommodityRisk:\n/.test(schema))
    schema = schema.replace(/\nenums:\n/, `${NL}enums:${NL}  CommodityRisk:${NL}    description: Risk class of a commodity for supplier due diligence (deforestation, conflict minerals, forced labour)${NL}    permissible_values:${NL}      low: {}${NL}      high: {}${NL}`);
  if (!hasDds)
    schema = schema.replace(
      /\nclasses:\n/,
      [
        '',
        'classes:',
        '  DueDiligenceStatement:',
        "    description: A supplier's due-diligence statement (sanctions screening, conflict minerals, labour standards), recorded by a buyer.",
        '    annotations: { criticality: business_critical, data_class: confidential, owner: head-of-logistics }',
        '    attributes:',
        '      id: { identifier: true, description: e.g. DDS-001 }',
        '      supplier: { range: Supplier, required: true, description: The supplier the statement is about }',
        '      statement: { required: true, description: What the supplier declares }',
        '      sanctions_checked: { range: boolean, description: The supplier was screened against the sanctions lists }',
        '      signed_by: { required: true, description: Name of the person who signs the statement }',
        '',
        '',
      ].join(NL),
    );

  let actions = f.actions.includes(`  ${DD_RULE}:`) ? f.actions : f.actions.replace(/\nevents:\n/, `\n${CHECK_YAML}\nevents:\n`);
  actions = actions.replace(/(\n {2}- name: release_purchase_order\n(?:.*\n)*? {4}preconditions: \[)([^\]]*)\]/, (_m, a: string, list: string) => (list.includes(DD_RULE) ? `${a}${list}]` : `${a}${list}, ${DD_RULE}]`));
  if (!actions.includes('name: MaterialRiskClassified'))
    actions = actions.replace(
      /(\n {2}- \{ name: PurchaseOrderReleased[^\n]*\n)/,
      `$1  - { name: MaterialRiskClassified, object_type: Material, description: The commodity risk of a material was set }${NL}${hasDds || actions.includes('name: DueDiligenceStatementSubmitted') ? '' : `  - { name: DueDiligenceStatementSubmitted, object_type: DueDiligenceStatement, description: A due-diligence statement of a supplier was recorded }${NL}`}`,
    );
  if (!actions.endsWith(NL)) actions += NL;
  if (!actions.includes('- name: set_commodity_risk'))
    actions += [
      '  - name: set_commodity_risk',
      '    target: Material',
      '    kind: update',
      '    description: WRITE. Set the commodity risk class of a material (high-risk materials need a supplier due-diligence statement before release).',
      '    input:',
      '      sku: { range: Material, required: true, description: Material SKU }',
      '      commodityRisk: { range: string, required: true, enum: [low, high], description: Risk class }',
      '    emits: [MaterialRiskClassified]',
      '',
    ].join(NL);
  if (!actions.includes('- name: submit_due_diligence_statement'))
    actions += [
      '  - name: submit_due_diligence_statement',
      '    target: DueDiligenceStatement',
      '    kind: create',
      "    description: WRITE. Record a supplier's due-diligence statement.",
      '    input:',
      '      supplierId: { range: Supplier, required: true, description: Supplier id }',
      '      statement: { range: string, required: true, description: What the supplier declares }',
      '      sanctionsChecked: { range: boolean, description: Screened against the sanctions lists }',
      '      signedBy: { range: string, required: true, description: Name of the person who signs }',
      '    emits: [DueDiligenceStatementSubmitted]',
      '',
    ].join(NL);

  const roles = JSON.parse(f.roles) as { roles: Record<string, { writes: string[] }> };
  const proc = roles.roles.procurement;
  if (proc) proc.writes = [...new Set([...proc.writes, 'set_commodity_risk', 'submit_due_diligence_statement'])];
  return [
    { path: 'ontology/sofa/schema.yaml', content: schema },
    { path: 'ontology/sofa/actions.yaml', content: actions },
    { path: 'policies/liquid/roles/data.json', content: JSON.stringify(roles, null, 2) + NL },
  ];
}
