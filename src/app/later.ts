/**
 * `Later`：副作用处理器报告"当前无法运行，稍后重试"的信号错误。
 * 独立叶子模块，让 executor/* 不为这一个类反向依赖 `app/effects.ts` 及其 Store 依赖（评审 P1-9）。
 * Effects 在初始重试延迟后重新调度抛出它的行且不增加失败计数。
 */
export class Later extends Error {}
