/** 实例地址的站点主机名推导；零依赖叶子，供 deployment、infra 与 code-repos 共用。 */

/** 实例地址的站点主机名；留空时使用 `fallback`。 */
export const hostOf = (instanceUrl: string, fallback: string): string => instanceUrl ? new URL(instanceUrl).host : fallback
