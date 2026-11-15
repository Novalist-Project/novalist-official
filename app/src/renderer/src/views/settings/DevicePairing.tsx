import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpc } from '../../rpc/client'
import type { CollaborationAccount } from '../../collaboration/useCollaborationAccount'

interface PairingRequest { request: string; deviceName: string; fingerprint: string; expiresAt: string }

function usePairingAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async <T,>(operation: () => Promise<T>, accept: (value: T) => void): Promise<void> => {
    if (active.current) return
    active.current = true; setBusy(true); setError('')
    try { const value = await operation(); if (mounted.current) accept(value) }
    catch (reason) { if (mounted.current) setError(String(reason)) }
    finally { active.current = false; if (mounted.current) setBusy(false) }
  }
  return { busy, error, run }
}

function PairingIdentity({ pairing }: { pairing: PairingRequest }): React.JSX.Element {
  const { t } = useTranslation()
  return <>
    <p>{t('collaboration.pairingDevice', { name: pairing.deviceName })}</p>
    <p>{t('collaboration.pairingFingerprint', { fingerprint: pairing.fingerprint })}</p>
    <p className="settings-hint">{t('collaboration.pairingExpires', { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</p>
  </>
}

export function DevicePairingRequest({ server, disabled, onPaired }: {
  server: string; disabled: boolean; onPaired(account: CollaborationAccount): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [pairing, setPairing] = useState<PairingRequest | null>(null)
  const action = usePairingAction()
  const busy = disabled || action.busy
  return <details><summary>{t('collaboration.pairingRequestTitle')}</summary>
    <p className="settings-hint">{t('collaboration.pairingRequestHint')}</p>
    {pairing ? <>
      <PairingIdentity pairing={pairing} />
      <label className="inspector-label" htmlFor="device-pairing-request">{t('collaboration.pairingRequest')}</label>
      <textarea id="device-pairing-request" className="dialog-input" readOnly value={pairing.request}
        autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} />
      <div className="settings-button-row">
        <button className="dialog-button primary" disabled={busy} onClick={() => void action.run(
          () => rpc.request<CollaborationAccount>('collaboration/account/completeDevicePairing', [server]), onPaired
        )}>{t('collaboration.pairingCheck')}</button>
        <button className="dialog-button" disabled={busy} onClick={() => setPairing(null)}>{t('collaboration.pairingBack')}</button>
      </div>
    </> : <>
      <label className="inspector-label" htmlFor="device-pairing-name">{t('collaboration.pairingName')}</label>
      <input id="device-pairing-name" className="dialog-input" value={name} maxLength={80} disabled={busy}
        onChange={event => setName(event.target.value)} />
      <button className="dialog-button" disabled={busy || !name.trim()} onClick={() => void action.run(
        () => rpc.request<PairingRequest>('collaboration/account/createDevicePairing', [server, name.trim()]), setPairing
      )}>{t('collaboration.pairingGenerate')}</button>
    </>}
    {action.error && <p role="alert">{action.error}</p>}
  </details>
}

export function DevicePairingApproval({ server, disabled }: { server: string; disabled: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [request, setRequest] = useState('')
  const [preview, setPreview] = useState<PairingRequest | null>(null)
  const [approved, setApproved] = useState(false)
  const action = usePairingAction()
  const busy = disabled || action.busy
  return <details><summary>{t('collaboration.pairingApproveTitle')}</summary>
    <p className="settings-hint">{t('collaboration.pairingApproveHint')}</p>
    <label className="inspector-label" htmlFor="device-pairing-approval">{t('collaboration.pairingRequest')}</label>
    <textarea id="device-pairing-approval" className="dialog-input" value={request} disabled={busy} autoComplete="off" spellCheck={false}
      onChange={event => { setRequest(event.target.value); setPreview(null); setApproved(false) }} />
    {preview ? <>
      <PairingIdentity pairing={preview} />
      {approved ? <p role="status">{t('collaboration.pairingApproved')}</p> : <>
        <p className="settings-hint">{t('collaboration.pairingCompare')}</p>
        <button className="dialog-button primary" disabled={busy} onClick={() => void action.run(
          () => rpc.request<boolean>('collaboration/account/approveDevicePairing', [server, preview.request]), () => setApproved(true)
        )}>{t('collaboration.pairingApprove')}</button>
      </>}
    </> : <button className="dialog-button" disabled={busy || !request.trim()} onClick={() => void action.run(
      () => rpc.request<PairingRequest>('collaboration/account/reviewDevicePairing', [server, request.trim()]), setPreview
    )}>{t('collaboration.pairingReview')}</button>}
    {action.error && <p role="alert">{action.error}</p>}
  </details>
}
