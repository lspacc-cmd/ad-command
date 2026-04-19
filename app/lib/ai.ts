import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

export async function generateLeadResponse(lead: {
  name: string
  email: string
  phone: string
  vehicle_interest?: string
  has_tradein?: boolean
  financing_interest?: boolean
  purchase_timeframe?: string
}) {
  const firstName = lead.name.split(' ')[0] || 'there'
  
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are a friendly, professional sales assistant at Larry Spacc GMC in Fredonia, NY. 
        
A customer just submitted a lead form. Write a warm, personalized first response message to send them via Facebook Messenger. Keep it under 150 words. Be conversational, not salesy. 

Customer info:
- Name: ${lead.name}
- Vehicle interest: ${lead.vehicle_interest || 'GMC vehicles'}
- Has trade-in: ${lead.has_tradein ? 'Yes' : 'Unknown'}
- Interested in financing: ${lead.financing_interest ? 'Yes' : 'Unknown'}
- Purchase timeframe: ${lead.purchase_timeframe || 'Unknown'}

The message should:
1. Address them by first name (${firstName})
2. Reference what they were looking at
3. Offer to help answer questions
4. Ask one simple qualifying question
5. Sign off as "Larry Spacc GMC Team"

Write only the message, nothing else.`
      }
    ]
  })

  const response = message.content[0]
  if (response.type === 'text') {
    return response.text
  }
  
  return null
}