export interface FixtureScene { id: string; html: string }
export interface FixtureBook { scenes: FixtureScene[]; wordCount: number }
export interface WritingSeedHost { seed(book: FixtureBook): Promise<void> }

export async function seedWritingBook(
  h: WritingSeedHost,
  options: { sceneCount: number; wordCount: number; rich: boolean; longSceneWords?: number }
): Promise<FixtureBook> {
  const { sceneCount, wordCount, rich } = options
  if (sceneCount < 2 || wordCount < sceneCount) throw new Error('A writing fixture needs at least two nonempty scenes.')
  const scenes: FixtureScene[] = []
  const longCount = options.longSceneWords ?? Math.min(25_000, Math.max(1, Math.floor(wordCount / 4)))
  const remaining = wordCount - longCount
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#789"/><circle cx="320" cy="180" r="120" fill="#abc"/></svg>').toString('base64')
  for (let index = 0; index < sceneCount; index++) {
    const count = index === 0 ? longCount
      : Math.floor(remaining / (sceneCount - 1)) + (index <= remaining % (sceneCount - 1) ? 1 : 0)
    const paragraphs: string[] = []
    for (let start = 0; start < count; start += 80) {
      const words = Array.from({ length: Math.min(80, count - start) }, (_, offset) => `w${index}x${start + offset}`).join(' ')
      const annotated = rich && start === 0 && index % 10 === 0
        ? `<span class="nv-comment" data-comment-id="fixture-comment-${index}">${words}</span>` : words
      paragraphs.push(`<p>${rich && start === 0 ? `<b>${annotated}</b>` : annotated}</p>`)
    }
    if (rich && index % 10 === 0) paragraphs.push(`<p><img width="640" height="360" src="${image}"></p>`)
    scenes.push({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, html: paragraphs.join('') })
  }
  const book = { scenes, wordCount }
  await h.seed(book)
  return book
}
