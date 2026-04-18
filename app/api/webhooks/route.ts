import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendADFLead } from '../../lib/adf'

const VERIFY_TOKEN = 'adcommand_verify_token'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

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
            const fieldData: Record<string, string> = {}

            if (leadData.field_data) {
              for (const field of leadData.field_data) {
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
              raw_payload: leadData
            }

            // Save to Supabase
            await supabase.from('Leads').insert(lead)

            // Send ADF/XML to DealerSocket
            await sendADFLead(lead)
          }
        }
      }
    }
  }

  return NextResponse.json({ status: 'ok' })
}