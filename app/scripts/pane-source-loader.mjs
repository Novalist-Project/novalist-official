import { loadRendererSource } from './renderer-source-loader.mjs'

export function loadPaneSources(globals = {}) {
  const migration = loadRendererSource('src/stores/writingLayoutMigration.ts', {
    '../shell/modes': loadRendererSource('src/shell/modes.ts')
  })
  const environment = { window: { novalist: {} }, ...globals }
  const panes = loadRendererSource('src/stores/shellPanes.ts', { './writingLayoutMigration': migration }, environment)
  return { panes, migration, environment }
}
