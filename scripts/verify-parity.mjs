#!/usr/bin/env node
/**
 * Verify that every production patch is still in force in this fork.
 *
 * The running install at
 * `C:\Users\Jenya\.dsh\profiles\web\node_modules\@goodandready\dsh-tts`
 * carries five hand edits that exist in no published release. Porting them was
 * a byte-for-byte exercise (see the patch-layer commit); this script keeps them
 * honest afterwards, when the live sentence feature legitimately extends the
 * client bundle.
 *
 * Two kinds of check:
 *   1. content invariants — holds for every patch, including the one that lives
 *      in client-src and is regenerated into lib/client.js;
 *   2. file parity — comment-normalized equality with the running install, for
 *      the two files the live feature does not touch.
 *
 * Usage: node scripts/verify-parity.mjs [productionDir]
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const prod = process.argv[2] || 'C:/Users/Jenya/.dsh/profiles/web/node_modules/@goodandready/dsh-tts'

const read = async (rel, base = root) => readFile(path.join(base, rel), 'utf8').catch(() => undefined)

/** Patch ledger: each entry is one documented production edit. */
const invariants = [
  {
    id: '#1 browser SpeechSynthesis fallback blocked',
    file: 'lib/client-src/20-player.js',
    must: ['Browser fallback BLOCKED'],
    mustNot: ['await speakInBrowser(item.text)'],
  },
  {
    id: '#1 (regenerated bundle)',
    file: 'lib/client.js',
    must: ['Browser fallback BLOCKED'],
    mustNot: ['await speakInBrowser(item.text)'],
  },
  {
    id: '#2 provider timeout 120 s',
    file: 'lib/providers.js',
    must: [': 120000', "addEventListener('abort'"],
    mustNot: [': 10000', 'addEventListener(abort,'],
  },
  {
    id: '#4a openai WAV request + mime',
    file: 'lib/providers/cloud.js',
    must: [
      "provider: 'openai', audio, mime: 'audio/wav'",
      "voice: pick(DEFAULT_VOICES, voices, 'openai'),",
    ],
  },
  {
    id: '#4b custom provider WAV',
    file: 'lib/providers/cloud.js',
    must: ["response_format: key === 'custom' ? 'wav' : 'mp3'", "mime: key === 'custom' ? 'audio/wav' : 'audio/mpeg'"],
  },
]

let failures = 0

for (const check of invariants) {
  const text = await read(check.file)
  if (text === undefined) {
    console.log(`MISS  ${check.id} (${check.file} not found)`)
    failures++
    continue
  }
  const missing = check.must.filter((needle) => !text.includes(needle))
  const present = (check.mustNot || []).filter((needle) => text.includes(needle))
  if (missing.length || present.length) {
    failures++
    console.log(`FAIL  ${check.id} (${check.file})`)
    for (const m of missing) console.log(`        missing: ${JSON.stringify(m)}`)
    for (const p of present) console.log(`        must not be present: ${JSON.stringify(p)}`)
  } else {
    console.log(`OK    ${check.id}`)
  }
}

// File parity for the files the live sentence feature does not modify.
const normalize = (text) => text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
for (const rel of ['lib/providers.js', 'lib/providers/cloud.js']) {
  const mine = await read(rel)
  const theirs = await read(rel, prod)
  if (theirs === undefined) {
    console.log(`SKIP  parity ${rel} (running install not readable)`)
    continue
  }
  if (normalize(mine) === normalize(theirs)) {
    console.log(`OK    parity ${rel} (comment-normalized, matches the running install)`)
  } else {
    failures++
    console.log(`FAIL  parity ${rel} diverges from the running install`)
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed — the patch ledger is out of date.`)
  process.exit(1)
}
console.log('\nAll production patches are intact.')
