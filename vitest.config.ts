import { defineConfig } from 'vitest/config'
// 在 DSH 客户端包与测试之间共享同一个 React 实例。
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
