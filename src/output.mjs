import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function formatPayload(payload, format = 'markdown') {
  if (format === 'json') {
    return JSON.stringify(payload, null, 2) + '\n';
  }
  return extractMarkdown(payload) || JSON.stringify(payload, null, 2) + '\n';
}

export async function writeOutput(content, outputPath, { stdout = process.stdout, format = "markdown" } = {}) {
  if (!outputPath || outputPath === '-') {
    stdout.write(content);
    return;
  }
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  const label = format === "json" ? "JSON brief" : "brief";
  stdout.write(`Wrote ${label} to ${outputPath}\n`);
}

export function extractMarkdown(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.markdown,
    payload.summaryMarkdown,
    payload.brief,
    payload.summary,
    payload.content,
    payload.text,
    payload.result?.markdown,
    payload.result?.summaryMarkdown,
    payload.result?.brief,
    payload.result?.summary,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return found ? (found.endsWith('\n') ? found : `${found}\n`) : '';
}
