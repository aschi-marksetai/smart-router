import { expect, test } from "bun:test";
import {
  parseClaudeCatalog,
  parseCodexModels,
  parseOpenRouterModels,
  parsePiRegistry,
} from "../src/enumerate.ts";

test("parses the Claude catalog cache fixture", () => {
  const fixture = {
    catalog: {
      config: {
        models: [
          {
            id: "claude-x",
            short_name: "x",
            thinking: { effort_options: [{ id: "low" }, { id: "high" }] },
          },
        ],
      },
    },
  };
  expect(parseClaudeCatalog(fixture)).toEqual([
    {
      id: "claude:claude-x",
      model: "claude-x",
      name: "x",
      efforts: ["low", "high"],
    },
  ]);
});

test("parses public Codex debug models fixtures", () => {
  const fixture = [
    {
      slug: "gpt-x",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }],
    },
    { slug: "hidden", visibility: "hide" },
  ];
  expect(parseCodexModels(fixture)).toEqual([
    { id: "codex:gpt-x", model: "gpt-x", name: "gpt-x", efforts: ["medium"] },
  ]);
});

test("parses the OpenRouter models fixture", () => {
  expect(
    parseOpenRouterModels({ data: [{ id: "deepseek/x", name: "DeepSeek X" }] }),
  ).toEqual([
    {
      id: "pi:openrouter/deepseek/x",
      model: "openrouter/deepseek/x",
      name: "DeepSeek X",
      efforts: ["medium"],
    },
  ]);
});

test("parses the pi-ai registry fixture", () => {
  expect(
    parsePiRegistry("google", [
      { id: "gemini", name: "Gemini", reasoning: true },
    ]),
  ).toEqual([
    {
      id: "pi:google/gemini",
      model: "google/gemini",
      name: "Gemini",
      efforts: ["low", "medium", "high"],
    },
  ]);
});
