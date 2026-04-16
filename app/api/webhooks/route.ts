import { NextRequest, NextResponse } from 'next/server'

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

export async function POST(request: NextRequest) {
  const body = await request.json()
  console.log('Lead received:', JSON.stringify(body, null, 2))
  return NextResponse.json({ status: 'ok' })
}