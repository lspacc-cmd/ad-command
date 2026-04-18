import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendADFLead(lead: {
  name: string
  email: string
  phone: string
  campaign_id?: string
}) {
  const adfXml = `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect>
    <requestdate>${new Date().toISOString()}</requestdate>
    <vehicle interest="buy" status="new">
      <year></year>
      <make>GMC</make>
      <model></model>
    </vehicle>
    <customer>
      <contact>
        <name part="full">${lead.name}</name>
        <email>${lead.email}</email>
        <phone type="voice">${lead.phone}</phone>
      </contact>
    </customer>
    <vendor>
      <vendorname>Larry Spacc GMC</vendorname>
    </vendor>
    <provider>
      <name>AD COMMAND</name>
      <service>Facebook Lead Ads</service>
      <url>https://adcommand.one</url>
    </provider>
  </prospect>
</adf>`

  const { data, error } = await resend.emails.send({
    from: 'leads@adcommand.one',
    to: 'webleads@Larryspacc.dsmessage.com',
    subject: `New Lead: ${lead.name}`,
    text: adfXml,
    headers: {
      'Content-Type': 'text/xml'
    }
  })

  if (error) {
    console.error('ADF email error:', error)
    return false
  }

  console.log('ADF email sent:', data)
  return true
}