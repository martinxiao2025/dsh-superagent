/**
 * 运行时设置 schema、评估校验和策略门禁评估的聚合出口。
 * 实现拆分为三层：`settings/schema.ts`（设置 schema 与类型）、`policy/assessment.ts`
 * （评估校验与 `AssessmentOutcome` 转换）、`policy/gate.ts`（门禁、重校验与策略影响）。
 * 谁可以发起工作，由各来源在其自身身份中配置；策略从不在来源之间映射同一个人。
 */
export { RuleIdSchema, RuleSchema, type Rule, RoleModelSchema, type RoleModel, AllowedSchema, AdmissionRowSchema,
  AdmissionTableSchema, SourcePolicySchema, type SourcePolicy, PolicyConfigSchema, EvalConfigSchema, ExecutorConfigSchema,
  SourceInstanceSchema, SettingsSchema, type Settings, type SettingsBlock, type SettingsSave, type SettingsOrigin }
  from './settings/schema.ts'
export { RuleMatchSchema, type RuleMatch, RuleAssessmentSchema, type RuleAssessment, AdmissionDirectionSchema,
  type AdmissionDirection, directionAllowed, type Assessment, assessmentOutcome } from './policy/assessment.ts'
export { POLICY_REVISION, policyVersion, allowedSender, listedBot, anyoneAllowed, policyEffects, settingsPolicy }
  from './policy/gate.ts'
