<template>
  <div
    :class="[
      'download-speed-tag bg-base-100 h-5 min-w-10 rounded-xl px-1.5 text-xs select-none md:hover:shadow-sm',
      color,
    ]"
    :data-speedtest-group="groupName"
    @mouseenter="handlerTip"
  >
    <Transition name="download-speed-state">
      <span
        v-if="testing"
        class="download-speed-state loading loading-dots loading-xs text-base-content/80"
      ></span>
      <div
        v-else-if="bps > 0"
        class="download-speed-state tabular-nums"
      >
        {{ prettyBytesHelper(bps) }}/s
      </div>
      <ArrowDownTrayIcon
        v-else
        class="download-speed-state text-base-content h-3 w-3"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import {
  downloadSpeedMap,
  downloadSpeedTestState,
  getDownloadSpeedByName,
  isServerSpeedTestConfigured,
} from '@/assembly/proxies'
import { getColorForSpeed } from '@/helper'
import { useTooltip } from '@/composables/use-tooltip'
import { fromNow, prettyBytesHelper } from '@/helper/utils'
import { ArrowDownTrayIcon } from '@heroicons/vue/24/outline'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  name?: string
  groupName?: string
}>()

const { t } = useI18n()
const { showTip } = useTooltip()

const state = computed(() => downloadSpeedTestState.value)
const testing = computed(() => {
  const current = state.value

  if (!current) return false

  return (
    current.groupName === props.groupName &&
    (current.phase === 'testing' || current.phase === 'selecting')
  )
})

const bps = computed(() => getDownloadSpeedByName(props.name))
const record = computed(() => (props.name ? downloadSpeedMap.value[props.name] : undefined))

const color = computed(() => getColorForSpeed(bps.value))

const handlerTip = (e: Event) => {
  const current = state.value

  if (testing.value && current) {
    showTip(e, `${current.done}/${current.total}`, {
      delay: [300, 0],
      trigger: 'mouseenter',
    })
    return
  }

  if (record.value) {
    showTip(
      e,
      t('downloadSpeedtestResultTip', {
        speed: `${prettyBytesHelper(record.value.bps)}/s`,
        time: fromNow(record.value.time),
      }),
      {
        delay: [300, 0],
        trigger: 'mouseenter',
      },
    )
    return
  }

  // 服务端模式已配置时补一句说明,让用户知道测速请求会走外部服务
  const idleTip = isServerSpeedTestConfigured.value
    ? `${t('downloadSpeedtestTip')}\n${t('downloadSpeedtestServerModeTip')}`
    : t('downloadSpeedtestTip')

  showTip(e, idleTip, {
    delay: [300, 0],
    trigger: 'mouseenter',
  })
}
</script>

<style scoped>
.download-speed-tag {
  display: grid;
  place-items: center;
  transition:
    color 0.35s ease-out,
    background-color 0.35s ease-out;
}

.download-speed-state {
  grid-area: 1 / 1;
}

.download-speed-state-enter-active,
.download-speed-state-leave-active {
  transition:
    opacity 0.2s ease-out,
    scale 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.download-speed-state-enter-from,
.download-speed-state-leave-to {
  opacity: 0;
  scale: 0.6;
}

.download-speed-state-leave-active {
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .download-speed-tag,
  .download-speed-state-enter-active,
  .download-speed-state-leave-active {
    transition: none;
  }
}
</style>
