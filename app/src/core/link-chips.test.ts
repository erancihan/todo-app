import { describe, expect, it } from "vitest";
import { recognize } from "./link-chips";

/**
 * The label is derived from the URL's own structure, so these are pure and
 * exhaustive per host. If a service changes its URL scheme the chip degrades to
 * the hostname — wrong is worse than plain.
 */
describe("link recognition", () => {
  it("labels a GitHub issue as owner/repo#n", () => {
    expect(recognize("https://github.com/acme/app/issues/123").label).toBe("acme/app#123");
    expect(recognize("https://github.com/acme/app/pull/7").label).toBe("acme/app#7");
  });

  it("labels a bare GitHub repo as owner/repo", () => {
    expect(recognize("https://github.com/acme/app").label).toBe("acme/app");
  });

  it("labels GitLab issues and merge requests with their own sigils", () => {
    expect(recognize("https://gitlab.com/group/app/-/issues/45").label).toBe("app#45");
    expect(recognize("https://gitlab.com/group/sub/app/-/merge_requests/9").label).toBe("app!9");
  });

  it("labels a Jira ticket by its key", () => {
    expect(recognize("https://acme.atlassian.net/browse/PROJ-123").label).toBe("PROJ-123");
  });

  it("labels a Linear issue by its id", () => {
    expect(recognize("https://linear.app/acme/issue/ENG-42/fix-the-thing").label).toBe("ENG-42");
    expect(recognize("https://linear.app/acme/issue/ENG-42").label).toBe("ENG-42");
  });

  it("labels a Notion page by its title words", () => {
    expect(
      recognize("https://www.notion.so/acme/Meeting-Notes-8a2f0c1d9b3e4f5a8a2f0c1d9b3e4f5a").label,
    ).toBe("Meeting Notes");
  });

  it("falls back to the hostname for everything else", () => {
    expect(recognize("https://example.com/some/deep/path?q=1").label).toBe("example.com");
    expect(recognize("https://en.wikipedia.org/wiki/Garden").label).toBe("en.wikipedia.org");
  });

  it("drops trailing punctuation that belongs to the sentence", () => {
    const ref = recognize("https://example.com/page.");
    expect(ref.url).toBe("https://example.com/page");
  });

  it("does not invent labels from malformed input", () => {
    expect(recognize("https://").label).toBe("https://");
  });
});
