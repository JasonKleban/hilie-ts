import type { RecordSpan, EntitySpan } from './types.js'

export async function* linesFromChunks(
  source: AsyncIterable<string>
): AsyncGenerator<string, void, unknown> {
  let buffer = "";

  for await (const chunk of source) {
    buffer += chunk;

    while (true) {
      const idx = buffer.search(/\r\n|\n|\r/);
      if (idx === -1) break;

      const match = buffer.match(/\r\n|\n|\r/);
      if (!match || match.index === undefined) break;

      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield line;
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

export async function* recordsByIndentation(
  source: AsyncIterable<string>
): AsyncGenerator<string[], void, unknown> {
  let indentFloor: number | null = null;
  let current: string[] | null = null;

  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote: '"' | "'" | null = null;

  for await (const rawLine of source) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();

    if (trimmed === "") {
      if (current) current.push(line);
      continue;
    }

    const indent = (line.match(/^[\t ]*/)?.[0].length) ?? 0;

    if (indentFloor === null || indent < indentFloor) {
      indentFloor = indent;
    }

    const balanced =
      paren === 0 &&
      brace === 0 &&
      bracket === 0 &&
      quote === null;

    const isTopLevel =
      indent === indentFloor &&
      balanced;

    if (isTopLevel) {
      if (current) {
        yield current;
      }
      current = [line];
    } else {
      if (!current) {
        current = [line];
      } else {
        current.push(line);
      }
    }

    updateDelimiterState(line);
  }

  if (current) {
    yield current;
  }

  function updateDelimiterState(text: string) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (quote) {
        if (ch === quote && text[i - 1] !== "\\") {
          quote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      switch (ch) {
        case "(":
          paren++;
          break;
        case ")":
          paren = Math.max(0, paren - 1);
          break;
        case "{":
          brace++;
          break;
        case "}":
          brace = Math.max(0, brace - 1);
          break;
        case "[":
          bracket++;
          break;
        case "]":
          bracket = Math.max(0, bracket - 1);
          break;
      }
    }
  }
}

// Synchronous helper: split lines array into a list of records (startLine/endLine + lines)
export function splitIntoRecordsFromLines(lines: string[]): { startLine: number; endLine: number; lines: string[] }[] {
  let indentFloor: number | null = null;
  let current: { startLine: number; lines: string[] } | null = null;

  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote: '"' | "'" | null = null;

  const out: { startLine: number; endLine: number; lines: string[] }[] = [];

  function updateDelimiterState(text: string) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (quote) {
        if (ch === quote && text[i - 1] !== "\\") {
          quote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      switch (ch) {
        case "(":
          paren++;
          break;
        case ")":
          paren = Math.max(0, paren - 1);
          break;
        case "{":
          brace++;
          break;
        case "}":
          brace = Math.max(0, brace - 1);
          break;
        case "[":
          bracket++;
          break;
        case "]":
          bracket = Math.max(0, bracket - 1);
          break;
      }
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li] ?? "";
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();

    if (trimmed === "") {
      if (current) current.lines.push(line);
      updateDelimiterState(line);
      continue;
    }

    const indent = (line.match(/^[\t ]*/)?.[0].length) ?? 0;

    if (indentFloor === null || indent < indentFloor) {
      indentFloor = indent;
    }

    const balanced = paren === 0 && brace === 0 && bracket === 0 && quote === null;
    const isTopLevel = indent === indentFloor && balanced;

    if (isTopLevel) {
      if (current) {
        out.push({ startLine: current.startLine, endLine: li - 1, lines: current.lines.slice() });
      }
      current = { startLine: li, lines: [line] };
    } else {
      if (!current) {
        current = { startLine: li, lines: [line] };
      } else {
        current.lines.push(line);
      }
    }

    updateDelimiterState(line);
  }

  if (current) {
    out.push({ startLine: current.startLine, endLine: lines.length - 1, lines: current.lines.slice() });
  }

  return out;
}

// Build minimal RecordSpan[] from split records (single sub-entity, no fields)
export function recordsFromLines(lines: string[]): RecordSpan[] {
  const blocks = splitIntoRecordsFromLines(lines);

  const offsets: number[] = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(off);
    off += (lines[i]?.length ?? 0) + 1;
  }

  const recs: RecordSpan[] = [];
  for (const b of blocks) {
    const fileStart = offsets[b.startLine] ?? 0;
    const fileEnd = (offsets[b.endLine] ?? 0) + ((lines[b.endLine] ?? "").length ?? 0);
    const entities: EntitySpan[] = [
      { startLine: b.startLine, endLine: b.endLine, fileStart, fileEnd, entityType: 'Unknown', fields: [] }
    ];
    recs.push({ startLine: b.startLine, endLine: b.endLine, fileStart, fileEnd, entities });
  }

  return recs;
}
