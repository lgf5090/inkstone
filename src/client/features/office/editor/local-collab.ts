/**
 * The socket the collaboration client insists on, answered by nothing.
 *
 * `UniverCollaborationClientPlugin` refuses to construct without a `socketService`, and its job here is
 * only to enable the history panel: this deployment has no collaboration server, so `createSocket`
 * returns `null` — the documented "no socket" answer — instead of opening a connection that would fail
 * on every heartbeat. Nothing in this app exchanges edits with a server; saving goes through our own
 * revision API.
 */
export class OfficeLocalCollaborationSocket {
  async createSocket(): Promise<null> {
    return null
  }
}
