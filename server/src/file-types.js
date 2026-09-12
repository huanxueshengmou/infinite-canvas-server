import { extname } from "node:path";

// A claimed browser MIME type must not turn an unsupported suffix into a preview.
const uploadTypes = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"],
  [".mp4", "video/mp4"], [".webm", "video/webm"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"], [".flac", "audio/flac"],
]);

export const uploadedMime = (filename) => uploadTypes.get(extname(filename || "").toLowerCase()) || "application/octet-stream";
