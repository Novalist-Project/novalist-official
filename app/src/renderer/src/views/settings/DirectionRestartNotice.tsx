import { RotateCw } from 'lucide-react'
import { restartForUiDirection, useUiDirectionStore } from '../../stores/uiDirectionStore'

/**
 * Shown under the interface language while the menu bar still draws in the
 * other direction. Windows and Linux read that direction once at launch, so
 * only a restart brings the menus in line.
 */
export function DirectionRestartNotice({ t }: { t: (key: string) => string }): React.ReactNode {
  const needed = useUiDirectionStore((state) => state.restartNeeded)
  if (!needed) return null
  return (
    <div className="settings-restart-notice" role="status">
      <RotateCw size={14} aria-hidden="true" />
      <span className="settings-hint">{t('settings.uiDirectionRestart')}</span>
      <button className="dialog-button" onClick={restartForUiDirection}>
        {t('settings.uiDirectionRestartNow')}
      </button>
    </div>
  )
}
