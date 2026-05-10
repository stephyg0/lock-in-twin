import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(root, "..", "node_modules", "@mediapipe", "face_mesh");
const targetDir = join(root, "..", "public", "mediapipe", "face_mesh");

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

for (const file of readdirSync(sourceDir)) {
  if (/\.(js|wasm|binarypb|data|tflite)$/.test(file)) {
    copyFileSync(join(sourceDir, file), join(targetDir, file));
  }
}
