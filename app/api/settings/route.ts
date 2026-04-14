import { NextResponse } from "next/server"
import { getSettings, upsertSetting } from "@/lib/server/db"
import { encrypt, decrypt, isSensitiveKey } from "@/lib/server/crypto"

export async function GET() {
  try {
    const rows = getSettings()
    const result: Record<string, string> = {}
    for (const row of rows) {
      if (isSensitiveKey(row.key)) {
        try {
          result[row.key] = decrypt(row.value)
        } catch {
          // If decryption fails (e.g. key rotated), return empty string
          result[row.key] = ""
        }
      } else {
        result[row.key] = row.value
      }
    }
    return NextResponse.json(result)
  } catch (e: any) {
    console.error("GET /api/settings failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const { key, value } = body
    if (!key || value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 })
    }
    const storedValue = isSensitiveKey(key) ? encrypt(value) : value
    upsertSetting(key, storedValue)
    return NextResponse.json({ key, value })
  } catch (e: any) {
    console.error("PUT /api/settings failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
