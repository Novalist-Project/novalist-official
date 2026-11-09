export interface FixtureScene { id: string; html: string }
export interface FixtureBook { scenes: FixtureScene[]; wordCount: number }
export interface WritingSeedHost { seed(book: FixtureBook): Promise<void> }

export async function seedWritingBook(
  h: WritingSeedHost,
  options: { sceneCount: number; wordCount: number; rich: boolean }
): Promise<FixtureBook> {
  const { sceneCount, wordCount, rich } = options
  if (sceneCount < 2 || wordCount < sceneCount) throw new Error('A writing fixture needs at least two nonempty scenes.')
  const scenes: FixtureScene[] = []
  // Reserve one quarter of the words for a long first scene.
  const longCount = Math.max(1, Math.floor(wordCount / 4))
  const remaining = wordCount - longCount
  for (let index = 0; index < sceneCount; index++) {
    const count = index === 0 ? longCount
      : Math.floor(remaining / (sceneCount - 1)) + (index <= remaining % (sceneCount - 1) ? 1 : 0)
    const paragraphs: string[] = []
    for (let start = 0; start < count; start += 80) {
      const words = Array.from({ length: Math.min(80, count - start) }, (_, offset) => `w${index}x${start + offset}`).join(' ')
      paragraphs.push(`<p>${rich && start === 0 ? `<b>${words}</b>` : words}</p>`)
    }
    if (rich && index % 10 === 0) paragraphs.push('<p><img width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></p>')
    scenes.push({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, html: paragraphs.join('') })
  }
  const book = { scenes, wordCount }
  await h.seed(book)
  return book
}
