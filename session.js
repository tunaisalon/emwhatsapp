// Shared handle so the web server can control the WhatsApp session.
let unlinkHandler = null;

export function registerUnlink(fn) { unlinkHandler = fn; }
export async function requestUnlink() {
  if (!unlinkHandler) throw new Error('Session not ready yet');
  return unlinkHandler();
}
