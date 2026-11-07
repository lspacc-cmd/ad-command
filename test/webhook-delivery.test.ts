import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEALERSOCKET_ADF_TO,
  RECRUITING_NOTICE_TO,
  buildSalesAdfXml,
  classifyFormName,
  createGraphLeadSource,
  createMemoryDeliveryStore,
  createSupabaseDeliveryStore,
  interpretMailResult,
  processMetaWebhook,
  salesIdempotencyKey,
  type LeadMailer,
  type LeadSource,
  type MailResult,
  type NormalizedLead,
  type OutboundMail,
  type WebhookDeps,
} from '../app/lib/lead-delivery.ts'

const SALES_AD = '120246153519930017'
const SALES_CAMPAIGN = 'AD COMMAND - SIERRA 1500'

function notice(leadgenId: string, extras?: Record<string, unknown>) {
  return {
    entry: [{
      changes: [{
        field: 'leadgen',
        value: {
          leadgen_id: leadgenId,
          form_id: '555',
          ad_id: SALES_AD,
          page_id: '249750524895190',
          created_time: 1760000000,
          ...extras,
        },
      }],
    }],
  }
}

function lead(overrides: Partial<NormalizedLead> = {}): NormalizedLead {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '555-0100',
    formId: '555',
    adId: SALES_AD,
    createdTime: 1760000000,
    fieldDataPresent: true,
    raw: { id: 'lead' },
    ...overrides,
  }
}

function source(options?: {
  leads?: Record<string, { ok: false; code: string } | NormalizedLead>
  formName?: string | { error: string }
  onLead?: (id: string) => void
  onForm?: (id: string) => void
}): LeadSource & { leadCalls: string[]; formCalls: string[] } {
  const leadCalls: string[] = []
  const formCalls: string[] = []
  return {
    leadCalls,
    formCalls,
    async fetchLead(id) {
      leadCalls.push(id)
      options?.onLead?.(id)
      const found = options?.leads?.[id]
      if (found && 'ok' in found) return found
      return { ok: true, lead: found ?? lead() }
    },
    async fetchFormName(id) {
      formCalls.push(id)
      options?.onForm?.(id)
      const formName = options?.formName
      if (formName && typeof formName === 'object') {
        return { ok: false as const, code: formName.error }
      }
      return { ok: true as const, name: formName ?? 'Sierra 1500 Offer' }
    },
  }
}

function mailer(handler?: (message: OutboundMail, key: string, attempt: number) => MailResult | Promise<MailResult>): LeadMailer & {
  calls: Array<{ message: OutboundMail; key: string }>
} {
  const calls: Array<{ message: OutboundMail; key: string }> = []
  return {
    calls,
    async send(message, key) {
      calls.push({ message, key })
      if (handler) return handler(message, key, calls.length)
      return { kind: 'sent', id: `email_${calls.length}` }
    },
  }
}

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps & {
  source: ReturnType<typeof source>
  mailer: ReturnType<typeof mailer>
  sales: SalesCall[]
  after: number
} {
  const sales: SalesCall[] = []
  let after = 0
  const built = {
    store: overrides.store ?? createMemoryDeliveryStore(),
    source: (overrides.source as ReturnType<typeof source>) ?? source(),
    mailer: (overrides.mailer as ReturnType<typeof mailer>) ?? mailer(),
    sales,
    get after() { return after },
    recordSalesLead: overrides.recordSalesLead ?? (async (row) => { sales.push(row) }),
    afterSalesDelivery: overrides.afterSalesDelivery ?? (async () => { after += 1 }),
  }
  return built
}

type SalesCall = { leadgenId: string; email: string; name: string }

test('classifies only the supplied recruiting form names', () => {
  assert.equal(classifyFormName('Auto Tech Apply'), 'recruiting')
  assert.equal(classifyFormName('  Auto Tech Apply v2  '), 'recruiting')
  assert.equal(classifyFormName('Auto Tech Apply v3'), 'sales')
  assert.equal(classifyFormName('auto tech apply'), 'sales')
  assert.equal(classifyFormName(''), 'unknown')
  assert.equal(classifyFormName('   '), 'unknown')
  assert.equal(classifyFormName(null), 'unknown')
})

test('escapes XML and keeps the ADF body stable', () => {
  const input = {
    name: `Tom & Jerry <"GMC">'s`,
    email: 'a&b@example.com',
    phone: '+1 <555>',
    campaignName: SALES_CAMPAIGN,
    requestDate: '2026-10-09T12:26:40.000Z',
  }
  const first = buildSalesAdfXml(input)
  const second = buildSalesAdfXml(input)
  assert.equal(first, second)
  assert.match(first, /Tom &amp; Jerry &lt;&quot;GMC&quot;&gt;&apos;s/)
  assert.match(first, /a&amp;b@example.com/)
  assert.match(first, /\+1 &lt;555&gt;/)
  assert.match(first, /AD COMMAND - SIERRA 1500/)
  assert.match(first, /2026-10-09T12:26:40.000Z/)
  assert.doesNotMatch(first, /Tom & Jerry/)
})

test('sequential duplicate lead id sends one ADF', async () => {
  const used = deps()
  const first = await processMetaWebhook(notice('1001'), used)
  const second = await processMetaWebhook(notice('1001'), used)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(used.mailer.calls.length, 1)
  assert.equal(used.mailer.calls[0].message.to, DEALERSOCKET_ADF_TO)
  assert.equal(used.mailer.calls[0].key, salesIdempotencyKey('1001'))
  assert.equal(used.sales.length, 1)
})

test('different lead ids with the same contact each send', async () => {
  const used = deps()
  const first = await processMetaWebhook(notice('2001'), used)
  const second = await processMetaWebhook(notice('2002'), used)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(used.mailer.calls.map((call) => call.key), [
    salesIdempotencyKey('2001'),
    salesIdempotencyKey('2002'),
  ])
  assert.deepEqual(used.sales.map((row) => row.leadgenId), ['2001', '2002'])
  assert.equal(used.sales[0].email, used.sales[1].email)
})

test('concurrent deliveries of one lead id send once', async () => {
  let release = () => {}
  let started!: () => void
  const opened = new Promise<void>((resolve) => { started = resolve })
  const sent = mailer(async () => {
    started()
    await new Promise<void>((resolve) => { release = resolve })
    return { kind: 'sent', id: 'email_concurrent' }
  })
  const used = deps({ mailer: sent })
  const first = processMetaWebhook(notice('3001'), used)
  await opened
  const second = await processMetaWebhook(notice('3001'), used)
  assert.equal(second.status, 503)
  assert.equal(sent.calls.length, 1)
  release()
  const finished = await first
  assert.equal(finished.status, 200)
  assert.equal(sent.calls.length, 1)
})

test('Auto Tech Apply and v2 never send a DealerSocket ADF', async () => {
  for (const [id, formName] of [['4101', 'Auto Tech Apply'], ['4102', 'Auto Tech Apply v2']] as const) {
    const used = deps({ source: source({ formName }) })
    const result = await processMetaWebhook(notice(id), used)
    assert.equal(result.status, 200)
    assert.equal(used.mailer.calls.length, 1)
    assert.equal(used.mailer.calls[0].message.to, RECRUITING_NOTICE_TO)
    assert.equal(used.mailer.calls[0].message.text, undefined)
    assert.match(used.mailer.calls[0].message.html || '', new RegExp(formName))
    assert.equal(used.sales.length, 0)
    assert.equal(used.after, 0)
    const again = await processMetaWebhook(notice(id), used)
    assert.equal(again.status, 200)
    assert.equal(used.mailer.calls.length, 1)
  }
})

test('recruiting notice escapes markup in the form fields', async () => {
  const used = deps({
    source: source({
      formName: 'Auto Tech Apply',
      leads: {
        '4103': lead({ name: '<script>', email: 'a&b@example.com', phone: `555'0` }),
      },
    }),
  })
  await processMetaWebhook(notice('4103'), used)
  const html = used.mailer.calls[0].message.html || ''
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /a&amp;b@example.com/)
  assert.match(html, /555&apos;0/)
  assert.doesNotMatch(html, /<script>/)
})

test('unreadable form name sends nothing and stays retryable', async () => {
  const missing = deps({ source: source({ formName: { error: 'graph_190' } }) })
  const result = await processMetaWebhook(notice('5001'), missing)
  assert.equal(result.status, 503)
  assert.equal(missing.mailer.calls.length, 0)
  assert.equal(missing.sales.length, 0)

  const blank = deps({ source: source({ formName: '   ' }) })
  const blankResult = await processMetaWebhook(notice('5002'), blank)
  assert.equal(blankResult.status, 503)
  assert.equal(blank.mailer.calls.length, 0)
})

test('Graph lead failure does not send a blank ADF', async () => {
  const forms: string[] = []
  const used = deps({
    source: source({
      leads: { '6001': { ok: false, code: 'graph_190' } },
      onForm: (id) => forms.push(id),
    }),
  })
  const result = await processMetaWebhook(notice('6001'), used)
  assert.equal(result.status, 503)
  assert.equal(used.mailer.calls.length, 0)
  assert.equal(forms.length, 0)
  assert.equal(used.sales.length, 0)
})

test('a rejected send can be retried once, and a later success is not repeated', async () => {
  let attempt = 0
  const sent = mailer(async (_message, key) => {
    attempt += 1
    if (attempt === 1) return { kind: 'rejected', detail: '422:validation_error' }
    return { kind: 'sent', id: `accepted-${key}` }
  })
  const used = deps({ mailer: sent })
  const failed = await processMetaWebhook(notice('7001'), used)
  const delivered = await processMetaWebhook(notice('7001'), used)
  const duplicate = await processMetaWebhook(notice('7001'), used)
  assert.equal(failed.status, 503)
  assert.equal(delivered.status, 200)
  assert.equal(duplicate.status, 200)
  assert.equal(sent.calls.length, 2)
  assert.equal(sent.calls[0].key, sent.calls[1].key)
})

test('an expired ambiguous attempt is not sent again', async () => {
  let current = 0
  const sent = mailer(async () => ({ kind: 'ambiguous', detail: 'unresolved' }))
  const used = deps({
    mailer: sent,
    store: createMemoryDeliveryStore({ now: () => current }),
  })
  const first = await processMetaWebhook(notice('7101'), used)
  current = 24 * 60 * 60 * 1000
  const second = await processMetaWebhook(notice('7101'), used)
  assert.equal(first.status, 503)
  assert.equal(second.status, 200)
  assert.equal(sent.calls.length, 1)
  assert.equal((await used.store.claim('7101')).outcome, 'needs_review')
})

test('a definite provider rejection can still send after 24 hours', async () => {
  let current = 0
  let attempt = 0
  const sent = mailer(async () => {
    attempt += 1
    if (attempt === 1) return { kind: 'rejected', detail: '422:validation_error' }
    return { kind: 'sent', id: 'email_after_rejection' }
  })
  const used = deps({
    mailer: sent,
    store: createMemoryDeliveryStore({ now: () => current }),
  })
  const rejected = await processMetaWebhook(notice('7102'), used)
  current = 25 * 60 * 60 * 1000
  const delivered = await processMetaWebhook(notice('7102'), used)
  assert.equal(rejected.status, 503)
  assert.equal(delivered.status, 200)
  assert.equal(sent.calls.length, 2)
})

test('an ambiguous attempt still retries inside the 24 hour window', async () => {
  let current = 0
  const accepted = new Map<string, string>()
  const sent = mailer(async (message, key) => {
    const prior = accepted.get(key)
    if (!prior) {
      accepted.set(key, JSON.stringify(message))
      return { kind: 'ambiguous', detail: 'unresolved' }
    }
    return { kind: 'sent', id: 'email_inside_window' }
  })
  const used = deps({
    mailer: sent,
    store: createMemoryDeliveryStore({ now: () => current }),
  })
  await processMetaWebhook(notice('7103'), used)
  current = 23 * 60 * 60 * 1000
  const recovered = await processMetaWebhook(notice('7103'), used)
  assert.equal(recovered.status, 200)
  assert.equal(sent.calls.length, 2)
  assert.equal(sent.calls[0].key, sent.calls[1].key)
})

test('a send is withheld when the attempt time cannot be recorded', async () => {
  const store = createMemoryDeliveryStore()
  store.noteMailAttempt = async () => false
  const sent = mailer()
  const result = await processMetaWebhook(notice('7104'), deps({ store, mailer: sent }))
  assert.equal(result.status, 503)
  assert.equal(sent.calls.length, 0)
})

test('an ambiguous timeout retries the same key and the same body', async () => {
  const accepted = new Map<string, { id: string; payload: string }>()
  const sent = mailer(async (message, key) => {
    const payload = JSON.stringify(message)
    const prior = accepted.get(key)
    if (!prior) {
      accepted.set(key, { id: 'email_timeout', payload })
      return { kind: 'ambiguous', detail: 'unresolved' }
    }
    assert.equal(payload, prior.payload)
    return { kind: 'sent', id: prior.id }
  })
  const used = deps({ mailer: sent })
  const timedOut = await processMetaWebhook(notice('7002'), used)
  const recovered = await processMetaWebhook(notice('7002'), used)
  const again = await processMetaWebhook(notice('7002'), used)
  assert.equal(timedOut.status, 503)
  assert.equal(recovered.status, 200)
  assert.equal(again.status, 200)
  assert.equal(accepted.size, 1)
  assert.equal(sent.calls.length, 2)
  assert.match(sent.calls[0].message.text || '', /Tom|Ada Lovelace/)
  assert.match(sent.calls[0].message.text || '', /AD COMMAND - SIERRA 1500/)
})

test('payload mismatch does not mint a second idempotency key', async () => {
  const sent = mailer(async () => ({ kind: 'payload_mismatch', detail: 'invalid_idempotent_request' }))
  const used = deps({ mailer: sent })
  const first = await processMetaWebhook(notice('7003'), used)
  const second = await processMetaWebhook(notice('7003'), used)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(sent.calls.length, 1)
  assert.equal(used.sales.length, 0)
})

test('a post-send failure does not send another ADF', async () => {
  const used = deps({
    recordSalesLead: async () => { throw new Error('column mismatch') },
    afterSalesDelivery: async () => { throw new Error('model failed') },
  })
  const first = await processMetaWebhook(notice('8001'), used)
  const second = await processMetaWebhook(notice('8001'), used)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(used.mailer.calls.length, 1)
})

test('an empty contact on a sales form is not forwarded', async () => {
  const used = deps({
    source: source({
      leads: { '8002': lead({ name: '', email: '', phone: '' }) },
    }),
  })
  const first = await processMetaWebhook(notice('8002'), used)
  const second = await processMetaWebhook(notice('8002'), used)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(used.mailer.calls.length, 0)
})

test('a non-numeric lead id is not fetched or mailed', async () => {
  const used = deps()
  const result = await processMetaWebhook(notice('../not-an-id'), used)
  assert.equal(result.status, 200)
  assert.equal(used.source.leadCalls.length, 0)
  assert.equal(used.mailer.calls.length, 0)
})

test('an empty webhook body does not claim a delivery', async () => {
  let claims = 0
  const store = createMemoryDeliveryStore()
  const original = store.claim.bind(store)
  store.claim = async (id) => {
    claims += 1
    return original(id)
  }
  const result = await processMetaWebhook({}, deps({ store }))
  assert.equal(result.status, 200)
  assert.equal(claims, 0)
})

test('one failed lead in a batch does not resend the lead that already went out', async () => {
  const used = deps({
    source: source({
      leads: { '9002': { ok: false, code: 'graph_network' } },
    }),
  })
  const body = {
    entry: [{
      changes: [
        notice('9001').entry[0].changes[0],
        notice('9002').entry[0].changes[0],
      ],
    }],
  }
  const first = await processMetaWebhook(body, used)
  const second = await processMetaWebhook(body, used)
  assert.equal(first.status, 503)
  assert.equal(second.status, 503)
  assert.equal(used.mailer.calls.length, 1)
  assert.equal(used.mailer.calls[0].key, salesIdempotencyKey('9001'))
})

test('memory store reclaim waits out a fresh claim and allows a stale one', async () => {
  let current = 0
  const store = createMemoryDeliveryStore({ now: () => current, leaseMs: 1000 })
  const first = await store.claim('42')
  assert.equal(first.outcome, 'claimed')
  current = 999
  assert.equal((await store.claim('42')).outcome, 'in_flight')
  current = 1000
  const reclaimed = await store.claim('42')
  assert.equal(reclaimed.outcome, 'claimed')
  if (first.outcome === 'claimed' && reclaimed.outcome === 'claimed') {
    assert.notEqual(first.claimToken, reclaimed.claimToken)
    assert.equal(await store.complete({
      leadgenId: '42',
      claimToken: first.claimToken,
      status: 'sent',
      disposition: 'dealersocket',
      formId: null,
      formName: null,
      resendId: 'old',
      idempotencyKey: null,
      lastError: null,
    }), false)
    assert.equal(await store.complete({
      leadgenId: '42',
      claimToken: reclaimed.claimToken,
      status: 'sent',
      disposition: 'dealersocket',
      formId: null,
      formName: null,
      resendId: 'new',
      idempotencyKey: salesIdempotencyKey('42'),
      lastError: null,
    }), true)
  }
  assert.equal((await store.claim('42')).outcome, 'already_settled')
})

test('supabase store reads claim and complete responses', async () => {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = []
  const store = createSupabaseDeliveryStore({
    async rpc(fn, args) {
      calls.push({ fn, args })
      if (fn === 'claim_meta_lead_delivery') {
        return { data: [{ outcome: 'claimed', claim_token: 'token-1', status: 'claimed', resend_id: null }], error: null }
      }
      return { data: true, error: null }
    },
  })
  const claim = await store.claim('123')
  assert.deepEqual(claim, { outcome: 'claimed', claimToken: 'token-1' })
  const completed = await store.complete({
    leadgenId: '123',
    claimToken: 'token-1',
    status: 'sent',
    disposition: 'dealersocket',
    formId: '555',
    formName: 'Sierra 1500 Offer',
    resendId: 'email_1',
    idempotencyKey: salesIdempotencyKey('123'),
    lastError: null,
  })
  assert.equal(completed, true)
  assert.equal(calls[0].fn, 'claim_meta_lead_delivery')
  assert.equal(calls[1].fn, 'complete_meta_lead_delivery')
  assert.equal(calls[1].args?.p_resend_id, 'email_1')
})

test('mail results distinguish timeout, conflict, mismatch, and hard rejection', () => {
  assert.deepEqual(interpretMailResult({ data: { id: 'email_1' }, error: null }), { kind: 'sent', id: 'email_1' })
  assert.equal(interpretMailResult({ data: null, error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' } }).kind, 'ambiguous')
  assert.equal(interpretMailResult({ data: null, error: { name: 'concurrent_idempotent_requests', statusCode: 409, message: 'in progress' } }).kind, 'in_progress')
  assert.equal(interpretMailResult({ data: null, error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'modified' } }).kind, 'payload_mismatch')
  assert.equal(interpretMailResult({ data: null, error: { name: 'api_error', statusCode: 500, message: 'later' } }).kind, 'ambiguous')
  assert.equal(interpretMailResult({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'bad' } }).kind, 'rejected')
})

test('graph fetch rejects unsafe ids and reads a normal lead', async () => {
  const urls: string[] = []
  const graph = createGraphLeadSource('test-token', async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({
      field_data: [
        { name: 'full_name', values: ['Ada Lovelace'] },
        { name: 'email', values: ['ada@example.com'] },
        { name: 'phone_number', values: ['555-0100'] },
      ],
      created_time: '2026-10-09T12:26:40+0000',
      ad_id: SALES_AD,
      form_id: '555',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(await graph.fetchLead('../x'), { ok: false, code: 'graph_id_rejected' })
  assert.equal(urls.length, 0)
  const fetched = await graph.fetchLead('555')
  assert.equal(fetched.ok, true)
  if (fetched.ok) {
    assert.equal(fetched.lead.name, 'Ada Lovelace')
    assert.equal(fetched.lead.email, 'ada@example.com')
  }
  assert.match(urls[0], /graph\.facebook\.com\/v25\.0\/555\?/)
  assert.match(urls[0], /access_token=test-token/)
  assert.doesNotMatch(urls[0], /FIELDSET/)
})

test('unapplied migration is a service-role ledger without contact columns', () => {
  const sql = readFileSync(new URL('../supabase/unapplied/meta-lead-deliveries.sql', import.meta.url), 'utf8')
  assert.match(sql, /leadgen_id text primary key/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on table public\.meta_lead_deliveries from public, anon, authenticated, service_role/)
  assert.match(sql, /security definer/)
  assert.match(sql, /grant select on table public\.meta_lead_deliveries to service_role/)
  assert.match(sql, /grant execute on function public\.claim_meta_lead_delivery\(text\) to service_role/)
  assert.match(sql, /mail_attempted_at timestamptz/)
  assert.match(sql, /interval '24 hours'/)
  assert.match(sql, /grant execute on function public\.note_mail_attempt\(text, uuid\) to service_role/)
  assert.doesNotMatch(sql, /\bemail\b/i)
  assert.doesNotMatch(sql, /\bphone\b/i)
  const seed = readFileSync(new URL('../supabase/unapplied/seed-manual-leadgen-ids.EXAMPLE.sql', import.meta.url), 'utf8')
  assert.match(seed, /PASTE_LEADGEN_ID/)
  assert.match(seed, /on conflict \(leadgen_id\) do nothing/)
  assert.match(seed, /manual_precutover/)
  assert.doesNotMatch(seed, /'[0-9]{6,}'/)
})
