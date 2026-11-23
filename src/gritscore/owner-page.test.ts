import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.join(process.cwd(), "public", "gritscore", "index.html"), "utf8");
const adminHtml = readFileSync(path.join(process.cwd(), "public", "gritscore", "admin.html"), "utf8");
const css = readFileSync(path.join(process.cwd(), "public", "assets", "gritscore.css"), "utf8");

describe("GritScore owner page copy", () => {
  it("describes the public link without showing a raw slug placeholder", () => {
    expect(html).not.toContain("/score/&lt;slug&gt;");
    expect(html).toContain("clean link you can send to clients");
    expect(html).toContain("gritandgigs.in/score/");
  });

  it("uses an accessible, branded PDF picker", () => {
    expect(html).toContain('id="resumeFile"');
    expect(html).toContain('for="resumeFile"');
    expect(html).toContain("Choose PDF");
    expect(html).toContain("gs-file-picker");
  });

  it("uses the same branded picker for work-item proof files", () => {
    expect(html).toContain("data-file-picker");
    expect(html).toContain("data-file-action");
    expect(html).toContain("Choose file");
    expect(html).not.toContain('<input class="gs-input" type="file" data-field="file"');
  });

  it("keeps the owner photo visible on every card design tile", () => {
    expect(html).toContain("var designAvatarHtml = scan.photoUrl");
    expect(html).toContain('class="gs-design-avatar"');
    expect(html).toContain("GS.esc(initialsOf(scan.displayName))");
    expect(css).toContain(".gs-design-avatar img");
    expect(css).toContain("object-fit: cover");
  });

  it("tells owners that the score updates automatically", () => {
    expect(html).toContain("Score refreshes automatically");
    expect(html).toContain("Saving refreshes the score automatically");
  });

  it("tells admins that stored scores sync automatically", () => {
    expect(adminHtml).toContain("Changes apply automatically the next time a card is opened");
    expect(adminHtml).toContain("Stored scores refresh automatically");
  });
});
