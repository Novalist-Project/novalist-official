import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const git = promisify(execFile)
const prefix = 'app/src/renderer/public/editor/'

export const parityProse = [
  'Als die Glocken dreizehn schlugen, hatte Elara die Straße bereits zweimal ausradiert.',
  'Es war eine kleine Straße. Ein unscheinbarer Weg zwischen der alten Apotheke und dem Haus mit der blauen Tür. Wer hier jeden Morgen vorbeiging, konnte vierzig Jahre lang über das Kopfsteinpflaster laufen, ohne jemals nach ihrem Namen zu fragen. Gestern war sie noch da gewesen. Dessen war Elara sich sicher.',
  'Die Karte ihres Vaters behauptete etwas anderes.',
  'Sie beugte sich über den Schreibtisch. Das warme Licht der Lampe fiel auf vergilbtes Papier, auf verblasste Tinte und die sorgfältigen Linien eines Mannes, der seine Stadt besser gekannt hatte als jeder andere. Jede Gasse war eingezeichnet, jeder Hof und jeder Ort, an den die Stadt sich erinnern wollte.',
  '„Man kann einen Ort nicht einfach auslöschen“, sagte sie in den leeren Laden. „Nicht, ohne eine Spur zu hinterlassen.“'
].map(text => `<p>${text}</p>`).join('')

export async function buildLegacyBookLayout(): Promise<string> {
  const directory = resolve('out/writing-legacy-v3.7.2')
  const { stdout } = await git('git', ['ls-tree', '-r', '--name-only', 'v3.7.2', prefix], { cwd: resolve('..') })
  for (const path of stdout.trim().split(/\r?\n/)) {
    const { stdout: content } = await git('git', ['show', `v3.7.2:${path}`], { cwd: resolve('..'), maxBuffer: 4 * 1024 * 1024 })
    const destination = resolve(directory, path.slice(prefix.length))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
  return pathToFileURL(resolve(directory, 'editor.html')).href
}
