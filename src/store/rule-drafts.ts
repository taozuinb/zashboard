import { useStorage } from '@/composables/use-storage'
import type { RuleDraftChange } from '@/helper/rule-draft'
import { v4 as uuid } from 'uuid'
import { computed, ref } from 'vue'
import { activeUuid } from './setup'

export type RuleDraftMap = Record<string, RuleDraftChange[]>

export const ruleDrafts = useStorage<RuleDraftMap>('config/rule-drafts', {})

/** 编辑模式只影响交互，不落盘；退出编辑不会丢草稿 */
export const ruleEditMode = ref(false)

export const activeRuleDrafts = computed<RuleDraftChange[]>(() =>
  activeUuid.value ? (ruleDrafts.value[activeUuid.value] ?? []) : [],
)

export const ruleDraftCount = computed(() => activeRuleDrafts.value.length)

const write = (changes: RuleDraftChange[]) => {
  const backendUuid = activeUuid.value

  if (!backendUuid) return

  const next = { ...ruleDrafts.value }

  if (changes.length) {
    next[backendUuid] = changes
  } else {
    delete next[backendUuid]
  }

  ruleDrafts.value = next
}

export const addRuleDraft = (change: Omit<RuleDraftChange, 'id' | 'createdAt'>) => {
  const id = uuid()

  write([
    ...activeRuleDrafts.value,
    {
      ...change,
      id,
      createdAt: Date.now(),
    },
  ])

  return id
}

export const updateRuleDraft = (
  id: string,
  patch: Partial<Pick<RuleDraftChange, 'index' | 'type' | 'payload' | 'proxy'>>,
) => {
  write(
    activeRuleDrafts.value.map((change) => (change.id === id ? { ...change, ...patch } : change)),
  )
}

export const removeRuleDraft = (id: string) => {
  write(activeRuleDrafts.value.filter((change) => change.id !== id))
}

export const resetRuleDrafts = () => {
  write([])
}
