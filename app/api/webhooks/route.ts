import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  createGraphLeadSource,
  createResendLeadMailer,
  createServiceRoleDeliveryStore,
  inspectWebhookBody,
  processMetaWebhook,
  type SalesForward,
} from '../../lib/lead-delivery'

const VERIFY_TOKEN = 'adcommand_verify_token'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 })
  }

  return new NextResponse('Forbidden', { status: 403 })
}

async function recordSalesLead(lead: SalesForward) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('leads_store_unconfigured')

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { error } = await supabase.from('Leads').insert({
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    form_id: lead.formId,
    page_id: lead.pageId,
    ad_id: lead.adId,
    ai_sequence: lead.aiSequence,
    status: 'new',
    raw_payload: lead.raw,
    campaign_id: lead.campaignName,
  })
  if (error) {
    console.error(JSON.stringify({
      scope: 'meta-webhook',
      code: 'leads_insert_failed',
      leadgenId: lead.leadgenId,
      detail: String(error.message || 'insert_failed').slice(0, 300),
    }))
    throw new Error('leads_insert_failed')
  }
}

async function afterSalesDelivery(lead: SalesForward) {
  const { generateLeadResponse } = await import('../../lib/ai')
  const message = await generateLeadResponse({
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
  })
  if (message) {
    console.log(JSON.stringify({
      scope: 'meta-webhook',
      code: 'ai_followup_ready',
      leadgenId: lead.leadgenId,
    }))
  }
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new NextResponse('invalid', { status: 400 })
  }

  const shape = inspectWebhookBody(body)
  if (shape === 'invalid') return new NextResponse('invalid', { status: 400 })
  if (shape === 'empty') return new NextResponse('ok', { status: 200 })

  let store
  try {
    store = createServiceRoleDeliveryStore({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })
  } catch {
    console.error(JSON.stringify({ scope: 'meta-webhook', code: 'delivery_store_unconfigured' }))
    return new NextResponse('retry', { status: 503 })
  }

  const result = await processMetaWebhook(body, {
    store,
    source: createGraphLeadSource(process.env.FACEBOOK_PAGE_ACCESS_TOKEN || ''),
    mailer: createResendLeadMailer(),
    recordSalesLead,
    afterSalesDelivery,
  })
  return new NextResponse(result.body, { status: result.status })
}
