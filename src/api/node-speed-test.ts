const normalizeBaseUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '')

export type NodeSpeedTestGroup = {
  id: string
  name: string
  kind: string
  candidate_count: number
  available: boolean
  reason?: string | null
}

export type NodeSpeedTestResult = {
  id?: string | null
  name: string
  status: 'success' | 'failed'
  bytes_received?: number | null
  elapsed?: number | null
  speed_bps?: number | null
  error?: string | null
}

export type NodeSpeedTestTask = {
  id: string
  status: string
  group: string
  total: number
  completed: number
  current_node?: string | null
  current_started_at?: number | null
  results: NodeSpeedTestResult[]
  top: NodeSpeedTestResult[]
  restoration: string
  error?: string | null
  candidate_total?: number
  latency_completed?: number
  selected_node?: string | null
  selected_result_id?: string | null
  selection_status?: string
  stop_reason?: string | null
}

export type NodeSpeedTestConnection = {
  id: string
  controller: string
  proxy: string
  groups: NodeSpeedTestGroup[]
}

export type NodeSpeedTestState = {
  connecting: boolean
  connection: NodeSpeedTestConnection | null
  task: NodeSpeedTestTask | null
  warnings: string[]
}

export type NodeSpeedTestConnectionInput = {
  controller: string
  proxy: string
  secret?: string
}

export type NodeSpeedTestTaskInput = {
  connection_id: string
  group: string
  route_confirmed: boolean
  url: string
  duration?: number
  max_bytes?: number
  timeout?: number
  auto_select?: boolean
}

export class NodeSpeedTestApiError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)

    this.name = 'NodeSpeedTestApiError'
    this.status = status
  }
}

const request = async <T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> => {
  let response: Response

  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      cache: 'no-store',
      ...init,
    })
  } catch {
    throw new NodeSpeedTestApiError('node_speed_test service is unreachable')
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`

    try {
      const body = (await response.json()) as { detail?: unknown }

      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // 非 JSON 错误体只用状态码,调用方按 status 分类提示
    }

    throw new NodeSpeedTestApiError(detail, response.status)
  }

  if (response.status === 204) return undefined as T

  try {
    return (await response.json()) as T
  } catch {
    throw new NodeSpeedTestApiError(
      'invalid response from node_speed_test service',
      response.status,
    )
  }
}

// GET 不带 content-type,避免每次轮询都触发一次跨域预检
export const fetchNodeSpeedTestStateAPI = (baseUrl: string) =>
  request<NodeSpeedTestState>(baseUrl, '/api/state')

export const connectNodeSpeedTestAPI = (baseUrl: string, input: NodeSpeedTestConnectionInput) =>
  request<NodeSpeedTestConnection>(baseUrl, '/api/connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

export const startNodeSpeedTestTaskAPI = (baseUrl: string, input: NodeSpeedTestTaskInput) =>
  request<NodeSpeedTestTask>(baseUrl, '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

export const stopNodeSpeedTestTaskAPI = (baseUrl: string, taskId: string) =>
  request<NodeSpeedTestTask>(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
