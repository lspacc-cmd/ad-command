/**
 * Meta leadgen delivery for /api/webhooks.
 *
 * Dedupe is by Meta leadgen id only. Two different lead ids that share a
 * phone or email are both delivered.
 *
 * This is not exactly-once. Resend keeps an Idempotency-Key for 24 hours
 * (https://resend.com/docs/dashboard/emails/idempotency-keys). The installed
 * SDK (resend 6.x) sends that key as the second-argument option, which sets
 * the Idempotency-Key header. A timeout can hide whether Resend accepted the
 * message; the retry uses the same key and the same body. After 24 hours a
 * retry whose database row never reached "sent" or "suppressed" can deliver
 * a second email. A 409 invalid_idempotent_request means this key was already
 * used with a different body, so the code does not mint a new key.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

export const DEALERSOCKET_ADF_TO = 'webleads@Larryspacc.dsmessage.com'
export const RECRUITING_NOTICE_TO = 'Lspacc@gmail.com'
export const ADF_FROM = 'leads@adcommand.one'
export const RECRUITING_FROM = 'AD COMMAND <leads@adcommand.one>'

export const CLAIM_LEASE_MS = 2 * 60 * 1000

export const RECRUITING_FORM_NAMES = ['Auto Tech Apply', 'Auto Tech Apply v2'] as const

const RECRUITING_FORM_NAME_SET = new Set<string>(RECRUITING_FORM_NAMES)

const GRAPH_VERSION = 'v25.0'
const LEADGEN_ID_PATTERN = /^[0-9]{1,32}$/
const MAIL_TIMEOUT_MS = 15_000

const SEGMENT_MAP: Record<string, { campaignName: string; aiSequence: string }> = {
  '120247062455170017': {
    campaignName: 'AD COMMAND - USED CAR FINANCE',
    aiSequence: 'Hi {name}, this is from Larry Spacc GMC. You came in asking about used car financing — what monthly payment range works best for you?',
  },
  '120246153519930017': {
    campaignName: 'AD COMMAND - SIERRA 1500',
    aiSequence: 'Hi {name}, thanks for reaching out about the Sierra 1500 savings offer. Are you looking to buy outright or would financing work better for you?',
  },
  '120245562943880017': {
    campaignName: 'AD COMMAND - SILVERADO 399',
    aiSequence: 'Hi {name}, you came in on our Silverado $399 driving sense ad. Are you flexible on trim or do you have a specific config in mind?',
  },
  '120244379927070017': {
    campaignName: 'AD COMMAND - SIERRA 1500',
    aiSequence: 'Hi {name}, thanks for your interest in the Sierra 1500. What are you using the truck for — work, family, or both?',
  },
  '120244373950770017': {
    campaignName: 'AD COMMAND - SIERRA HD',
    aiSequence: 'Hi {name}, you reached out about the Sierra HD. What are you hauling or towing? That helps me point you to the right build.',
  },
  '120246152950890017': {
    campaignName: 'AD COMMAND - SIERRA 1500',
    aiSequence: 'Hi {name}, thanks for checking out the Sierra 1500 total savings offer. Would you like me to run numbers on a specific trim for you?',
  },
  '120246266554990017': {
    campaignName: 'AD COMMAND - SIERRA 1500',
    aiSequence: 'Hi {name}, you came in on our Sierra 1500 financial offer. What payment range are you working with so I can find the best fit?',
  },
  '120244379676940017': {
    campaignName: 'AD COMMAND - ACADIA',
    aiSequence: 'Hi {name}, thanks for your interest in the Acadia. Are you looking for a specific trim or just exploring your options?',
  },
  '120246153707560017': {
    campaignName: 'AD COMMAND - YUKON',
    aiSequence: 'Hi {name}, you reached out about the Yukon Tuxedo Edition — great taste! Are you looking to buy or lease?',
  },
}

const DEFAULT_SEGMENT = {
  campaignName: 'AD COMMAND',
  aiSequence: 'Hi {name}, thanks for reaching out to Larry Spacc GMC! What vehicle are you interested in?',
}

export type FormClass = 'recruiting' | 'sales' | 'unknown'

export type ClaimResult =
  | { outcome: 'claimed'; claimToken: string }
  | { outcome: 'already_settled'; status: 'sent' | 'suppressed' }
  | { outcome: 'needs_review' }
  | { outcome: 'in_flight' }

export type DeliveryStatus = 'sent' | 'suppressed' | 'retryable' | 'needs_review'
export type DeliveryDisposition = 'dealersocket' | 'recruiting' | 'manual_precutover'

export type CompleteInput = {
  leadgenId: string
  claimToken: string
  status: DeliveryStatus
  disposition: DeliveryDisposition | null
  formId: string | null
  formName: string | null
  resendId: string | null
  idempotencyKey: string | null
  lastError: string | null
}

export interface DeliveryStore {
  claim(leadgenId: string): Promise<ClaimResult>
  complete(input: CompleteInput): Promise<boolean>
}

export type OutboundMail = {
  from: string
  to: string
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
}

export type MailResult =
  | { kind: 'sent'; id: string }
  | { kind: 'ambiguous'; detail: string }
  | { kind: 'in_progress'; detail: string }
  | { kind: 'payload_mismatch'; detail: string }
  | { kind: 'rejected'; detail: string }

export interface LeadMailer {
  send(message: OutboundMail, idempotencyKey: string): Promise<MailResult>
}

export type SalesForward = {
  leadgenId: string
  name: string
  email: string
  phone: string
  formId: string
  formName: string
  pageId: string
  adId: string
  campaignName: string
  aiSequence: string
  requestDate: string
  raw: unknown
}

export type NormalizedLead = {
  name: string
  email: string
  phone: string
  formId: string
  adId: string
  createdTime: unknown
  fieldDataPresent: boolean
  raw: unknown
}

export type LeadSource = {
  fetchLead(leadgenId: string): Promise<{ ok: true; lead: NormalizedLead } | { ok: false; code: string }>
  fetchFormName(formId: string): Promise<{ ok: true; name: string } | { ok: false; code: string }>
}

export type WebhookDeps = {
  store: DeliveryStore
  source: LeadSource
  mailer: LeadMailer
  recordSalesLead?: (lead: SalesForward) => Promise<void>
  afterSalesDelivery?: (lead: SalesForward) => Promise<void>
}

type LeadgenNotice = {
  leadgenId: unknown
  formId: unknown
  adId: unknown
  pageId: unknown
  createdTime: unknown
}

type MemoryRow = {
  status: 'claimed' | DeliveryStatus
  claimToken: string
  claimedAt: number
  disposition: DeliveryDisposition | null
  formId: string | null
  formName: string | null
  resendId: string | null
  idempotencyKey: string | null
  lastError: string | null
}

export function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function classifyFormName(name: string | null | undefined): FormClass {
  if (typeof name !== 'string') return 'unknown'
  const trimmed = name.trim()
  if (!trimmed) return 'unknown'
  if (RECRUITING_FORM_NAME_SET.has(trimmed)) return 'recruiting'
  return 'sales'
}

export function resolveSegment(adId: string): { campaignName: string; aiSequence: string } {
  return SEGMENT_MAP[adId] || DEFAULT_SEGMENT
}

export function openingMessage(adId: string, fullName: string): string {
  const first = (fullName || 'there').split(' ')[0] || 'there'
  return resolveSegment(adId).aiSequence.replace('{name}', first)
}

export function stableRequestDate(created: unknown): string {
  if (typeof created === 'number' && Number.isFinite(created)) {
    const ms = created < 1e12 ? created * 1000 : created
    return new Date(ms).toISOString()
  }
  if (typeof created === 'string') {
    const trimmed = created.trim()
    if (!trimmed) return ''
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      const ms = numeric < 1e12 ? numeric * 1000 : numeric
      return new Date(ms).toISOString()
    }
    return trimmed
  }
  return ''
}

export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function buildSalesAdfXml(input: {
  name: string
  email: string
  phone: string
  campaignName: string
  requestDate: string
}): string {
  const campaignName = input.campaignName || 'AD COMMAND'
  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect>
    <requestdate>${escapeXml(input.requestDate)}</requestdate>
    <vehicle interest="buy" status="new">
      <year></year>
      <make>GMC</make>
      <model></model>
    </vehicle>
    <customer>
      <contact>
        <name part="full">${escapeXml(input.name)}</name>
        <email>${escapeXml(input.email)}</email>
        <phone type="voice">${escapeXml(input.phone)}</phone>
      </contact>
    </customer>
    <vendor>
      <vendorname>Larry Spacc GMC</vendorname>
    </vendor>
    <provider>
      <name>${escapeXml(campaignName)}</name>
      <service>Facebook Lead Ads</service>
      <url>https://adcommand.one</url>
    </provider>
  </prospect>
</adf>`
}

export function buildRecruitingNoticeHtml(input: {
  leadgenId: string
  formName: string
  name: string
  email: string
  phone: string
}): string {
  return `<h2>New Employment Applicant</h2>
<p><strong>Form:</strong> ${escapeXml(input.formName)}</p>
<p><strong>Lead ID:</strong> ${escapeXml(input.leadgenId)}</p>
<p><strong>Name:</strong> ${escapeXml(input.name)}</p>
<p><strong>Email:</strong> ${escapeXml(input.email)}</p>
<p><strong>Phone:</strong> ${escapeXml(input.phone)}</p>`
}

export function salesIdempotencyKey(leadgenId: string): string {
  return `dealersocket-adf/v1/${leadgenId}`
}

export function recruitingIdempotencyKey(leadgenId: string): string {
  return `recruiting-notice/v1/${leadgenId}`
}

export function interpretMailResult(result: { data: { id?: string } | null; error: { name?: string; statusCode?: number | null; message?: string } | null }): MailResult {
  if (!result.error && result.data?.id) {
    return { kind: 'sent', id: result.data.id }
  }
  const name = result.error?.name || ''
  const status = result.error?.statusCode
  if (name === 'invalid_idempotent_request') {
    return { kind: 'payload_mismatch', detail: name }
  }
  if (name === 'concurrent_idempotent_requests' || status === 409) {
    return { kind: 'in_progress', detail: name || 'concurrent_idempotent_requests' }
  }
  if (status == null || status >= 500 || status === 429) {
    return { kind: 'ambiguous', detail: name || 'unresolved' }
  }
  return { kind: 'rejected', detail: `${status}:${name || 'rejected'}` }
}

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const row = data[0]
    return row && typeof row === 'object' ? row as Record<string, unknown> : null
  }
  if (data && typeof data === 'object') return data as Record<string, unknown>
  return null
}

export function createSupabaseDeliveryStore(client: RpcClient): DeliveryStore {
  return {
    async claim(leadgenId) {
      const { data, error } = await client.rpc('claim_meta_lead_delivery', { p_leadgen_id: leadgenId })
      if (error) throw new Error('delivery_store_claim_failed')
      const row = firstRow(data)
      const outcome = row?.outcome
      if (outcome === 'claimed' && typeof row?.claim_token === 'string') {
        return { outcome: 'claimed', claimToken: row.claim_token }
      }
      if (outcome === 'already_settled' && (row?.status === 'sent' || row?.status === 'suppressed')) {
        return { outcome: 'already_settled', status: row.status }
      }
      if (outcome === 'needs_review') return { outcome: 'needs_review' }
      if (outcome === 'in_flight') return { outcome: 'in_flight' }
      throw new Error('delivery_store_claim_unreadable')
    },
    async complete(input) {
      const { data, error } = await client.rpc('complete_meta_lead_delivery', {
        p_leadgen_id: input.leadgenId,
        p_claim_token: input.claimToken,
        p_status: input.status,
        p_disposition: input.disposition,
        p_form_id: input.formId,
        p_form_name: input.formName,
        p_resend_id: input.resendId,
        p_idempotency_key: input.idempotencyKey,
        p_last_error: input.lastError,
      })
      if (error) throw new Error('delivery_store_complete_failed')
      return data === true
    },
  }
}

export function createServiceRoleDeliveryStore(env: {
  url: string | undefined
  serviceRoleKey: string | undefined
}): DeliveryStore {
  if (!env.url || !env.serviceRoleKey) {
    throw new Error('delivery_store_unconfigured')
  }
  const client = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return createSupabaseDeliveryStore(client as SupabaseClient)
}

export function createMemoryDeliveryStore(options?: { now?: () => number; leaseMs?: number }): DeliveryStore {
  const rows = new Map<string, MemoryRow>()
  const now = options?.now ?? (() => Date.now())
  const leaseMs = options?.leaseMs ?? CLAIM_LEASE_MS
  let tail = Promise.resolve()

  function exclusive<T>(work: () => T): Promise<T> {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    claim(leadgenId) {
      return exclusive(() => {
        const current = now()
        let row = rows.get(leadgenId)
        if (!row) {
          row = {
            status: 'claimed',
            claimToken: crypto.randomUUID(),
            claimedAt: current,
            disposition: null,
            formId: null,
            formName: null,
            resendId: null,
            idempotencyKey: null,
            lastError: null,
          }
          rows.set(leadgenId, row)
          return { outcome: 'claimed' as const, claimToken: row.claimToken }
        }
        if (row.status === 'sent' || row.status === 'suppressed') {
          return { outcome: 'already_settled' as const, status: row.status }
        }
        if (row.status === 'needs_review') return { outcome: 'needs_review' as const }
        const staleClaim = row.status === 'claimed' && current >= row.claimedAt + leaseMs
        if (row.status === 'retryable' || staleClaim) {
          row.status = 'claimed'
          row.claimToken = crypto.randomUUID()
          row.claimedAt = current
          row.lastError = null
          return { outcome: 'claimed' as const, claimToken: row.claimToken }
        }
        return { outcome: 'in_flight' as const }
      })
    },
    complete(input) {
      return exclusive(() => {
        const row = rows.get(input.leadgenId)
        if (!row || row.status !== 'claimed' || row.claimToken !== input.claimToken) return false
        row.status = input.status
        row.disposition = input.disposition
        row.formId = input.formId
        row.formName = input.formName
        row.resendId = input.resendId ?? row.resendId
        row.idempotencyKey = input.idempotencyKey
        row.lastError = input.lastError
        return true
      })
    },
  }
}

function fieldValue(fieldData: unknown, names: string[]): string {
  if (!Array.isArray(fieldData)) return ''
  for (const wanted of names) {
    for (const field of fieldData) {
      if (!field || typeof field !== 'object') continue
      const record = field as { name?: unknown; values?: unknown }
      if (record.name !== wanted) continue
      if (!Array.isArray(record.values) || record.values[0] == null) return ''
      return String(record.values[0])
    }
  }
  return ''
}

function graphErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('error' in data)) return null
  const error = (data as { error?: { code?: unknown; type?: unknown } }).error
  if (!error || typeof error !== 'object') return 'graph_error'
  if (typeof error.code === 'number') return `graph_${error.code}`
  if (typeof error.type === 'string') return 'graph_error'
  return 'graph_error'
}

export function createGraphLeadSource(token: string, fetchImpl: typeof fetch = fetch): LeadSource {
  return {
    async fetchLead(leadgenId) {
      if (!token) return { ok: false, code: 'graph_token_missing' }
      if (!LEADGEN_ID_PATTERN.test(leadgenId)) return { ok: false, code: 'graph_id_rejected' }
      let response: Response
      try {
        response = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?fields=field_data,created_time,ad_id,form_id&access_token=${encodeURIComponent(token)}`)
      } catch {
        return { ok: false, code: 'graph_network' }
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        return { ok: false, code: 'graph_bad_json' }
      }
      const errorCode = graphErrorCode(data)
      if (!response.ok || errorCode) return { ok: false, code: errorCode || `graph_http_${response.status}` }
      if (!data || typeof data !== 'object') return { ok: false, code: 'graph_missing_fields' }
      const record = data as Record<string, unknown>
      if (!Array.isArray(record.field_data)) return { ok: false, code: 'graph_missing_fields' }
      return {
        ok: true,
        lead: {
          name: fieldValue(record.field_data, ['full_name', 'name']),
          email: fieldValue(record.field_data, ['email']),
          phone: fieldValue(record.field_data, ['phone_number', 'phone']),
          formId: typeof record.form_id === 'string' ? record.form_id : record.form_id == null ? '' : String(record.form_id),
          adId: typeof record.ad_id === 'string' ? record.ad_id : record.ad_id == null ? '' : String(record.ad_id),
          createdTime: record.created_time,
          fieldDataPresent: true,
          raw: data,
        },
      }
    },
    async fetchFormName(formId) {
      if (!token) return { ok: false, code: 'graph_token_missing' }
      if (!LEADGEN_ID_PATTERN.test(formId)) return { ok: false, code: 'graph_id_rejected' }
      let response: Response
      try {
        response = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${formId}?fields=name&access_token=${encodeURIComponent(token)}`)
      } catch {
        return { ok: false, code: 'graph_network' }
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        return { ok: false, code: 'graph_bad_json' }
      }
      const errorCode = graphErrorCode(data)
      if (!response.ok || errorCode) return { ok: false, code: errorCode || `graph_http_${response.status}` }
      const name = data && typeof data === 'object' ? (data as { name?: unknown }).name : null
      if (typeof name !== 'string' || !name.trim()) return { ok: false, code: 'form_name_missing' }
      return { ok: true, name }
    },
  }
}

type ResendSend = (
  payload: OutboundMail,
  options: { idempotencyKey: string; signal?: AbortSignal },
) => Promise<{ data: { id?: string } | null; error: { name?: string; statusCode?: number | null; message?: string } | null }>

export function createResendLeadMailer(): LeadMailer {
  return {
    async send(message, idempotencyKey) {
      const apiKey = process.env.RESEND_API_KEY
      if (!apiKey) return { kind: 'rejected', detail: '401:missing_api_key' }
      try {
        const resend = new Resend(apiKey)
        const send = resend.emails.send.bind(resend.emails) as ResendSend
        const result = await send(message, {
          idempotencyKey,
          signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
        })
        return interpretMailResult(result)
      } catch {
        return { kind: 'ambiguous', detail: 'mail_transport' }
      }
    },
  }
}

export function inspectWebhookBody(body: unknown): 'empty' | 'invalid' | 'leadgen' {
  const parsed = readNotices(body)
  if (parsed.kind === 'invalid') return 'invalid'
  if (parsed.notices.length === 0) return 'empty'
  return 'leadgen'
}

function readNotices(body: unknown): { kind: 'ok'; notices: LeadgenNotice[] } | { kind: 'invalid' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid' }
  const entry = (body as { entry?: unknown }).entry
  if (entry == null) return { kind: 'ok', notices: [] }
  if (!Array.isArray(entry)) return { kind: 'invalid' }
  const notices: LeadgenNotice[] = []
  for (const item of entry) {
    if (!item || typeof item !== 'object') continue
    const changes = (item as { changes?: unknown }).changes
    if (changes == null) continue
    if (!Array.isArray(changes)) return { kind: 'invalid' }
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue
      if ((change as { field?: unknown }).field !== 'leadgen') continue
      const value = (change as { value?: unknown }).value
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      notices.push({
        leadgenId: record.leadgen_id,
        formId: record.form_id,
        adId: record.ad_id,
        pageId: record.page_id,
        createdTime: record.created_time,
      })
    }
  }
  return { kind: 'ok', notices }
}

function logEvent(level: 'info' | 'error', code: string, leadgenId?: string, detail?: string) {
  const line = JSON.stringify({
    scope: 'meta-webhook',
    code,
    ...(leadgenId ? { leadgenId } : {}),
    ...(detail ? { detail } : {}),
  })
  if (level === 'error') console.error(line)
  else console.log(line)
}

function asId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string') return value.trim()
  return ''
}

async function finishClaim(store: DeliveryStore, input: CompleteInput, leadgenId: string): Promise<boolean> {
  try {
    return await store.complete(input)
  } catch {
    logEvent('error', 'delivery_store_complete_failed', leadgenId)
    return false
  }
}

async function runSideEffect(task: (() => Promise<void>) | undefined, code: string, leadgenId: string) {
  if (!task) return
  try {
    await task()
  } catch {
    logEvent('error', code, leadgenId)
  }
}

async function processNotice(notice: LeadgenNotice, deps: WebhookDeps): Promise<boolean> {
  const leadgenId = asId(notice.leadgenId)
  if (!LEADGEN_ID_PATTERN.test(leadgenId)) {
    logEvent('error', 'invalid_leadgen_id')
    return false
  }

  const fetched = await deps.source.fetchLead(leadgenId)
  if (!fetched.ok) {
    logEvent('error', 'graph_lead_failed', leadgenId, fetched.code)
    return true
  }

  const formId = LEADGEN_ID_PATTERN.test(fetched.lead.formId) ? fetched.lead.formId : asId(notice.formId)
  if (!LEADGEN_ID_PATTERN.test(formId)) {
    logEvent('error', 'form_unclassified', leadgenId, 'form_id_missing')
    return true
  }

  const form = await deps.source.fetchFormName(formId)
  if (!form.ok) {
    logEvent('error', 'form_unclassified', leadgenId, form.code)
    return true
  }
  const formClass = classifyFormName(form.name)
  if (formClass === 'unknown') {
    logEvent('error', 'form_unclassified', leadgenId, 'form_name_unusable')
    return true
  }

  const adId = fetched.lead.adId || asId(notice.adId)
  const pageId = asId(notice.pageId)
  const requestDate = stableRequestDate(fetched.lead.createdTime ?? notice.createdTime)
  const segment = resolveSegment(adId)
  const salesLead: SalesForward = {
    leadgenId,
    name: fetched.lead.name,
    email: fetched.lead.email,
    phone: fetched.lead.phone,
    formId,
    formName: form.name.trim(),
    pageId,
    adId,
    campaignName: segment.campaignName,
    aiSequence: openingMessage(adId, fetched.lead.name),
    requestDate,
    raw: fetched.lead.raw,
  }

  if (formClass === 'sales' && fetched.lead.fieldDataPresent && !salesLead.name && !salesLead.email && !salesLead.phone) {
    const blank = await claimAndSettle(deps.store, leadgenId, {
      status: 'needs_review',
      disposition: null,
      formId,
      formName: salesLead.formName,
      resendId: null,
      idempotencyKey: null,
      lastError: 'incomplete_lead',
    })
    logEvent(blank.retry ? 'error' : 'info', blank.retry ? 'incomplete_lead_unsettled' : 'incomplete_lead', leadgenId)
    return blank.retry
  }

  const idempotencyKey = formClass === 'recruiting' ? recruitingIdempotencyKey(leadgenId) : salesIdempotencyKey(leadgenId)
  const message: OutboundMail = formClass === 'recruiting'
    ? {
        from: RECRUITING_FROM,
        to: RECRUITING_NOTICE_TO,
        subject: `New Job Applicant: ${singleLine(salesLead.name)}`,
        html: buildRecruitingNoticeHtml(salesLead),
      }
    : {
        from: ADF_FROM,
        to: DEALERSOCKET_ADF_TO,
        subject: `New Lead: ${singleLine(salesLead.name)}`,
        text: buildSalesAdfXml(salesLead),
        headers: { 'Content-Type': 'text/xml' },
      }

  let claim: ClaimResult
  try {
    claim = await deps.store.claim(leadgenId)
  } catch {
    logEvent('error', 'delivery_store_claim_failed', leadgenId)
    return true
  }
  if (claim.outcome === 'already_settled' || claim.outcome === 'needs_review') {
    logEvent('info', claim.outcome === 'needs_review' ? 'needs_review' : 'duplicate', leadgenId)
    return false
  }
  if (claim.outcome === 'in_flight') {
    logEvent('info', 'delivery_in_flight', leadgenId)
    return true
  }

  let mailed: MailResult
  try {
    mailed = await deps.mailer.send(message, idempotencyKey)
  } catch {
    mailed = { kind: 'ambiguous', detail: 'mail_transport' }
  }

  if (mailed.kind === 'payload_mismatch') {
    const settled = await finishClaim(deps.store, {
      leadgenId,
      claimToken: claim.claimToken,
      status: 'needs_review',
      disposition: formClass === 'recruiting' ? 'recruiting' : 'dealersocket',
      formId,
      formName: salesLead.formName,
      resendId: null,
      idempotencyKey,
      lastError: 'idempotency_payload_mismatch',
    }, leadgenId)
    logEvent('error', 'idempotency_payload_mismatch', leadgenId)
    return !settled
  }

  if (mailed.kind !== 'sent') {
    const settled = await finishClaim(deps.store, {
      leadgenId,
      claimToken: claim.claimToken,
      status: 'retryable',
      disposition: formClass === 'recruiting' ? 'recruiting' : 'dealersocket',
      formId,
      formName: salesLead.formName,
      resendId: null,
      idempotencyKey,
      lastError: mailed.detail,
    }, leadgenId)
    if (!settled) logEvent('error', 'delivery_store_complete_failed', leadgenId)
    logEvent('error', 'mail_not_accepted', leadgenId, mailed.detail)
    return true
  }

  const completed = await finishClaim(deps.store, {
    leadgenId,
    claimToken: claim.claimToken,
    status: formClass === 'recruiting' ? 'suppressed' : 'sent',
    disposition: formClass === 'recruiting' ? 'recruiting' : 'dealersocket',
    formId,
    formName: salesLead.formName,
    resendId: mailed.id,
    idempotencyKey,
    lastError: null,
  }, leadgenId)
  if (!completed) {
    logEvent('error', 'claim_lost_after_send', leadgenId)
    return true
  }

  if (formClass === 'sales') {
    await runSideEffect(deps.recordSalesLead ? () => deps.recordSalesLead!(salesLead) : undefined, 'leads_insert_failed', leadgenId)
    await runSideEffect(deps.afterSalesDelivery ? () => deps.afterSalesDelivery!(salesLead) : undefined, 'ai_followup_failed', leadgenId)
    logEvent('info', 'adf_sent', leadgenId)
  } else {
    logEvent('info', 'recruiting_excluded', leadgenId)
  }
  return false
}

async function claimAndSettle(store: DeliveryStore, leadgenId: string, settlement: Omit<CompleteInput, 'leadgenId' | 'claimToken'>): Promise<{ retry: boolean }> {
  let claim: ClaimResult
  try {
    claim = await store.claim(leadgenId)
  } catch {
    logEvent('error', 'delivery_store_claim_failed', leadgenId)
    return { retry: true }
  }
  if (claim.outcome === 'already_settled' || claim.outcome === 'needs_review') return { retry: false }
  if (claim.outcome === 'in_flight') return { retry: true }
  const completed = await finishClaim(store, { ...settlement, leadgenId, claimToken: claim.claimToken }, leadgenId)
  return { retry: !completed }
}

export async function processMetaWebhook(body: unknown, deps: WebhookDeps): Promise<{ status: number; body: string }> {
  const parsed = readNotices(body)
  if (parsed.kind === 'invalid') return { status: 400, body: 'invalid' }
  if (parsed.notices.length === 0) return { status: 200, body: 'ok' }

  let retry = false
  for (const notice of parsed.notices) {
    try {
      if (await processNotice(notice, deps)) retry = true
    } catch {
      logEvent('error', 'lead_processing_failed', asId(notice.leadgenId) || undefined)
      retry = true
    }
  }
  return retry ? { status: 503, body: 'retry' } : { status: 200, body: 'ok' }
}
