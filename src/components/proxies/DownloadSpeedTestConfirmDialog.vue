<template>
  <DialogWrapper
    v-model="open"
    :title="$t('downloadSpeedtestServerConfirmTitle')"
    box-class="max-w-lg"
    @enter="handlerStart"
  >
    <div
      v-if="pendingServerDownloadTestGroup"
      class="download-speedtest-confirm-dialog flex max-h-[65dvh] min-h-0 flex-col gap-4 p-2 max-md:max-h-[50dvh]"
    >
      <div class="min-h-0 overflow-y-auto overscroll-contain pr-1">
        <p class="text-sm break-all whitespace-pre-wrap">
          {{
            $t('downloadSpeedtestServerConfirmMessage', {
              group: pendingServerDownloadTestGroup,
            })
          }}
        </p>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          class="download-speedtest-confirm-cancel btn btn-sm"
          @click="handlerCancel"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="download-speedtest-confirm-start btn btn-primary btn-sm"
          :disabled="starting"
          @click="handlerStart"
        >
          <span
            v-if="starting"
            class="loading loading-spinner loading-xs"
          ></span>
          {{ $t('downloadSpeedtestServerConfirmStart') }}
        </button>
      </div>
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import {
  dismissPendingServerDownloadTest,
  pendingServerDownloadTestGroup,
  startPendingServerDownloadTest,
} from '@/assembly/proxies'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { computed, ref } from 'vue'

const starting = ref(false)

// 弹窗的开关状态由 assembly 的 pending 分组驱动,关闭即视为取消
const open = computed({
  get: () => Boolean(pendingServerDownloadTestGroup.value),
  set: (value: boolean) => {
    if (!value) dismissPendingServerDownloadTest()
  },
})

const handlerCancel = () => {
  dismissPendingServerDownloadTest()
}

const handlerStart = async () => {
  if (starting.value) return

  starting.value = true
  try {
    await startPendingServerDownloadTest()
  } finally {
    starting.value = false
  }
}
</script>
