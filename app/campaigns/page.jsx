'use client'

import { useEffect, useState } from 'react'

const AD_ACCOUNT_ID = 'act_448513050930740'
const ACCESS_TOKEN = process.env.NEXT_PUBLIC_META_ACCESS_TOKEN

const fields = 'campaign_name,spend,impressions,reach,clicks,cpc,cpm,cpp,ctr,actions,cost_per_action_type,video_avg_time_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions'

function getCPLColor(cpl) {
  if (!cpl) return 'gray'
  if (cpl < 15) return 'green'
  if (cpl < 25) return 'orange'
  return 'red'
}

function getMetric(actions, type) {
  if (!actions) return 0
  const found = actions.find(a => a.action_type === type)
  return found ? parseInt(found.value) : 0
}

function getCostPerLead(costPerAction, type) {
  if (!costPerAction) return null
  const found = costPerAction.find(a => a.action_type === type)
  return found ? parseFloat(found.value) : null
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [dateRange, setDateRange] = useState('last_30d')

  useEffect(() => {
    fetchCampaigns()
  }, [dateRange])

  async function fetchCampaigns() {
    setLoading(true)
    setError(null)
    try {
      const url = `https://graph.facebook.com/v25.0/${AD_ACCOUNT_ID}/campaigns?fields=name,status,insights.date_preset(${dateRange}){${fields}}&access_token=${ACCESS_TOKEN}`
      const res = await fetch(url)
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      setCampaigns(data.data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '24px', fontFamily: 'sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>AD COMMAND — Campaign Performance</h1>
        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #ddd', fontSize: '14px' }}
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last_7d">Last 7 days</option>
          <option value="last_30d">Last 30 days</option>
          <option value="this_month">This month</option>
        </select>
      </div>

      {loading && <p style={{ color: '#666' }}>Loading campaign data...</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}

      {!loading && !error && campaigns.map(campaign => {
        const insights = campaign.insights?.data?.[0]
        if (!insights) return (
          <div key={campaign.id} style={{ background: '#f9f9f9', borderRadius: '12px', padding: '20px', marginBottom: '16px', border: '1px solid #eee' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>{campaign.name}</h2>
              <span style={{ fontSize: '12px', color: '#999' }}>No data for period</span>
            </div>
          </div>
        )

        const leads = getMetric(insights.actions, 'lead')
        const cpl = getCostPerLead(insights.cost_per_action_type, 'lead')
        const cplColor = getCPLColor(cpl)
        const spend = parseFloat(insights.spend || 0)
        const impressions = parseInt(insights.impressions || 0)
        const reach = parseInt(insights.reach || 0)
        const clicks = parseInt(insights.clicks || 0)
        const ctr = parseFloat(insights.ctr || 0)
        const videoViews = getMetric(insights.actions, 'video_view')
        const viewRate = impressions > 0 ? ((videoViews / impressions) * 100).toFixed(1) : 0

        return (
          <div key={campaign.id} style={{ background: 'white', borderRadius: '12px', padding: '20px', marginBottom: '16px', border: '1px solid #eee', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>{campaign.name}</h2>
              <span style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '20px', background: campaign.status === 'ACTIVE' ? '#e6f4ea' : '#f1f1f1', color: campaign.status === 'ACTIVE' ? '#2d7a3a' : '#999' }}>
                {campaign.status}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
              <Metric label="Spend" value={`$${spend.toFixed(2)}`} />
              <Metric label="Leads" value={leads} />
              <Metric label="Cost per Lead" value={cpl ? `$${cpl.toFixed(2)}` : '—'} color={cplColor} />
              <Metric label="Impressions" value={impressions.toLocaleString()} />
              <Metric label="Reach" value={reach.toLocaleString()} />
              <Metric label="Clicks" value={clicks.toLocaleString()} />
              <Metric label="CTR" value={`${ctr.toFixed(2)}%`} />
              <Metric label="Video View Rate" value={`${viewRate}%`} />
            </div>
          </div>
        )
      })}

      {!loading && !error && campaigns.length === 0 && (
        <p style={{ color: '#666' }}>No campaigns found.</p>
      )}
    </div>
  )
}

function Metric({ label, value, color }) {
  const colorMap = { green: '#2d7a3a', orange: '#b45309', red: '#dc2626', gray: '#999' }
  return (
    <div style={{ background: '#f9f9f9', borderRadius: '8px', padding: '12px' }}>
      <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: '600', color: color ? colorMap[color] : '#111' }}>{value}</div>
    </div>
  )
}