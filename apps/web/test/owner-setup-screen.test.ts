import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {}
}));

vi.mock("@/lib/owner-auth-api", () => ({
  loginOwner: vi.fn(),
  recoverOwner: vi.fn(),
  setupOwner: vi.fn()
}));

import { OwnerSetupScreen } from "../src/screens/owner-auth.js";

describe("OwnerSetupScreen", () => {
  it("explains Ironside and the first-time setup journey in beginner language", () => {
    const html = renderToStaticMarkup(createElement(OwnerSetupScreen, { onAuthenticated: () => undefined }));

    expect(html).toContain("Set up Ironside");
    expect(html).toContain("what your AI received");
    expect(html).toContain("Create your owner account");
    expect(html).toContain("Create a project");
    expect(html).toContain("Connect your AI app");
    expect(html).toContain("Open your first trace");
    expect(html).toContain("Step 1 of 4");
    expect(html).toContain("One-time setup code");
    expect(html).toContain("proves that you control this installation");
    expect(html).not.toContain("Owner control plane");
    expect(html).not.toContain("Setup capability");
  });
});
