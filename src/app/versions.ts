/** 由编号快照和 Store KV 表中的当前修订指针支撑的带版本记录存储。 */
import type { Family, Key } from '../kv.ts'
import type { Store } from './store.ts'

/**
 * 在 `Store` 键值表中管理带版本记录的编号快照，并用指针键跟踪活动修订。
 * 每次保存都会写入新快照并原子地推进指针，保留完整历史而不重复活动记录。
 * 供 `Store` 用于设置历史，供 `Prompts` 用于带版本的提示词配置。
 */
export class Versions<V extends { revision: number }> {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly pointer: Key<number>,
    private readonly family: Family<V, [revision: number]>) {}
  /** 当前修订号，在首次保存之前为 `0`。 */
  revision(): number { return this.store.get(this.pointer) ?? 0 }
  /** 当前快照，在首次保存之前为 `undefined`。 */
  current(): V | undefined {
    const revision = this.store.get(this.pointer)
    return revision === undefined ? undefined : this.get(revision)
  }
  get(revision: number): V | undefined { return this.store.get(this.family(revision)) }
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      const version = make(this.revision() + 1)
      this.store.set(this.family(version.revision), version)
      this.store.set(this.pointer, version.revision)
      return version
    })
  }
  /** 存储快照但不推进当前修订指针（例如记录初始的内置基准）。 */
  keep(version: V): void { this.store.set(this.family(version.revision), version) }
  list(limit = Infinity): V[] {
    return this.store.keys(this.family).flatMap(name => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit)
  }
}
