/** Historical architecture experiments use rewritten fixture sources, not the shipped app. */
export const writingResearchSpecs = [
  'writing-comments', 'writing-continuous-paper', 'writing-css-origin', 'writing-css-paper',
  'writing-feasibility', 'writing-focus-scroll', 'writing-fragment-adapter', 'writing-fragment-layout',
  'writing-fragment-paragraph', 'writing-fragment-zoom', 'writing-fragments', 'writing-page-flow',
  'writing-presentation', 'writing-surface'
].map(name => `**/${name}.spec.ts`)
