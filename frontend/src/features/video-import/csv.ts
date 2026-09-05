import { canonicalCards, parseQuantity } from './snapshot'
import type { CatalogCard, OwnedEntry, Snapshot } from './types'

export const CSV_HEADER = ['Id', 'CardName', 'InternalId', 'NumberOwned', 'Expansion', 'Pack', 'Rarity', 'Collected'] as const
const MAX_CSV_LENGTH = 20_000_000

/** Small RFC 4180 reader: quotes, escaped quotes, BOM, CRLF and embedded newlines. */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_CSV_LENGTH) {
    throw new Error('CSV exceeds the 20 MB text limit.')
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  const input = text.replace(/^\uFEFF/, '')
  const finishRow = () => {
    row.push(field)
    if (row.length > 32) {
      throw new Error('CSV has too many columns.')
    }
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row)
    }
    if (rows.length > 50_000) {
      throw new Error('CSV has too many rows.')
    }
    row = []
    field = ''
    closedQuote = false
  }
  for (let i = 0; i < input.length; i++) {
    const character = input[i]
    if (quoted) {
      if (character === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (character === '"') {
        quoted = false
        closedQuote = true
      } else {
        field += character
      }
    } else if (character === ',') {
      row.push(field)
      if (row.length > 32) {
        throw new Error('CSV has too many columns.')
      }
      field = ''
      closedQuote = false
    } else if (character === '\n' || character === '\r') {
      finishRow()
      if (character === '\r' && input[i + 1] === '\n') {
        i++
      }
    } else if (character === '"' && field === '' && !closedQuote) {
      quoted = true
    } else if (closedQuote || character === '"') {
      throw new Error('Malformed CSV quoting.')
    } else {
      field += character
    }
  }
  if (quoted) {
    throw new Error('CSV contains an unterminated quoted field.')
  }
  finishRow()
  return rows
}

export function readBaseline(text: string, cards: readonly CatalogCard[]): { entries: Map<number, OwnedEntry>; warnings: string[] } {
  const [header, ...rows] = parseCsv(text)
  if (!header || rows.length === 0) {
    throw new Error('CSV contains no collection rows.')
  }
  const names = header.map((name) => name.trim())
  if (new Set(names).size !== names.length) {
    throw new Error('CSV has duplicate column names.')
  }
  for (const required of ['Id', 'InternalId', 'NumberOwned', 'Collected']) {
    if (!names.includes(required)) {
      throw new Error(`Missing required CSV column: ${required}`)
    }
  }
  const byId = new Map(cards.map((card) => [card.card_id, card]))
  const entries = new Map<number, OwnedEntry>()
  const warnings: string[] = []
  for (const [index, row] of rows.entries()) {
    if (row.length !== names.length) {
      throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`)
    }
    const get = (name: string) => row[names.indexOf(name)].trim()
    const id = get('Id')
    const card = byId.get(id)
    if (!card) {
      throw new Error(`Unknown card ${id} at CSV row ${index + 2}. Update the catalogue; no rows were discarded.`)
    }
    const oldId = parseQuantity(get('InternalId'))
    if (oldId !== card.internal_id) {
      warnings.push(`${id}: remapped old InternalId ${oldId} to catalogue ID ${card.internal_id}.`)
    }
    const quantity = parseQuantity(get('NumberOwned'))
    const collectedText = get('Collected').toUpperCase()
    if (!['TRUE', 'FALSE', '1', '0'].includes(collectedText)) {
      throw new Error(`Invalid Collected flag at CSV row ${index + 2}.`)
    }
    const collected = collectedText === 'TRUE' || collectedText === '1'
    const existing = entries.get(card.internal_id)
    if (existing && (existing.quantity !== quantity || existing.collected !== collected)) {
      throw new Error(`Conflicting quantities or Collected flags for linked card ${id}. Fix the baseline before importing.`)
    }
    entries.set(card.internal_id, { quantity, collected })
  }
  return { entries, warnings }
}

function escapeField(value: string | number | boolean): string {
  const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)
  // Catalogue text should not become spreadsheet formulas when the CSV is opened.
  const safe = /^(?:\s*[=+@\-]|[\t\r])/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** One row per ownership key avoids conflicting writes for linked artwork aliases. */
export function exportCsv(snapshot: Snapshot, cards: readonly CatalogCard[]): string {
  const catalogue = canonicalCards(cards)
  const rows: (string | number | boolean)[][] = [[...CSV_HEADER]]
  for (const [internalId, entry] of snapshot) {
    const card = catalogue.get(internalId)
    if (!card) {
      throw new Error(`Cannot export unknown catalogue ID ${internalId}.`)
    }
    if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 0) {
      throw new Error(`Cannot export invalid quantity for ${internalId}.`)
    }
    rows.push([card.card_id, card.name, internalId, entry.quantity, card.expansion, card.pack, card.rarity, entry.collected])
  }
  return `\uFEFF${rows.map((row) => row.map(escapeField).join(',')).join('\r\n')}\r\n`
}
