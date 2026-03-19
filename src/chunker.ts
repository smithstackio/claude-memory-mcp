export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
}

export function chunkFile(
  content: string,
  chunkSize: number = 80,
  overlap: number = 10
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  if (lines.length === 0) return chunks;

  if (lines.length <= chunkSize) {
    chunks.push({
      content,
      startLine: 1,
      endLine: lines.length,
      chunkIndex: 0,
    });
    return chunks;
  }

  let start = 0;
  let chunkIndex = 0;

  while (start < lines.length) {
    const end = Math.min(start + chunkSize, lines.length);
    chunks.push({
      content: lines.slice(start, end).join("\n"),
      startLine: start + 1,
      endLine: end,
      chunkIndex,
    });
    chunkIndex++;
    start += chunkSize - overlap;
    if (start >= lines.length) break;
  }

  return chunks;
}

export function extractSummary(content: string, filePath: string): string {
  // Try to find a block comment at the top of the file
  const blockCommentMatch = content.match(
    /^\s*\/\*\*?([\s\S]*?)\*\//
  );
  if (blockCommentMatch) {
    const comment = blockCommentMatch[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line.length > 0)
      .join(" ");
    if (comment.length > 0) {
      return comment.slice(0, 500);
    }
  }

  // Try Python/shell-style docstring or comment block
  const hashCommentLines: string[] = [];
  for (const line of content.split("\n").slice(0, 15)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) {
      hashCommentLines.push(trimmed.replace(/^#+\s*/, ""));
    } else if (hashCommentLines.length > 0) {
      break;
    }
  }
  if (hashCommentLines.length > 0) {
    return hashCommentLines.join(" ").slice(0, 500);
  }

  // Fallback: first 5 non-empty lines
  const firstLines = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 5)
    .join("\n");
  return firstLines.slice(0, 500);
}
