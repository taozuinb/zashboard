import type { Rule } from '@/types'

export type RuleDraftKind = 'add' | 'update' | 'delete'

export type RuleSignature = {
  type: string
  payload: string
  proxy: string
}

export type RuleDraftChange = {
  id: string
  kind: RuleDraftKind
  /** add: 插入到内核规则第 index 条之前（等于规则数表示追加）；update/delete: 目标规则下标 */
  index: number
  type: string
  payload: string
  proxy: string
  /** update/delete 的原始规则，内核规则变化后靠它在列表里重新定位 */
  original?: RuleSignature
  createdAt: number
}

export type DraftedRule = Rule & {
  coreIndex?: number
  draftState?: 'add' | 'update'
  draftId?: string
}

/** mihomo 的 /rules 返回的是 DomainSuffix / GeoIP 这类名字，配置里要写 DOMAIN-SUFFIX，统一转过去 */
const RULE_TYPE_ALIASES: Record<string, string> = {
  domain: 'DOMAIN',
  domainsuffix: 'DOMAIN-SUFFIX',
  domainkeyword: 'DOMAIN-KEYWORD',
  domainregex: 'DOMAIN-REGEX',
  domainwildcard: 'DOMAIN-WILDCARD',
  geosite: 'GEOSITE',
  geoip: 'GEOIP',
  srcgeoip: 'SRC-GEOIP',
  ipasn: 'IP-ASN',
  srcipasn: 'SRC-IP-ASN',
  ipcidr: 'IP-CIDR',
  srcipcidr: 'SRC-IP-CIDR',
  ipsuffix: 'IP-SUFFIX',
  srcipsuffix: 'SRC-IP-SUFFIX',
  srcport: 'SRC-PORT',
  dstport: 'DST-PORT',
  inport: 'IN-PORT',
  inuser: 'IN-USER',
  inname: 'IN-NAME',
  intype: 'IN-TYPE',
  dscp: 'DSCP',
  uid: 'UID',
  network: 'NETWORK',
  processname: 'PROCESS-NAME',
  processpath: 'PROCESS-PATH',
  processnameregex: 'PROCESS-NAME-REGEX',
  processpathregex: 'PROCESS-PATH-REGEX',
  processnamewildcard: 'PROCESS-NAME-WILDCARD',
  processpathwildcard: 'PROCESS-PATH-WILDCARD',
  rematchname: 'REMATCH-NAME',
  ruleset: 'RULE-SET',
  subrules: 'SUB-RULE',
  match: 'MATCH',
  final: 'MATCH',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
}

export const toConfigRuleType = (type: string) => {
  const trimmed = type.trim()

  if (!trimmed) return ''

  const alias = RULE_TYPE_ALIASES[trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')]

  if (alias) return alias

  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toUpperCase()
    .replace(/-+/g, '-')
}

export const RULE_TYPE_SUGGESTIONS = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'GEOIP',
  'IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'SRC-PORT',
  'DST-PORT',
  'NETWORK',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'RULE-SET',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
  'MATCH',
]

const RULE_TYPES_WITHOUT_PAYLOAD = new Set(['MATCH'])

export const ruleNeedsPayload = (type: string) =>
  !RULE_TYPES_WITHOUT_PAYLOAD.has(toConfigRuleType(type))

export const ruleSignature = (rule: Rule): RuleSignature => ({
  type: rule.type,
  payload: rule.payload,
  proxy: rule.proxy,
})

const isSameRule = (rule: Rule | undefined, signature: RuleSignature | undefined) =>
  !!rule &&
  !!signature &&
  rule.type === signature.type &&
  rule.payload === signature.payload &&
  rule.proxy === signature.proxy

const locate = (core: Rule[], change: RuleDraftChange) => {
  if (!change.original) return -1

  if (isSameRule(core[change.index], change.original)) return change.index

  return core.findIndex((rule) => isSameRule(rule, change.original))
}

const toAddedRule = (change: RuleDraftChange): DraftedRule => ({
  type: change.type,
  payload: change.payload,
  proxy: change.proxy,
  size: -1,
  uuid: '',
  index: -1,
  disabled: false,
  draftState: 'add',
  draftId: change.id,
})

const toUpdatedRule = (rule: Rule, change: RuleDraftChange, coreIndex: number): DraftedRule => ({
  ...rule,
  type: change.type,
  payload: change.payload,
  proxy: change.proxy,
  coreIndex,
  draftState: 'update',
  draftId: change.id,
})

/**
 * 把本地草稿叠加到内核规则上：新增按锚点插入、修改替换字段、删除整条移除。
 * 找不到原规则（内核已经换了）的草稿会被忽略，不会误伤别的规则。
 */
export const applyRuleDrafts = (core: Rule[], changes: RuleDraftChange[]): DraftedRule[] => {
  const updates = new Map<number, RuleDraftChange>()
  const deletes = new Set<number>()
  const adds: RuleDraftChange[] = []

  for (const change of changes) {
    if (change.kind === 'add') {
      adds.push(change)
      continue
    }

    const index = locate(core, change)

    if (index < 0) continue

    if (change.kind === 'delete') deletes.add(index)
    else updates.set(index, change)
  }

  const sortedAdds = [...adds].sort((a, b) => a.index - b.index || a.createdAt - b.createdAt)
  const addsByIndex = new Map<number, RuleDraftChange[]>()

  for (const change of sortedAdds) {
    const bucket = addsByIndex.get(change.index) ?? []

    bucket.push(change)
    addsByIndex.set(change.index, bucket)
  }

  const rows: DraftedRule[] = []
  const pushAddsAt = (index: number) =>
    rows.push(...(addsByIndex.get(index) ?? []).map(toAddedRule))

  core.forEach((rule, index) => {
    pushAddsAt(index)

    if (deletes.has(index)) return

    const update = updates.get(index)

    rows.push(update ? toUpdatedRule(rule, update, index) : { ...rule, coreIndex: index })
  })

  // 锚点超过内核规则数的（内核规则变少了）统一追加到末尾，不至于凭空消失
  for (const index of addsByIndex.keys()) {
    if (index >= core.length) pushAddsAt(index)
  }

  return rows
}

export const formatRuleLine = (rule: Pick<Rule, 'type' | 'payload' | 'proxy'>) => {
  const type = toConfigRuleType(rule.type)

  return rule.payload ? `${type},${rule.payload},${rule.proxy}` : `${type},${rule.proxy}`
}

export const serializeRulesToYaml = (rows: Pick<Rule, 'type' | 'payload' | 'proxy'>[]) => {
  const lines = rows.map((rule) => `  - ${formatRuleLine(rule)}`)

  return lines.length ? ['rules:', ...lines].join('\n') : 'rules: []'
}

export const describeRuleDraft = (change: RuleDraftChange) =>
  formatRuleLine({ type: change.type, payload: change.payload, proxy: change.proxy })
