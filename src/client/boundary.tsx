/** 面板渲染错误的兜底界面：错误边界把渲染异常隔离在面板内，给出可读的错误与重试入口，而不是宿主白屏（评审 U2）。 */
import { Component, type ReactNode } from 'react'
import type { T } from './text.ts'

interface State { error?: Error }

/** 捕获子树渲染错误的类组件：显示消息与重试入口，重试即清空错误并重新渲染子树。 */
export class Boundary extends Component<{ t: T; children: ReactNode }, State> {
  override state: State = {}
  static getDerivedStateFromError(error: Error): State { return { error } }
  override render() {
    if (!this.state.error) return this.props.children
    return <div role="alert" style={{ padding: 24, display: 'grid', gap: 12 }}>
      <p>{this.props.t('boundaryMessage')}</p>
      <pre style={{ whiteSpace: 'pre-wrap', color: '#b00' }}>{String(this.state.error.message ?? this.state.error)}</pre>
      <div><button type="button" onClick={() => this.setState({ error: undefined })}>{this.props.t('boundaryRetry')}</button></div>
    </div>
  }
}
