import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const resend = new Resend(process.env.RESEND_API_KEY)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ── Source mapping — distinct per channel & campaign ──────────
const SOURCE_MAP: Record<string, { source: string; subsource: string; dept: string }> = {
  // Google Ads campaigns
  'sierra-hd':      { source: 'Google Ads', subsource: 'Sierra HD',        dept: 'New Vehicle Sales' },
  'sierra-1500':    { source: 'Google Ads', subsource: 'Sierra 1500',      dept: 'New Vehicle Sales' },
  'conquest':       { source: 'Google Ads', subsource: 'Conquest',         dept: 'New Vehicle Sales' },
  'used-trucks':    { source: 'Google Ads', subsource: 'Used Trucks',      dept: 'Used Vehicle Sales' },
  'service-parts':  { source: 'Google Ads', subsource: 'Service & Parts',  dept: 'Service' },
  'body-shop':      { source: 'Google Ads', subsource: 'Body Shop',        dept: 'Body Shop' },
  // Meta campaigns (for future use via this endpoint)
  'meta-sierra-hd':   { source: 'Facebook/Instagram', subsource: 'Sierra HD',    dept: 'New Vehicle Sales' },
  'meta-sierra-1500': { source: 'Facebook/Instagram', subsource: 'Sierra 1500',  dept: 'New Vehicle Sales' },
  'meta-used':        { source: 'Facebook/Instagram', subsource: 'Used Trucks',   dept: 'Used Vehicle Sales' },
  // TikTok
  'tiktok-sierra':    { source: 'TikTok',             subsource: 'Sierra',        dept: 'New Vehicle Sales' },
  // Default
  'default':        { source: 'Google Ads', subsource: 'Landing Page',    dept: 'New Vehicle Sales' },
}

function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;')
}

function buildADF(lead: any, mapping: typeof SOURCE_MAP[string]): string {
  const requestDate = new Date().toISOString().split('T')[0]
  const isUsed = mapping.dept.includes('Used')

  const fullSource = [
    mapping.source,
    mapping.subsource,
    lead.adgroup  ? `Ad Group: ${lead.adgroup}`  : null,
    lead.keyword  ? `Keyword: ${lead.keyword}`   : null,
  ].filter(Boolean).join(' | ')

  const comments = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `AD COMMAND LEAD ATTRIBUTION`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `CHANNEL:       ${mapping.source}`,
    `CAMPAIGN:      ${lead.campaign   || 'unknown'}`,
    `AD GROUP:      ${lead.adgroup    || 'unknown'}`,
    `KEYWORD:       ${lead.keyword    || 'unknown'}`,
    `LANDING PAGE:  ${lead.landingPage || 'unknown'}`,
    `TRACKING LINE: ${lead.trackingLine || '716-268-1096'}`,
    `DEPARTMENT:    ${mapping.dept}`,
    `TRIM INTEREST: ${lead.trim       || 'Any'}`,
    lead.config   ? `HD CONFIG:     ${lead.config}` : null,
    lead.notes    ? `BUYER NOTES:   ${lead.notes}` : null,
    `SUBMITTED:     ${lead.timestamp  || new Date().toISOString()}`,
    `TCPA CONSENT:  Yes — obtained at form submission`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `FULL SOURCE:   ${fullSource}`,
  ].filter(Boolean).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <id sequence="1" source="${escapeXml(fullSource)}">${Date.now()}</id>
    <requestdate>${requestDate}</requestdate>
    <vehicle interest="${isUsed ? 'Used' : 'New'}" status="available">
      <year></year>
      <make>GMC</make>
      <model>${escapeXml(lead.trim || mapping.subsource)}</model>
      <trim>${escapeXml(lead.trim || '')}</trim>
    </vehicle>
    <customer>
      <contact primarycontact="1">
        <name part="first">${escapeXml(lead.firstName || '')}</name>
        <phone type="voice" time="day">${escapeXml(lead.phone || '')}</phone>
      </contact>
      <comments>${escapeXml(comments)}</comments>
    </customer>
    <vendor>
      <vendorname>Larry Spacc GMC</vendorname>
      <contact primarycontact="1">
        <name part="full">AD COMMAND</name>
        <email>leads@adcommand.one</email>
      </contact>
    </vendor>
    <provider>
      <name part="full">${escapeXml(mapping.source)}</name>
      <service>${escapeXml(mapping.subsource)}</service>
      <url>${escapeXml(lead.landingPage || '')}</url>
    </provider>
  </prospect>
</adf>`
}

export async function POST(request: NextRequest) {
  try {
    const lead = await request.json()

    // Validate required fields
    if (!lead.phone || !lead.firstName) {
      return NextResponse.json(
        { error: 'Missing required fields: firstName, phone' },
        { status: 400 }
      )
    }

    const campaign = lead.campaign || 'default'
    const mapping  = SOURCE_MAP[campaign] || SOURCE_MAP['default']
    const adfXml   = buildADF(lead, mapping)

    // Subject line — unique per channel so DealerSocket inbox is scannable
    const subjectParts = [
      `[${mapping.source}]`,
      mapping.subsource,
      lead.keyword ? `"${lead.keyword}"` : null,
      '— Larry Spacc GMC',
    ].filter(Boolean)
    const subject = subjectParts.join(' ')

    // Send ADF/XML via Resend — same pattern as Meta webhook
    const { data, error } = await resend.emails.send({
      from: 'leads@adcommand.one',
      to:   'webleads@Larryspacc.dsmessage.com',
      subject,
      text: adfXml,
      headers: {
        'Content-Type': 'text/xml',
      },
    })

    if (error) {
      console.error('Resend error:', error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    // Log to Supabase — same table as Meta leads for unified reporting
    const { error: dbError } = await supabase
      .from('leads')
      .insert({
        source:        mapping.source,
        subsource:     mapping.subsource,
        campaign:      lead.campaign     || 'unknown',
        adgroup:       lead.adgroup      || 'unknown',
        keyword:       lead.keyword      || 'unknown',
        first_name:    lead.firstName,
        phone:         lead.phone,
        trim:          lead.trim         || 'Any',
        config:        lead.config       || null,
        notes:         lead.notes        || null,
        landing_page:  lead.landingPage  || null,
        tracking_line: lead.trackingLine || '716-268-1096',
        department:    mapping.dept,
        tcpa_consent:  true,
        resend_id:     data?.id          || null,
        created_at:    new Date().toISOString(),
      })

    if (dbError) {
      // Don't fail the request — lead already sent to DealerSocket
      console.error('Supabase log error:', dbError)
    }

    console.log('AD COMMAND Google Lead dispatched:', {
      source:    mapping.source,
      subsource: mapping.subsource,
      campaign:  lead.campaign,
      keyword:   lead.keyword,
      resend_id: data?.id,
    })

    return NextResponse.json({
      success:   true,
      message:   'Lead received and forwarded to DealerSocket',
      leadId:    data?.id,
      source:    mapping.source,
      subsource: mapping.subsource,
    })

  } catch (err: any) {
    console.error('AD COMMAND Google lead error:', err)
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}