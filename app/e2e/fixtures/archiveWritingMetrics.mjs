import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deepStrictEqual } from 'node:assert/strict'
import { createHash } from 'node:crypto'

const [runDirectory, destination, mode] = process.argv.slice(2)
if (!runDirectory || !destination) throw new Error('Provide the run directory and aggregate destination.')
const files = await readdir(runDirectory, { recursive: true })
const records = await Promise.all(files.filter(file => file.endsWith('metrics.json')).map(async file =>
  JSON.parse(await readFile(join(runDirectory, file), 'utf8'))))
records.sort((left, right) => left.sceneCount - right.sceneCount)
deepStrictEqual(records.map(record => record.sceneCount), [100, 500, 1000])
if (mode !== '--verify') await writeFile(destination, JSON.stringify(records, null, 2) + '\n')
const archive = await readFile(destination)
deepStrictEqual(JSON.parse(archive.toString('utf8')), records)
console.log(JSON.stringify({ records: records.length, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), verified: true }))
