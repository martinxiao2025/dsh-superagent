/** 宿主 schema 与管理面板表单之间共享的校验界限。 */
export const LIMITS = {
  sourceName: 80,
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  projectIntervalMinutes: { min: 1, max: 1440 },
  projectMaxRetries: { min: 0, max: 10 },
  projectRetryBackoffSeconds: { min: 0, max: 3600 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
} as const
