import { describe, expect, it } from "vitest";
import { applyProject, findProjectQuery } from "../src/projectSuggest";
import { parseQuickEntry } from "../src/quickEntry";

/** | marks the caret. */
function at(marked: string): { text: string; caret: number } {
  const caret = marked.indexOf("|");
  return { text: marked.slice(0, caret) + marked.slice(caret + 1), caret };
}
const find = (marked: string) => {
  const { text, caret } = at(marked);
  return findProjectQuery(text, caret);
};

describe("findProjectQuery", () => {
  it("finds a partial project token", () => {
    expect(find("Buy hooks @hang|")).toEqual({ start: 10, query: "hang" });
  });

  it("allows narrowing a multi-word project", () => {
    expect(find("Task @hang bath|")).toEqual({ start: 5, query: "hang bath" });
  });

  it("opens on a bare @", () => {
    expect(find("Task @|")).toEqual({ start: 5, query: "" });
  });

  it("does not treat email addresses or escaped @ as project syntax", () => {
    expect(find("mail me@home|")).toBeNull();
    expect(find("Task \\@hang|")).toBeNull();
  });

  it("stops at another NLP marker or a newline", () => {
    expect(find("Task @hang #home|")).toBeNull();
    expect(find("Task @hang\nmore|")).toBeNull();
  });
});

describe("applyProject", () => {
  it("completes the full existing name and leaves the task title intact", () => {
    const { text, caret } = at("Buy hooks @hang|");
    const q = findProjectQuery(text, caret)!;
    expect(applyProject(text, q, caret, "Hang bathroom mirror")).toEqual({
      text: "Buy hooks @Hang bathroom mirror ",
      caret: "Buy hooks @Hang bathroom mirror ".length,
    });
    expect(parseQuickEntry("Buy hooks @Hang bathroom mirror ", ["Hang bathroom mirror"]))
      .toMatchObject({ title: "Buy hooks", project: "Hang bathroom mirror" });
  });

  it("does not add a second space before following text", () => {
    const { text, caret } = at("Task @han| tomorrow");
    const q = findProjectQuery(text, caret)!;
    expect(applyProject(text, q, caret, "Hang bathroom mirror").text)
      .toBe("Task @Hang bathroom mirror tomorrow");
  });
});
