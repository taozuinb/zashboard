const getLatencyFromUrlAPI = (url: string) => {
  return new Promise<number>((resolve) => {
    const startTime = performance.now()
    const img = document.createElement('img')
    img.src = url + '?_=' + new Date().getTime()
    img.style.display = 'none'
    img.onload = () => {
      const endTime = performance.now()
      img.remove()

      resolve(endTime - startTime)
    }
    img.onerror = () => {
      img.remove()

      resolve(0)
    }

    document.body.appendChild(img)
  })
}

export const getCloudflareLatencyAPI = () => {
  return getLatencyFromUrlAPI('https://www.cloudflare.com/favicon.ico')
}

export const getYouTubeLatencyAPI = () => {
  return getLatencyFromUrlAPI('https://yt3.ggpht.com/favicon.ico')
}

export const getGithubLatencyAPI = () => {
  return getLatencyFromUrlAPI('https://github.githubassets.com/favicon.ico')
}

export const getBaiduLatencyAPI = () => {
  return getLatencyFromUrlAPI('https://apps.bdimg.com/favicon.ico')
}

export type DownloadSpeedResult = {
  bps: number
  bytes: number
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

export type DownloadSpeedOptions = {
  timeout?: number
  maxDurationMs?: number
  signal?: AbortSignal
  onResponse?: () => void | Promise<void>
  onProgress?: (bytes: number) => void
}

/*
 * 下载测速只能在前端做:内核的延迟接口是 HEAD 请求,拿不到吞吐。
 * 这里用 fetch + ReadableStream 读取测速文件并计时,单位是 字节/秒。
 * onResponse 在读第一个字节之前 await,给调用方留出"保持连接、确认流量确实
 * 走了被测节点"的窗口(读之前连接保持打开,服务端会被流控挡住)。
 */
export const measureDownloadSpeedAPI = async (
  url: string,
  { timeout = 20000, maxDurationMs = 0, signal, onResponse, onProgress }: DownloadSpeedOptions = {},
): Promise<DownloadSpeedResult> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let bytes = 0
  let startedAt = 0

  signal?.addEventListener('abort', abort, { once: true })

  try {
    if (timeout > 0) timer = setTimeout(abort, timeout)

    const response = await fetch(url, {
      cache: 'no-store',
      mode: 'cors',
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`download speedtest failed: HTTP ${response.status}`)
    }

    if (!response.body) {
      throw new Error('download speedtest failed: empty body')
    }

    await onResponse?.()

    const reader = response.body.getReader()
    startedAt = performance.now()
    let truncated = false

    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done) break

        if (value?.byteLength) {
          bytes += value.byteLength
          onProgress?.(bytes)
        }

        // 只采样一段时间的吞吐:高速节点全量下载会白白吃掉大量流量
        if (maxDurationMs > 0 && performance.now() - startedAt >= maxDurationMs) {
          truncated = true
          break
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    const durationMs = Math.max(1, performance.now() - startedAt)

    return { bps: (bytes * 1000) / durationMs, bytes, durationMs, timedOut: false, truncated }
  } catch (e) {
    // 超时中断时保留已下载的部分,用它算速度;一个字节都没读到才算失败
    if (bytes > 0) {
      const durationMs = Math.max(1, performance.now() - startedAt)

      return {
        bps: (bytes * 1000) / durationMs,
        bytes,
        durationMs,
        timedOut: true,
        truncated: false,
      }
    }

    controller.abort()
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
