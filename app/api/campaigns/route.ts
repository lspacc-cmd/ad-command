import { NextResponse } from 'next/server'

const AD_ACCOUNT_ID = 'act_1469784980279576'
const ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const datePreset = searchParams.get('date_preset') || 'last_30d'

  try {
    const url = `https://graph.facebook.com/v25.0/${AD_ACCOUNT_ID}/campaigns?fields=name,status,insights.date_preset(${datePreset}){campaign_name,spend,impressions,reach,clicks,cpc,cpm,ctr,actions,cost_per_action_type}&access_token=${ACCESS_TOKEN}`
    
    const res = await fetch(url)
    const data = await res.json()
    
    if (data.error) {
      return NextResponse.json({ error: data.error.message }, { status: 400 })
    }
    
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500 })
  }
}