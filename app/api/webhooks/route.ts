import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendADFLead } from '../../lib/adf'
import { generateLeadResponse } from '../../lib/ai'

const VERIFY_TOKEN = 'adcommand_verify_token'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

async function fetchLeadData(leadgenId: string) {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  const url = `https://graph.facebook.com/v25.0/${leadgenId}?fields=field_data,created_time,ad_id,form_id,page_id&access_token=${token}`
  console.log('Fetching lead data for:', leadgenId)
  const response = await fetch(url)
  const data = await response.json()
  console.log('Lead data response:', JSON.stringify(data))
  return data
}


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

export async function POST(request: NextRequest) {
  const body = await request.json()

  if (body.entry) {
    for (const entry of body.entry) {
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'leadgen') {
            const leadData = change.value
            const leadgenId = leadData.leadgen_id

            // Fetch full lead data from Facebook
            const fullLead = await fetchLeadData(leadgenId)
            const fieldData: Record<string, string> = {}

            if (fullLead.field_data) {
              for (const field of fullLead.field_data) {
                fieldData[field.name] = field.values[0]
              }
            }

            const lead = {
              name: fieldData['full_name'] || fieldData['name'] || '',
              email: fieldData['email'] || '',
              phone: fieldData['phone_number'] || fieldData['phone'] || '',
              form_id: leadData.form_id || '',
              page_id: leadData.page_id || '',
              status: 'new',
              raw_payload: fullLead
            }

            // Save to Supabase
            await supabase.from('Leads').insert(lead)

            // Send ADF/XML to DealerSocket
            await sendADFLead(lead)

            // Generate AI follow-up message
            const aiMessage = await generateLeadResponse(lead)
            if (aiMessage) {
              console.log('AI follow-up generated:', aiMessage)
              // Next step: send via Facebook Messenger
            }
          }
        }
      }
    }
  }

  return NextResponse.json({ status: 'ok' })
}