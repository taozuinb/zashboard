<template>
  <div
    v-if="isTrace"
    class="relative size-full overflow-x-hidden"
  >
    <RulesCtrl />
    <div
      class="p-3"
      :style="tracePadding"
    >
      <DaeRoutingPanel />
    </div>
  </div>
  <div
    v-else
    :class="
      isRuleTable
        ? 'relative flex size-full flex-col overflow-hidden'
        : 'relative size-full overflow-x-hidden'
    "
    :style="isRuleTable ? padding : undefined"
  >
    <template v-if="isRuleTable">
      <RulesCtrl />
      <RuleDraftBar class="mx-3 mt-3" />
      <RulesTable />
    </template>
    <template v-else-if="!isVirtualScroller">
      <RulesCtrl />
      <div
        class="p-3"
        :style="padding"
      >
        <RuleDraftBar class="mb-2" />
        <template v-if="rulesTabShow === RULE_TAB_TYPE.PROVIDER">
          <div class="flex flex-col gap-2">
            <div
              v-for="(ruleProvider, index) in renderRulesProvider"
              :key="ruleProvider.name"
              class="base-container"
            >
              <RuleProvider
                :ruleProvider="ruleProvider"
                :index="index + 1"
              />
            </div>
          </div>
        </template>
        <template v-else>
          <div class="flex flex-col gap-2">
            <div
              v-for="(rule, index) in renderRules"
              :key="ruleKey(rule, index)"
              class="base-container"
            >
              <RuleCard
                :rule="rule"
                :index="index + 1"
              />
            </div>
          </div>
        </template>
      </div>
    </template>
    <VirtualScroller
      v-else
      :data="renderRules"
      :size="44"
    >
      <template v-slot:before>
        <RulesCtrl />
        <div :style="beforePadding">
          <RuleDraftBar class="mx-3 mt-0 mb-2" />
        </div>
      </template>
      <template v-slot="{ item: rule, index }: { item: DraftedRule; index: number }">
        <RuleCard
          :key="ruleKey(rule, index)"
          :rule="rule"
          :index="index + 1"
        />
      </template>
    </VirtualScroller>

    <RuleEditDialog
      v-model="editorOpen"
      :mode="editorMode"
      :rule="editorRule"
      :rule-count="rules.length"
      @submit="saveRule"
    />
  </div>
</template>

<script setup lang="ts">
import { renderRules, renderRulesProvider, rulesTabShow } from '@/store/rules'
import VirtualScroller from '@/components/common/VirtualScroller.vue'
import RulesCtrl from '@/components/controls/RulesCtrl'
import RuleCard from '@/components/rules/RuleCard.vue'
import RuleDraftBar from '@/components/rules/RuleDraftBar.vue'
import RuleEditDialog from '@/components/rules/RuleEditDialog.vue'
import RuleProvider from '@/components/rules/RuleProvider.vue'
import DaeRoutingPanel from '@/components/dae/DaeRoutingPanel.vue'
import RulesTable from '@/components/rules/RulesTable.vue'
import { usePaddingForViews } from '@/composables/use-padding-for-views'
import { provideRuleEditor } from '@/composables/use-rule-editor'
import { LIST_DISPLAY_STYLE, RULE_TAB_TYPE } from '@/constant'
import { can } from '@/assembly/backend'
import { fetchRules, rules } from '@/assembly/rules'
import { ruleDisplayStyle } from '@/store/settings'
import { addRuleDraft, removeRuleDraft, updateRuleDraft } from '@/store/rule-drafts'
import { ruleSignature, type DraftedRule } from '@/helper/rule-draft'
import { computed, provide, ref } from 'vue'

fetchRules()

const expandedRule = ref<string | null>(null)
provide('expandedRule', expandedRule)

const isTrace = computed(() => rulesTabShow.value === RULE_TAB_TYPE.TRACE && can('routingTrace'))
const isRuleTable = computed(() => ruleDisplayStyle.value === LIST_DISPLAY_STYLE.TABLE)
const cardPadding = usePaddingForViews({
  offsetTop: 12,
  offsetBottom: 8,
})
const tablePadding = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})
const tracePadding = computed(() => cardPadding.padding.value)
const beforePadding = computed(() => ({ paddingTop: `${cardPadding.paddingTop.value}px` }))
const padding = computed(() =>
  isRuleTable.value ? tablePadding.padding.value : cardPadding.padding.value,
)
const isVirtualScroller = computed(() => {
  return rulesTabShow.value === RULE_TAB_TYPE.RULES && renderRules.value.length > 200
})

const ruleKey = (rule: DraftedRule, index: number) =>
  `${rule.draftId ?? rule.coreIndex ?? `draft-${index}`}-${rule.type}-${rule.payload}`

const editorOpen = ref(false)
const editorMode = ref<'add' | 'update'>('add')
const editorRule = ref<DraftedRule | null>(null)
const editingDraftId = ref<string | null>(null)

const openEditor = (mode: 'add' | 'update', rule: DraftedRule | null) => {
  editorMode.value = mode
  editorRule.value = rule
  editingDraftId.value = rule?.draftId ?? null
  editorOpen.value = true
}

const createDraft = (values: {
  type: string
  payload: string
  proxy: string
  position: number
}) => {
  addRuleDraft({
    kind: 'add',
    index: values.position - 1,
    type: values.type,
    payload: values.payload,
    proxy: values.proxy,
  })
}

const coreRuleOf = (rule: DraftedRule) =>
  typeof rule.coreIndex === 'number' ? rules.value[rule.coreIndex] : undefined

const updateDraft = (
  values: { type: string; payload: string; proxy: string },
  rule: DraftedRule,
) => {
  if (editingDraftId.value) {
    updateRuleDraft(editingDraftId.value, values)
    return
  }

  const coreRule = coreRuleOf(rule)

  addRuleDraft({
    kind: 'update',
    index: rule.coreIndex ?? 0,
    type: values.type,
    payload: values.payload,
    proxy: values.proxy,
    original: ruleSignature(coreRule ?? rule),
  })
}

const saveRule = (values: { type: string; payload: string; proxy: string; position: number }) => {
  if (editorMode.value === 'add') {
    createDraft(values)
  } else if (editorRule.value) {
    updateDraft(values, editorRule.value)
  }
}

const deleteRule = (rule: DraftedRule) => {
  if (rule.draftState === 'add') {
    if (rule.draftId) removeRuleDraft(rule.draftId)
    return
  }

  const coreRule = coreRuleOf(rule)

  if (!coreRule) return

  // 先撤掉可能存在的修改草稿，再记一条删除草稿，两者都以内核规则为基准
  if (rule.draftId) removeRuleDraft(rule.draftId)

  addRuleDraft({
    kind: 'delete',
    index: rule.coreIndex ?? 0,
    type: coreRule.type,
    payload: coreRule.payload,
    proxy: coreRule.proxy,
    original: ruleSignature(coreRule),
  })
}

provideRuleEditor({
  create: () => openEditor('add', null),
  edit: (rule) => openEditor('update', rule),
  remove: deleteRule,
})
</script>
