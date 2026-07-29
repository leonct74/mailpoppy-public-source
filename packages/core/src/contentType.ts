// Map a filename to a MIME content type by extension. Used as a fallback when a
// file's declared type is missing or generic — the Tauri/WebView file picker
// sometimes hands us an empty `File.type`, and a generic
// "application/octet-stream" attachment makes Gmail (and others) refuse to
// preview/open it ("Unsupported file type"). Inferring from the extension keeps
// images, PDFs, docs, etc. openable on the receiving end.

const BY_EXT: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  avif: "image/avif",
  // documents
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  rtf: "application/rtf",
  json: "application/json",
  xml: "application/xml",
  ics: "text/calendar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // media
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Best-effort MIME type from a filename. Returns octet-stream if unknown. */
export function guessContentType(filename: string | undefined | null): string {
  if (!filename) return DEFAULT_CONTENT_TYPE;
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return DEFAULT_CONTENT_TYPE;
  const ext = filename.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Resolve the content type to use for an attachment: trust a specific declared
 * type, but fall back to extension-inference when it's missing or generic.
 */
export function resolveContentType(declared: string | undefined | null, filename: string | undefined | null): string {
  if (declared && declared !== DEFAULT_CONTENT_TYPE && declared.includes("/")) return declared;
  return guessContentType(filename);
}
