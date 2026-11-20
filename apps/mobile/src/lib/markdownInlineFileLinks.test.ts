import { describe, expect, it } from "vite-plus/test";
import { resolveInlineCodeFileTarget } from "@t3tools/shared/markdownLinks";
import { confirmedInlineFileHref } from "./markdownLinks";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import {
  prepareNativeMarkdown,
  markdownForNativeParsing,
  markdownWithHtml,
} from "./markdownDocument";

const rewrite = (markdown: string) =>
  prepareNativeMarkdown(markdown, {
    cwd: "/repo",
    tableBreaks: false,
    inferInlineFiles: true,
  }).render(() => "file");
const markdownForNativeRendering = (markdown: string) =>
  prepareNativeMarkdown(markdownForNativeParsing(markdown), {
    cwd: "/repo",
    tableBreaks: true,
    inferInlineFiles: true,
  }).render(() => "file");

describe("absolute paths in prose", () => {
  it("become links without corrupting the source around them", () => {
    const path =
      "/tmp/claude-1000/-home-user--t3-worktrees-app-t3-abc123/session/scratchpad/notes.md";
    expect(rewrite(`Saved to ${path}.`)).toBe(`Saved to [notes.md](<${path}>).`);
    expect(
      markdownForNativeRendering("Intro /tmp/notes.md\n| a | c |\n|---|---|\n| `./a\\|b.ts` | b |"),
    ).toContain("[notes.md](</tmp/notes.md>)");
    expect(rewrite(String.raw`See \* and /tmp/notes.md.`)).toBe(
      String.raw`See \* and [notes.md](</tmp/notes.md>).`,
    );
    for (const decoded of [String.raw`See /tmp/a\_b.md.`, "See /tmp/a&copy;.md."])
      expect(rewrite(decoded)).toBe(decoded);
  });
});

describe("inline code that names a file", () => {
  it.each([
    [
      "file links",
      "See `src/math.ts:2`, `C:\\repo\\a.ts`, `./src/a&copy;.ts`, and [`./README.md`](readme).",
    ],
    [
      "tables",
      "Intro `src/math.ts:2`\n| `./README.md` | Fit |\n|---|---|\n| `./a.ts` | A |\n\nMore\n| a |\n|---|\n| b |",
    ],
    ["escaped pipe in file header", "Intro text\n| `./a\\|b.ts` | c |\n|---|---|\n| a | b |"],
    ["escaped pipe in file body", "Intro text\n| a | c |\n|---|---|\n| `./a\\|b.ts` | b |"],
    [
      "escaped pipe after a normal file span",
      "Intro `./normal.ts`\n| `./a\\|b.ts` | c |\n|---|---|\n| a | b |",
    ],
    [
      "unmatched delimiter before escaped pipe in header",
      "Intro `./normal.ts`\n| `x``./a\\|b.ts`` | c |\n|---|---|\n|a|b|",
    ],
    [
      "unmatched delimiter before escaped pipe in body",
      "Intro `./normal.ts`\n| a | c |\n|---|---|\n| `x``./a\\|b.ts`` | b |",
    ],
    ["tabbed quote header", ">\tIntro `./a.ts`\n>\t| `./b.ts` | c |\n>\t|---|---|\n>\t| a | b |"],
    ["lazy quote header", "> Intro\n`./README.md` | file\n> | - | - |\n> | ok | yes |"],
    ["lazy list header", "- Intro\n`./README.md` | file\n  | - | - |\n  | ok | yes |"],
    [
      "HTML",
      '<details>\n<summary>Files</summary>\n\nSee `src/math.ts:2`\n| `./README.md` |\n|---|\n| ok |\n<img alt="A &amp; B" src="https://example.com/a.png?a=1&amp;b=2">\n</details>',
    ],
    [
      "nested fences",
      '> - Example\n>   ````md\n>   ```ts\n>   `src/math.ts:2`\n>   <img src="literal.png">\n>   | a |\n>   |---|\n>   ```\n>   ````\n\nSee `./README.md`.',
    ],
    [
      "HTML fences",
      '<details>\n<summary>Example</summary>\n\n````md\n```html\n<img src="literal.png">\n```\n`src/math.ts`\n````\n\nSee `./README.md`\n</details>',
    ],
  ])("preserves the two-pass output for every streamed prefix: %s", (_name, fixture) => {
    for (const ending of ["\n", "\r\n", "\r"]) {
      const document = fixture.replaceAll("\n", ending);
      for (let length = 0; length <= document.length; length++) {
        const prefix = document.slice(0, length);
        const expected = previousTableBreaks(previousFileLinks(markdownWithHtml(prefix)));
        expect(markdownForNativeRendering(prefix), JSON.stringify(prefix)).toBe(expected);
      }
    }
  });

  it("renders verified paths and explicit names per occurrence in both native branches", async () => {
    const spans =
      "`AGENTS.md`, `GEMINI.md`, `config/AGENTS.md`, `config/GEMINI.md`, `config/rules/`";
    const path = "/scratch/config/AGENTS.md";
    for (const breakTables of [true, false]) {
      for (const href of ["config/AGENTS.md", path]) {
        const explicit = " [Instructions](" + href + ")";
        const document = prepareNativeMarkdown(spans + explicit, {
          cwd: "/scratch",
          tableBreaks: breakTables,
          inferInlineFiles: true,
        });
        expect(document.render()).toBe(spans + explicit);
        const markdown = document.render((target) => (target === path ? "file" : null));
        const native = await parseMarkdown(markdown);
        const links = native.children?.[0]?.children?.filter((node) => node.type === "Link");
        expect(links?.map((node) => [node.attributes?.url, node.children?.[0]?.content])).toEqual([
          [path, "config/AGENTS.md"],
          [href, "Instructions"],
        ]);
      }
      const streaming = prepareNativeMarkdown(spans, { tableBreaks: breakTables });
      expect(
        streaming.render(() => {
          throw new Error("streamed file lookup");
        }),
      ).toBe(spans);
    }
  });

  it("compacts only explicit path labels, including reference links to the same target", () => {
    const source =
      '`src/report.md` [src/report.md](src/report.md "original title") [Instructions](src/report.md) [other/report.md][]\n\n[other/report.md]: other/report.md';
    const document = prepareNativeMarkdown(source, { cwd: "/repo", tableBreaks: false });
    expect(document.render()).toBe(
      '`src/report.md` [report.md · repo/src](src/report.md "original title") [Instructions](src/report.md) [report.md · repo/other][other/report.md]\n\n[other/report.md]: other/report.md',
    );
  });

  it("renders verified Windows labels with the native parser's path handling", async () => {
    const path = String.raw`C:\Repo\_private\File[1].ts`;
    const native = await parseMarkdown(rewrite("`" + path + "`"), {
      preserveWindowsPaths: true,
      admonitions: true,
      hardSoftBreaks: false,
      latexMath: true,
    });
    const link = native.children?.[0]?.children?.[0];
    expect(link?.type).toBe("Link");
    expect(link?.children?.map((child) => child.content).join("")).toBe(path);
    expect(link?.attributes?.url).toBe(path);
  });

  it("becomes a link to the same path", () => {
    expect(rewrite("See `/tmp/claude-1000/...`.")).toBe("See `/tmp/claude-1000/...`.");
    expect(rewrite("See `bin/python3.12`.")).toBe("See [bin/python3.12](</repo/bin/python3.12>).");
    expect(rewrite("See `src/math.ts:2` and `./README.md`.")).toBe(
      "See [src/math.ts:2](</repo/src/math.ts:2>) and [./README.md](</repo/README.md>).",
    );
    for (const path of [
      "src/數學.ts:2",
      "數學/math.ts:2",
      "數學.ts:2",
      "src/數學.ts:2-4",
      "docker/Dockerfile",
      "/Users/me/Path Test/notes with spaces.md",
      "~/Library/Mobile Documents/notes.md",
    ]) {
      const paragraph = parser.parse(rewrite(`See \`${path}\`.`)).children[0];
      expect(paragraph?.type === "paragraph" && paragraph.children[1], path).toMatchObject({
        type: "link",
        url:
          path.startsWith("/") || path.startsWith("~/")
            ? path
            : "/repo/" + path.replace(/:2-4$/, ":2"),
        children: [{ type: "text", value: path }],
      });
    }
  });

  it("keeps commands, identifiers and URLs as code", () => {
    const markdown =
      "Run `vp test run`, `/usr/bin/python3 -m venv .venv`, call `useMemo`, open `https://example.com/a.ts`.";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("leaves fenced code blocks and code already inside a link alone", () => {
    const markdown = "```\nsrc/math.ts:2\n```\n\n[`src/math.ts`](src/math.ts)";
    expect(rewrite(markdown)).toBe(markdown.replace("[`src/math.ts`]", "[math.ts]"));
  });

  it("links to the exact path when it holds backslashes or ampersands", () => {
    for (const path of ["C:\\repo\\_private\\file.ts", "./src/a&copy;.ts", "./src/[id].ts"]) {
      const paragraph = parser.parse(rewrite(`\`${path}\``)).children[0];
      const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      expect(link?.type === "link" && link.url).toBe(path.replace(/^\.\//, "/repo/"));
      expect(
        link?.type === "link" && link.children[0]?.type === "text" && link.children[0].value,
      ).toBe(path);
    }
  });
});

// Separate link and table passes are the oracle for the combined pass on truncated Markdown.
const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = Root | RootContent;
function previousFileLinks(markdown: string): string {
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const target = resolveInlineCodeFileTarget(node.value, "/repo");
      const href = target && confirmedInlineFileHref(target, "file");
      if (start === undefined || end === undefined || !href) return;
      const escaped = href.replace(/[\\[\]&]/g, "\\$&");
      const label = node.value.replace(/[\\[\]\x60*_~|&<>]/g, (c) => "&#" + c.charCodeAt(0) + ";");
      edits.push({
        start,
        end,
        content: `[${label}](<${escaped}>)`,
      });
    } else if (node.type !== "link" && node.type !== "linkReference" && "children" in node)
      node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.toReversed())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

// A delimiter row such as `|---|:--:|`, possibly inside a blockquote or list item.
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// Cheap pre-check for a delimiter row two lines below text, so most messages skip the parse.
function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/**
 * GFM lets a table interrupt a paragraph, but the native parser (md4c) only starts a table
 * on a paragraph's first line, so a table right under a line of text renders as one
 * run-on paragraph. Insert the blank line md4c needs before each such table.
 */
function previousTableBreaks(markdown: string): string {
  if (!mayHaveTableUnderText(markdown)) return markdown;
  const lineStarts: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (!("children" in node)) return;
    node.children.forEach((child, index) => {
      const previous = node.children[index - 1];
      const start = child.position?.start;
      if (
        child.type === "table" &&
        previous?.type === "paragraph" &&
        start?.offset !== undefined &&
        previous.position?.end.line === start.line - 1
      )
        lineStarts.push(
          Math.max(
            markdown.lastIndexOf("\n", start.offset - 1),
            markdown.lastIndexOf("\r", start.offset - 1),
          ) + 1,
        );
      visit(child);
    });
  };
  visit(parser.parse(markdown));
  for (const lineStart of lineStarts.toReversed()) {
    // The header row may be a lazy line without its container markers (`>` or list indent),
    // so copy the delimiter row's markers onto the blank line and the header row.
    const [, header = "", cells = "", ending = "\n", markers = ""] =
      /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(markdown.slice(lineStart)) ?? [];
    markdown =
      markdown.slice(0, lineStart) +
      `${markers.trimEnd()}${ending}${markers}${cells}` +
      markdown.slice(lineStart + header.length + cells.length);
  }
  return markdown;
}
