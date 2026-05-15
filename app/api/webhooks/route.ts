import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendADFLead } from '../../lib/adf'
import { generateLeadResponse } from '../../lib/ai'

const VERIFY_TOKEN = 'adcommand_verify_token'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ============================================================
// SEGMENT MAP
// Key = Facebook Ad ID
// campaignName must match EXACTLY what you entered in DealerSocket Lead Source Maintenance
// aiSequence = opening question the AI asks based on which ad the lead came from
// ============================================================
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

// Fallback if ad ID is not in the map
const DEFAULT_SEGMENT = {
  campaignName: 'AD COMMAND',
  aiSequence: 'Hi {name}, thanks for reaching out to Larry Spacc GMC! What vehicle are you interested in?',
}

function resolveSegment(adId: string) {
  return SEGMENT_MAP[adId] || DEFAULT_SEGMENT
}

// ============================================================

async function fetchLeadData(leadgenId: string) {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  const url = `https://graph.facebook.com/v25.0/${leadgenId}?fields=field_data,created_time,ad_id,form_id&access_token=${token}`
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
  console.log('Lead received:', JSON.stringify(body, null, 2))

  if (body.entry) {
    for (const entry of body.entry) {
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'leadgen') {
            const leadData = change.value
            const leadgenId = leadData.leadgen_id

            const fullLead = await fetchLeadData(leadgenId)
            const fieldData: Record<string, string> = {}

            if (fullLead.field_data) {
              for (const field of fullLead.field_data) {
                fieldData[field.name] = field.values[0]
              }
            }

            // Resolve segment from ad_id
            const adId = fullLead.ad_id || ''
            const segmentInfo = resolveSegment(adId)

            // Personalize AI opening message with lead's first name
            const leadName = fieldData['full_name'] || fieldData['name'] || 'there'
            const firstName = leadName.split(' ')[0]
            const personalizedAiMessage = segmentInfo.aiSequence.replace('{name}', firstName)

            const lead = {
              name: fieldData['full_name'] || fieldData['name'] || '',
              email: fieldData['email'] || '',
              phone: fieldData['phone_number'] || fieldData['phone'] || '',
              form_id: fullLead.form_id || '',
              page_id: leadData.page_id || '',
              ad_id: adId,
              campaign_name: segmentInfo.campaignName,
              ai_sequence: personalizedAiMessage,
              status: 'new',
              raw_payload: fullLead,
            }

            console.log('Campaign resolved:', segmentInfo.campaignName)

            await supabase.from('Leads').insert(lead)
            await sendADFLead(lead)

            const aiMessage = await generateLeadResponse(lead)
            if (aiMessage) {
              console.log('AI follow-up generated:', aiMessage)
            }
          }
        }
      }
    }
  }

  return new NextResponse('OK', { status: 200 })
}
