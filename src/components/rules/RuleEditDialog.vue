<template>
  <DialogWrapper
    v-model="open"
    :title="mode === 'add' ? $t('addRule') : $t('editRule')"
    box-class="max-w-120"
  >
    <form
      data-rule-editor
      class="flex flex-col gap-3 text-sm"
      @submit.prevent="submit"
    >
      <label class="flex flex-col gap-1">
        <span class="text-base-content/60 text-xs">{{ $t('type') }}</span>
        <TextInput
          v-model="form.type"
          name="rule-type"
          :menus="RULE_TYPE_SUGGESTIONS"
          :placeholder="$t('ruleTypePlaceholder')"
          :clearable="true"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-base-content/60 text-xs">
          {{ $t('content') }}
          <span
            v-if="!payloadRequired"
            class="text-base-content/40"
          >
            ({{ $t('rulePayloadOptional') }})
          </span>
        </span>
        <TextInput
          v-model="form.payload"
          name="rule-payload"
          :disabled="!payloadRequired"
          :placeholder="$t('rulePayloadPlaceholder')"
          :clearable="true"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-base-content/60 text-xs">{{ $t('ruleTarget') }}</span>
        <TextInput
          v-model="form.proxy"
          name="rule-proxy"
          :menus="targetOptions"
          :placeholder="$t('ruleTargetPlaceholder')"
          :clearable="true"
        />
      </label>

      <label
        v-if="mode === 'add'"
        class="flex flex-col gap-1"
      >
        <span class="text-base-content/60 text-xs">
          {{ $t('rulePosition') }}
          <span class="text-base-content/40"
            >({{ ruleCount + 1 }} = {{ $t('rulePositionEnd') }})</span
          >
        </span>
        <input
          v-model.number="form.position"
          type="number"
          name="rule-position"
          class="input input-sm w-32"
          min="1"
          :max="ruleCount + 1"
        />
      </label>

      <div
        v-if="errorKey"
        class="text-error text-xs"
      >
        {{ $t(errorKey) }}
      </div>

      <div class="text-base-content/50 text-xs">
        {{ $t('ruleDraftDialogHint') }}
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <button
          type="button"
          class="btn btn-sm"
          @click="open = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="submit"
          class="btn btn-sm btn-primary"
          data-rule-save
          :disabled="!!errorKey"
        >
          {{ $t('save') }}
        </button>
      </div>
    </form>
  </DialogWrapper>
</template>

<script setup lang="ts">
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import TextInput from '@/components/common/TextInput.vue'
import { proxyGroupList, proxyMap } from '@/assembly/proxies'
import {
  RULE_TYPE_SUGGESTIONS,
  ruleNeedsPayload,
  toConfigRuleType,
  type DraftedRule,
} from '@/helper/rule-draft'
import { computed, reactive, watch } from 'vue'

const POLICY_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']

const props = defineProps<{
  mode: 'add' | 'update'
  ruleCount: number
  rule?: DraftedRule | null
}>()

const open = defineModel<boolean>({ required: true })

const emit = defineEmits<{
  (e: 'submit', value: { type: string; payload: string; proxy: string; position: number }): void
}>()

const form = reactive({
  type: '',
  payload: '',
  proxy: '',
  position: 1,
})

const payloadRequired = computed(() => ruleNeedsPayload(form.type))

const targetOptions = computed(() => {
  const groups = proxyGroupList.value
  const nodes = Object.keys(proxyMap.value).filter((name) => !groups.includes(name))

  return [...POLICY_TARGETS, ...groups, ...nodes]
})

watch(
  () => [open.value, props.mode, props.rule] as const,
  ([isOpen]) => {
    if (!isOpen) return

    form.type = toConfigRuleType(props.rule?.type ?? '')
    form.payload = props.rule?.payload ?? ''
    form.proxy = props.rule?.proxy ?? ''
    form.position = props.mode === 'add' ? props.ruleCount + 1 : 1
  },
  { immediate: true },
)

const errorKey = computed(() => {
  if (!form.type.trim()) return 'ruleTypeRequired'
  if (payloadRequired.value && !form.payload.trim()) return 'rulePayloadRequired'
  if (!form.proxy.trim()) return 'ruleTargetRequired'

  if (props.mode === 'add') {
    if (!Number.isFinite(form.position) || form.position < 1) return 'rulePositionRequired'
  }

  return ''
})

const submit = () => {
  if (errorKey.value) return

  emit('submit', {
    type: toConfigRuleType(form.type),
    payload: payloadRequired.value ? form.payload.trim() : '',
    proxy: form.proxy.trim(),
    position: Math.min(Math.max(Math.round(form.position), 1), props.ruleCount + 1),
  })
  open.value = false
}

// 类型切换成 MATCH 时清掉内容，避免导出成 MATCH,x,DIRECT
watch(payloadRequired, (required) => {
  if (!required) form.payload = ''
})
</script>
