# Offer persistent hosting alongside live relay sessions

On 2026-11-08 the user approved integrating the persistent implementation from
the `novalist-sync-server` repository alongside existing relay collaboration. This supersedes ADR 0007's
blanket prohibition on server storage: **Persistent server** stores encrypted
checkpoints and updates and supports joining and catching up while the owner is
offline; **Relay server** still forwards packets only and requires a live host.

The two modes share the existing editor, encrypted session model, field leases,
presence and local project copies. They use separate desktop entry points and
saved connection records so a relay project cannot silently switch to server
storage. Persistent hosting requires account sign-in and verified device
enrollment with fresh MFA. On servers that accept key-bound proofs, the first
sign-in on a device enrolls it in the same browser visit: the client creates its
identities first and derives the sign-in nonce from their public keys. Project keys and recovery identities stay in the
client's secure credential store. Membership removal rotates the encryption
epoch against a server-reserved history boundary before publishing a new
checkpoint. Compaction reuses that boundary without a key change, so any writer
can replace old history with a checkpoint; a pointer item in the log names the
newest checkpoint for devices that start after the boundary. Reconnecting preserves local differences in a recovery archive.
