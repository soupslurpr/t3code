import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Chat links only the existing inline path and keeps its spelling",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("scratch", { "config/AGENTS.md": "Instructions\n" });
    const thread = await t3.thread({
      project,
      title: "Rules",
      messages: [
        "Compare `AGENTS.md`, `GEMINI.md`, `config/AGENTS.md`, `config/GEMINI.md`, `config/rules/` and [Instructions](config/AGENTS.md).",
      ],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent Compare/).tap();
    const confirmed = browser.locator(
      '[data-user-message-body] .chat-markdown-file-link[data-markdown-copy="`config/AGENTS.md`"]',
    );
    await expect(confirmed).toBeVisible();
    await app.screenshot("file-links");
    await expect(confirmed).toHaveText("config/AGENTS.md");
    await expect(screen.getByText("Instructions", { exact: true })).toBeVisible();
    await expect(browser.locator("[data-user-message-body] code")).toHaveCount(4);
    await expect(browser.locator("[data-user-message-body] .chat-markdown-file-link")).toHaveCount(
      2,
    );
  },
);
