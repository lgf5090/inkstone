export class WebsshSession implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('The WebSSH session runtime is not implemented yet', { status: 501 })
  }
}
