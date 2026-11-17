<template>
  <div
    v-if="showBar"
    data-rule-drafts
    :data-draft-count="ruleDraftCount"
    class="border-base-border bg-base-100/60 flex flex-col gap-2 rounded-lg border p-2.5"
  >
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="badge badge-sm badge-warning shrink-0 font-normal">
        {{ $t('ruleDraftCount', { count: ruleDraftCount }) }}
      </span>
      <span class="text-base-content/60 line-clamp-2 min-w-0 flex-1 md:line-clamp-none">
        {{ $t('ruleDraftHint') }}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="btn btn-xs btn-primary gap-1"
          data-rule-draft="add"
          @click="editor?.create()"
        >
          <PlusIcon class="h-3.5 w-3.5" />
          {{ $t('addRule') }}
        </button>
        <button
          class="btn btn-xs gap-1"
          data-rule-draft="export"
          :disabled="!ruleDraftCount"
          @click="openPreview"
        >
          <ClipboardDocumentIcon class="h-3.5 w-3.5" />
          {{ $t('copyRuleYaml') }}
        </button>
        <button
          class="btn btn-xs btn-ghost gap-1"
          data-rule-draft="reset"
          :disabled="!ruleDraftCount"
          @click="reset"
        >
          <ArrowUturnLeftIcon class="h-3.5 w-3.5" />
          {{ $t('resetRuleDraft') }}
        </button>
        <button
          class="btn btn-xs btn-ghost"
          @click="ruleEditMode = false"
        >
          {{ $t('done') }}
        </button>
      </div>
    </div>

    <div
      v-if="activeRuleDrafts.length"
      class="flex flex-wrap gap-1"
    >
      <span
        v-for="change in activeRuleDrafts"
        :key="change.id"
        :data-draft-kind="change.kind"
        class="badge badge-sm badge-ghost bg-base-100 max-w-full gap-1 font-normal"
      >
        <span class="text-base-content/50 shrink-0">{{ $t(kindLabel[change.kind]) }}</span>
        <span class="truncate">{{ describeRuleDraft(change) }}</span>
        <button
          class="btn btn-circle btn-ghost h-4 min-h-4 w-4 shrink-0 p-0"
          :aria-label="$t('restoreRule')"
          :title="$t('restoreRule')"
          @click="removeRuleDraft(change.id)"
        >
          <XMarkIcon class="h-3 w-3" />
        </button>
      </span>
    </div>

    <DialogWrapper
      v-model="previewOpen"
      :title="$t('ruleYamlPreview')"
      box-class="max-w-140"
    >
      <div class="flex flex-col gap-2">
        <div class="text-base-content/60 text-xs">
          {{ $t('ruleYamlHint') }}
        </div>
        <textarea
          ref="yamlRef"
          class="textarea textarea-sm bg-base-200 h-[50dvh] w-full font-mono text-xs"
          readonly
          :value="yaml"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
        <div class="flex justify-end gap-2">
          <button
            class="btn btn-sm"
            @click="previewOpen = false"
          >
            {{ $t('close') }}
          </button>
          <button
            class="btn btn-sm btn-primary gap-1"
            @click="copyYaml"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
            {{ $t('copy') }}
          </button>
        </div>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { useRuleEditor } from '@/composables/use-rule-editor'
import { describeRuleDraft, serializeRulesToYaml, type RuleDraftKind } from '@/helper/rule-draft'
import { showConfirmDialog } from '@/helper/confirm-dialog'
import { showNotification } from '@/helper/notification'
import {
  activeRuleDrafts,
  removeRuleDraft,
  resetRuleDrafts,
  ruleDraftCount,
  ruleEditMode,
} from '@/store/rule-drafts'
import { RULE_TAB_TYPE } from '@/constant'
import { draftedRules, rulesTabShow } from '@/store/rules'
import {
  ArrowUturnLeftIcon,
  ClipboardDocumentIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const editor = useRuleEditor()
const previewOpen = ref(false)
const yamlRef = ref<HTMLTextAreaElement>()

const showBar = computed(() => ruleEditMode.value && rulesTabShow.value === RULE_TAB_TYPE.RULES)

const kindLabel: Record<RuleDraftKind, string> = {
  add: 'ruleDraftAdded',
  update: 'ruleDraftModified',
  delete: 'ruleDraftDeleted',
}

const yaml = computed(() => serializeRulesToYaml(draftedRules.value))

const openPreview = () => {
  previewOpen.value = true
}

const copyYaml = async () => {
  try {
    await navigator.clipboard.writeText(yaml.value)
    showNotification({ content: 'copySuccess', type: 'alert-success' })
  } catch {
    yamlRef.value?.focus()
    showNotification({ content: 'copyFailed', type: 'alert-warning' })
  }
}

const reset = async () => {
  const { confirmed } = await showConfirmDialog({
    title: t('resetRuleDraft'),
    message: t('resetRuleDraftConfirm'),
    confirmText: t('confirm'),
    cancelText: t('cancel'),
    confirmButtonClass: 'btn-error',
  })

  if (confirmed) resetRuleDrafts()
}
</script>
