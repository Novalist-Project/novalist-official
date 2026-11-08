import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settingsStore'
import { EDITOR_SCOPES, normalizeEditorScope, type EditorScope } from '../../stores/stackedPaneIds'
import { updateEditorSetting } from '../../shell/commandContext'

/** Applies a writing-view scope at whichever settings scope the writer edits. */
export function setEditorScope(scope: EditorScope): void {
  updateEditorSetting({ editorScope: scope })
}

/** Scene, Chapter, Manuscript: how much of the book the writing view holds. */
export function EditorScopeSwitch(): React.JSX.Element {
  const { t } = useTranslation()
  const current = useSettingsStore((s) => normalizeEditorScope(s.view?.effective.editorScope))
  return (
    <div className="editor-scope-switch" role="radiogroup" aria-label={t('stackedEditor.scopeLabel')}>
      {EDITOR_SCOPES.map((scope) => (
        <button
          key={scope}
          type="button"
          role="radio"
          aria-checked={current === scope}
          className={`editor-scope-option${current === scope ? ' active' : ''}`}
          title={t(`stackedEditor.scopeHint.${scope}`)}
          onClick={() => setEditorScope(scope)}
        >
          {t(`stackedEditor.scope.${scope}`)}
        </button>
      ))}
    </div>
  )
}
