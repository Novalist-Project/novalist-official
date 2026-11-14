import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function DeviceRecovery({ busy, recover }: { busy: boolean; recover(token: string): Promise<boolean> }): React.JSX.Element {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  return <details><summary>{t('collaboration.useRecoveryToken')}</summary>
    <p className="settings-hint">{t('collaboration.useRecoveryTokenHint')}</p>
    <label className="inspector-label" htmlFor="collaboration-restore-token">{t('collaboration.recoveryToken')}</label>
    <input id="collaboration-restore-token" className="dialog-input" type="password" value={token}
      autoComplete="off" spellCheck={false} disabled={busy} onChange={event => setToken(event.target.value)} />
    <button className="dialog-button primary" disabled={busy || !token.trim()} onClick={() => {
      void recover(token).then(ok => { if (ok) setToken('') })
    }}>{t('collaboration.recoverDevice')}</button>
  </details>
}
