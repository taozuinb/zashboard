import type { DraftedRule } from '@/helper/rule-draft'
import { inject, provide, type InjectionKey } from 'vue'

export type RuleEditorApi = {
  create: (anchor?: number) => void
  edit: (rule: DraftedRule) => void
  remove: (rule: DraftedRule) => void
}

const ruleEditorKey: InjectionKey<RuleEditorApi> = Symbol('rule-editor')

export const provideRuleEditor = (api: RuleEditorApi) => provide(ruleEditorKey, api)

export const useRuleEditor = () => inject<RuleEditorApi | null>(ruleEditorKey, null)
