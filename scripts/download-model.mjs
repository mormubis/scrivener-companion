import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const MODEL_DIR = "model";
const MODEL_ID = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

// files required by @huggingface/transformers
const FILES = [
  { url: `${BASE}/config.json`, dest: "config.json" },
  { url: `${BASE}/tokenizer.json`, dest: "tokenizer.json" },
  { url: `${BASE}/tokenizer_config.json`, dest: "tokenizer_config.json" },
  { url: `${BASE}/onnx/model.onnx`, dest: "onnx/model.onnx" },
];

fs.mkdirSync(path.join(MODEL_DIR, "onnx"), { recursive: true });

for (const file of FILES) {
  const dest = path.join(MODEL_DIR, file.dest);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    console.log(`${file.dest} already exists, skipping`);
    continue;
  }
  console.log(`Downloading ${file.dest}...`);
  await download(file.url, dest);
  const size = fs.statSync(dest).size;
  console.log(`  -> ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        // handle relative redirects
        const location = res.headers.location.startsWith("/")
          ? new URL(res.headers.location, url).href
          : res.headers.location;
        return download(location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}
