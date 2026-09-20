import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile } from "./files.ts";
import { configDir } from "./paths.ts";

const GUARDRAILS_FILE_NAME = "guardrails.md";
const SECTION_PATTERN = /^## (.+)$/gm;

function section(markdown: string, key: string): string {
  const headings = [...markdown.matchAll(SECTION_PATTERN)];
  const headingIndex = headings.findIndex((heading) => heading[1] === key);
  if (headingIndex < 0) return "";
  const start =
    (headings[headingIndex].index ?? 0) + headings[headingIndex][0].length;
  const end = headings[headingIndex + 1]?.index ?? markdown.length;
  return markdown.slice(start, end).trim();
}

export async function loadGuardrails(): Promise<string> {
  try {
    return await readFile(join(configDir(), GUARDRAILS_FILE_NAME), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

export function guardrailsFor(markdown: string, modelId: string): string {
  const harness = modelId.split(":", 1)[0];
  return [section(markdown, harness), section(markdown, modelId)]
    .filter(Boolean)
    .join("\n\n");
}
