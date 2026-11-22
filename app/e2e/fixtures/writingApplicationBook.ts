import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { seedWritingBook } from './writingBook'
import type { Harness } from '../harness'

const bookId = '00000000-0000-4000-9000-000000000001'
const draftId = '00000000-0000-4000-9000-000000000002'

export interface ApplicationWritingImages {
  src: string
  width: number
  height: number
  sceneIds: readonly string[]
}

export async function seedApplicationWritingBook(h: Harness, sceneCount: number) {
  const book = await seedWritingBook({ seed: async () => {} }, {
    sceneCount, wordCount: sceneCount * 1000, rich: true, longSceneWords: 25_000
  })
  const root = join(h.workDir, 'Synthetic performance project')
  const draftRoot = join(root, 'Book', 'Drafts', 'default')
  await mkdir(join(root, '.novalist'), { recursive: true })
  const embeddedImage = book.scenes[0].html.match(/src="(data:image\/svg\+xml;base64,([^"]+))"/)
  if (!embeddedImage) throw new Error('Synthetic performance book must include its SVG image')
  const images: ApplicationWritingImages = { src: 'novalist-project://nl/performance-image.svg', width: 640, height: 360,
    sceneIds: book.scenes.filter((_, index) => index % 10 === 0).map(scene => scene.id) }
  await writeFile(join(root, 'performance-image.svg'), Buffer.from(embeddedImage[2], 'base64'))
  const chapters = Array.from({ length: Math.ceil(sceneCount / 25) }, (_, index) => ({
    guid: `00000000-0000-4000-9001-${String(index + 1).padStart(12, '0')}`,
    title: `Chapter ${index + 1}`, folderName: `chapter-${index + 1}`, order: index + 1
  }))
  for (const chapter of chapters) {
    const folder = join(draftRoot, 'Chapters', chapter.folderName)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '.nvchapter.json'), JSON.stringify(chapter))
  }
  const scenes = book.scenes.map((scene, index) => ({
    ...scene, html: scene.html.replaceAll(embeddedImage[1], images.src), chapterGuid: chapters[Math.floor(index / 25)].guid,
    fileName: `${index + 1}.novalist`, title: `Scene ${index + 1}`, order: index % 25 + 1,
    wordCount: (scene.html.replace(/<[^>]*>/g, ' ').match(/\bw\d+x\d+\b/g) ?? []).length,
    comments: index % 10 === 0 ? [{ id: `fixture-comment-${index}`, anchorText: `w${index}x0`,
      text: 'Synthetic review note.', createdAt: '2026-01-01T00:00:00Z', author: 'Fixture reviewer', resolved: false }] : []
  }))
  for (const [index, scene] of scenes.entries()) {
    await writeFile(join(draftRoot, 'Chapters', chapters[Math.floor(index / 25)].folderName, scene.fileName),
      `<!--nv v=1 id=${scene.id} -->\n${scene.html}`)
  }
  await writeFile(join(root, '.novalist', 'project.json'), JSON.stringify({
    version: 3, id: 'performance-project', name: 'Synthetic performance project', activeBookId: bookId, worldBibleFolder: 'World Bible',
    books: [{ id: bookId, name: 'Book', folderName: 'Book', activeDraftId: draftId,
      drafts: [{ id: draftId, name: 'Draft 1', folderName: 'default' }] }]
  }))
  await writeFile(join(draftRoot, 'draft.json'), JSON.stringify({ chapters, acts: [] }))
  await writeFile(join(draftRoot, 'scenes.json'), JSON.stringify({
    chapters: Object.fromEntries(chapters.map(chapter => [chapter.guid,
      scenes.filter(scene => scene.chapterGuid === chapter.guid).map(({ html: _html, ...scene }) => scene)]))
  }))
  return { root, bookId, draftId, scenes, wordCount: book.wordCount, images }
}

export type ApplicationWritingBook = Awaited<ReturnType<typeof seedApplicationWritingBook>>
