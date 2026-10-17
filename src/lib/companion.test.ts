import { describe, it, expect } from "vitest";
import {
  companionDisplayName,
  companionGreeting,
  companionSystemPrompt,
  confirmCardCopy,
  needsConfirm,
} from "./companion";

describe("companion identity", () => {
  it("names the assistant Gigi by default and self-identifies as AI in the greeting", () => {
    expect(companionDisplayName()).toBe("Gigi");
    const g = companionGreeting();
    expect(g).toContain("Gigi");
    expect(g).toContain("AI assistant");
  });

  it("personalises the greeting when a first name is given", () => {
    expect(companionGreeting("Asha")).toContain("Hi Asha");
  });

  it("system prompt hard-codes AI identity and forbids human claims", () => {
    const p = companionSystemPrompt();
    expect(p).toContain("You are an AI");
    expect(p).toContain("never claim to be human");
    expect(p).toContain("Gigi");
  });

  it("system prompt requires provenance labels for estimates", () => {
    expect(companionSystemPrompt()).toContain("label it an estimate");
  });
});

describe("confirm card gating", () => {
  it("requires confirmation for state-changing ui actions but not navigation", () => {
    expect(needsConfirm({ kind: "ui", id: "post-job" })).toBe(true);
    expect(needsConfirm({ kind: "navigate", id: "go-jobs" })).toBe(false);
  });

  it("confirm copy states that the user reviews before anything is submitted", () => {
    const c = confirmCardCopy({ label: "Open the post-job form" });
    expect(c.confirm).toBe("Continue");
    expect(c.body).toContain("Open the post-job form");
    expect(c.body).toContain("before anything is submitted");
  });
});
