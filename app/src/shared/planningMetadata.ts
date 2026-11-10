export const planningMetadataNotification = 'planning/metadataChanged'

const mutations = new Set([
  'project/createChapter', 'project/createScene', 'project/renameChapter', 'project/renameScene',
  'project/deleteChapter', 'project/deleteScene', 'project/restoreChapter', 'project/moveScenes',
  'project/reorderChapter', 'project/reorderScene', 'project/setChapterAct', 'project/setChapterStatus',
  'project/setChapterDescription', 'project/setChapterOpener', 'project/setChapterDateRange',
  'project/setSceneDateRange', 'scenes/setSynopsis', 'scenes/setPov', 'scenes/setGoalOutcome',
  'scenes/setInactive', 'scenes/setCast', 'scenes/setAnalysisOverride', 'scenes/resetAnalysisOverride',
  'scenes/restoreArchived', 'stages/set', 'stages/setSceneStage', 'labels/set', 'labels/setScene',
  'sceneBulk/delete', 'sceneBulk/archive', 'sceneBulk/setExportInclusion', 'sceneBulk/moveToChapter',
  'plot/toggle', 'plot/toggleCast', 'plot/deletePlotline', 'plot/setPlotlineDetail',
  'manuscriptProps/setDefinitions', 'manuscriptProps/setSceneValue', 'manuscriptProps/setChapterValue'
])

export function isPlanningMetadataMutation(method: string): boolean { return mutations.has(method) }
