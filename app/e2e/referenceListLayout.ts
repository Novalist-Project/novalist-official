import { expect, type Locator } from '@playwright/test'

/**
 * A reference list reads as a list of checkboxes: each box at its native size,
 * its entry name beside it on the same row, and the name on one line when the
 * row has room for it, otherwise wrapped as words rather than a column of
 * single letters. Returns the names that had room for one line.
 */
export async function expectReadableReferenceList(group: Locator): Promise<string[]> {
  await expect(group.getByRole('checkbox').first()).toBeVisible()
  const rows = await group.locator('label').evaluateAll(labels => labels.map(label => {
    const input = label.querySelector('input')!
    const box = input.getBoundingClientRect()
    const inputStyle = getComputedStyle(input)
    const nameElement = label.querySelector('bdi')!
    const name = nameElement.getBoundingClientRect()
    nameElement.style.whiteSpace = 'nowrap'
    const natural = nameElement.getBoundingClientRect().width
    nameElement.style.whiteSpace = ''
    const room = label.getBoundingClientRect().width - box.width - parseFloat(inputStyle.marginLeft)
      - parseFloat(inputStyle.marginRight) - parseFloat(getComputedStyle(label).columnGap)
    return {
      text: nameElement.textContent ?? '',
      fontSize: parseFloat(getComputedStyle(nameElement).fontSize),
      fits: natural <= room,
      box: { width: box.width, height: box.height, top: box.top, bottom: box.bottom },
      name: { width: name.width, height: name.height, top: name.top, bottom: name.bottom }
    }
  }))
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const where = `entry "${row.text}"`
    expect(row.box.width, `${where}: checkbox width`).toBeGreaterThan(row.fontSize / 2)
    expect(row.box.width, `${where}: checkbox width`).toBeLessThanOrEqual(row.fontSize * 2)
    expect(row.box.height, `${where}: checkbox height`).toBeLessThanOrEqual(row.fontSize * 2)
    expect(Math.abs(row.box.width - row.box.height), `${where}: checkbox is square`).toBeLessThanOrEqual(2)
    expect(row.name.top < row.box.bottom && row.name.bottom > row.box.top, `${where}: name beside its checkbox`).toBe(true)
    if (row.fits) {
      expect(row.name.height, `${where}: name on one line`).toBeLessThan(row.fontSize * 2)
    } else {
      expect(row.name.width, `${where}: name wraps as words`).toBeGreaterThan(row.fontSize * 3)
    }
  }
  expect(await group.evaluate(element => element.scrollWidth <= element.clientWidth), 'no horizontal scrollbar').toBe(true)
  return rows.filter(row => row.fits).map(row => row.text)
}
