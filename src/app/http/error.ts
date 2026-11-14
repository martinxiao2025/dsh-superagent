/**
 * 表示管理路由解析或查找期间抛出的面向客户端的 400 或 404 错误。
 * 当请求体格式错误或目标记录缺失时，路由处理器会抛出它，registerHttp 会在 HTTP 响应中序列化其状态码和消息。
 * 独立成叶子模块，避免 routes ↔ server 的模块环。
 */
export class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
