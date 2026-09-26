// Shared between the browser uploader (lib/upload-client.ts) and the server
// route (app/api/scans/[id]/upload/route.ts). No runtime dependencies so it
// is safe to import from both sides.

/**
 * Wire protocol version of the single-stream uploader. The browser sends it in
 * the `x-upload-client` header; the server rejects POSTs without it. A request
 * missing the header comes from an OLD cached bundle (the retired chunked
 * uploader that hit this URL with 16 MB slices and a `scans/undefined` id).
 */
export const UPLOAD_PROTOCOL = 'stream-v2'
export const UPLOAD_PROTOCOL_HEADER = 'x-upload-client'
