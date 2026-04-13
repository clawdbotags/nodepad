import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"

const KEYFILE_PATH = path.join(
  os.homedir(),
  ".openfang",
  "apps",
  "nodepad",
  "data",
  ".keyfile"
)

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12

let cachedKey: Buffer | null = null

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey

  if (fs.existsSync(KEYFILE_PATH)) {
    cachedKey = fs.readFileSync(KEYFILE_PATH)
    return cachedKey
  }

  // Auto-create directory and keyfile
  const dir = path.dirname(KEYFILE_PATH)
  fs.mkdirSync(dir, { recursive: true })
  const key = crypto.randomBytes(32)
  fs.writeFileSync(KEYFILE_PATH, key, { mode: 0o600 })
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

/** Returns true if the setting key should be encrypted (contains apiKey, token, or key) */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return lower.includes("apikey") || lower.includes("token") || lower.includes("key")
}
