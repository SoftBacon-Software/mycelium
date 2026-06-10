// Content chunking for semantic memory.
// Embedding models reject input past their context window (ollama returns
// HTTP 400 "the input length exceeds the context length") — oversized docs
// are split into chunk rows (chunk_index 0..N) that each embed independently.

// Sized against nomic-embed-text's 2048-token window assuming token-DENSE
// text (paths, shell commands, markdown ≈ 2.5 chars/token — live calibration
// 2026-06-09: a 5602-char provisioning runbook still 400'd, while prose well
// past 6000 embedded fine). 4000 chars ≈ 1600 dense tokens leaves real
// margin. Tunable via the chunk_size config key.
export var DEFAULT_CHUNK_SIZE = 4000;

// Split text into chunks of at most maxLen chars. Cuts prefer paragraph
// boundaries, then line boundaries, with a hard split as the fallback.
// Lossless: chunks.join('') === text — separators stay with the preceding
// chunk, so re-index comparisons can reassemble the original doc.
export function chunkText(text, maxLen) {
  maxLen = maxLen || DEFAULT_CHUNK_SIZE;
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  if (text.length <= maxLen) return [text];

  var chunks = [];
  var pos = 0;
  // Don't take a boundary in the first half of the window — avoids
  // degenerate tiny chunks when a doc front-loads its blank lines.
  var minCut = Math.floor(maxLen / 2);

  while (text.length - pos > maxLen) {
    var window = text.slice(pos, pos + maxLen);
    var cut = window.lastIndexOf('\n\n');
    if (cut >= minCut) {
      cut += 2; // keep the separator with the preceding chunk
    } else {
      var nl = window.lastIndexOf('\n');
      cut = nl >= minCut ? nl + 1 : maxLen; // hard split fallback
    }
    chunks.push(window.slice(0, cut));
    pos += cut;
  }
  chunks.push(text.slice(pos));
  return chunks;
}
