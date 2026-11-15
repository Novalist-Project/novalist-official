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

Reconnecting also merges writing done while a device had no session, instead of
letting the server's copy replace it. When a persistent session ends, the device
saves the shared files and each shared document's Yjs state as a merge base.
On reconnect it compares that base with its local files: prose changes become Yjs
updates relative to the saved state, so they combine with everything the server
received meanwhile; Codex fields go through their field locks; structure and
assets use the JSON file merge. A CRDT never reports a conflict, so prose is also
diffed by paragraph against the base, and a paragraph, field, entry value or file
both sides changed differently is held back for the writer to choose. Undecided
choices are saved, so ending the session or quitting asks again on the next
reconnect. Without a saved base, every differing file is offered whole, since
nothing shows which side changed it.
