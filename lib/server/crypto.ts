import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"

// Reuse v1 keyfile if present so encrypted settings imported from v1 can be
// decrypted. Otherwise create a new keyfile in the v2 data dir.
const V1_KEYFILE = path.join(os.homedir(), ".openfang", "apps", "nodepad", "data", ".keyfile")
const V2_KEYFILE = path.join(os.homedir(), ".openfang", "apps", "nodepad-v2", "data", ".keyfile")

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12

let cachedKey: Buffer | null = null

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey

  // Prefer v1 keyfile if it exists (so we can read v1's encrypted settings)
  if (fs.existsSync(V1_KEYFILE)) {
    cachedKey = fs.readFileSync(V1_KEYFILE)
    return cachedKey
  }
  if (fs.existsSync(V2_KEYFILE)) {
    cachedKey = fs.readFileSync(V2_KEYFILE)
    return cachedKey
  }

  const dir = path.dirname(V2_KEYFILE)
  fs.mkdirSync(dir, { recursive: true })
  const key = crypto.randomBytes(32)
  fs.writeFileSync(V2_KEYFILE, key, { mode: 0o600 })
  cachedKey = key
  return key
}

export function encrypt(plaintext: string): string {
  const key = getOrCreateKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`
}

export function decrypt(blob: string): string {
  const key = getOrCreateKey()
  const [ivHex, ciphertextHex, tagHex] = blob.split(":")
  if (!ivHex || !ciphertextHex || !tagHex) {
    throw new Error("Invalid encrypted blob format")
  }
  const iv = Buffer.from(ivHex, "hex")
  const ciphertext = Buffer.from(ciphertextHex, "hex")
  const tag = Buffer.from(tagHex, "hex")
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString("utf8")
}

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return lower.includes("apikey") || lower.includes("token") || lower.includes("key")
}
