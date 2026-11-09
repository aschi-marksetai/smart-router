import dashboardPage from "./dashboard.html" with { type: "text" };
// @ts-expect-error Bun text import
import preferencesTemplate from "../templates/preferences.md" with { type: "text" };
// @ts-expect-error Bun text import
import preferencesInterviewTemplate from "../templates/preferences-interview.md" with { type: "text" };
// @ts-expect-error Bun text import
import guardrailsTemplate from "../templates/guardrails.md" with { type: "text" };
// @ts-expect-error Bun text import
import skill from "../skill/SKILL.md" with { type: "text" };
import packageJson from "../package.json" with { type: "json" };

export {
  guardrailsTemplate,
  preferencesInterviewTemplate,
  preferencesTemplate,
  skill,
};
export const version = packageJson.version;

// Bun types HTML imports as bundles even when imported as text.
export const dashboardHtml = String(dashboardPage);
