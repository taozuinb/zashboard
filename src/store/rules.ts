import { ruleProviderList, rules } from '@/assembly/rules'
import { RULE_TAB_TYPE } from '@/constant'
import { applyRuleDrafts } from '@/helper/rule-draft'
import { toSearchRegex } from '@/helper/search'
import { computed, ref, watch } from 'vue'
import { activeRuleDrafts } from './rule-drafts'
import { activeBackend } from './setup'

export const rulesFilter = ref('')
export const rulesTabShow = ref(RULE_TAB_TYPE.RULES)

watch(activeBackend, (backend) => {
  if (backend) rulesTabShow.value = RULE_TAB_TYPE.RULES
})

/** 内核规则叠加本地草稿后的完整列表，导出时用这个（不受搜索影响） */
export const draftedRules = computed(() => applyRuleDrafts(rules.value, activeRuleDrafts.value))

export const renderRules = computed(() => {
  const searchRegex = toSearchRegex(rulesFilter.value)

  if (!searchRegex) {
    return draftedRules.value
  }

  return draftedRules.value.filter((rule) => {
    return searchRegex.testAny([rule.type, rule.payload, rule.proxy])
  })
})

export const renderRulesProvider = computed(() => {
  const searchRegex = toSearchRegex(rulesFilter.value)

  if (!searchRegex) {
    return ruleProviderList.value
  }

  return ruleProviderList.value.filter((ruleProvider) => {
    return searchRegex.testAny([ruleProvider.name, ruleProvider.behavior, ruleProvider.vehicleType])
  })
})
