import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IronsideBrand } from "../src/components/ironside-brand.js";

describe("Ironside brand mark", () => {
  it("renders the approved mark as a decorative image beside the product name", () => {
    const html = renderToStaticMarkup(createElement(IronsideBrand));

    expect(html).toContain('src="/brand/ironside-mark.png"');
    expect(html).toContain('alt=""');
    expect(html).toContain("ironside");
  });

  it("uses the approved mark for browser and home-screen icons", () => {
    const document = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(document).toContain('rel="icon" type="image/png" href="/brand/ironside-mark.png"');
    expect(document).toContain('rel="apple-touch-icon" href="/brand/ironside-mark.png"');
  });
});
