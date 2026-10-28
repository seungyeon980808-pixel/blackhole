/**
 * 2026-10-28 사용자 요청: 기억에 알아서 태그를 달고 날짜·주제별로. 규칙 태그(0원), 같은 주제는 같은 태그,
 * 날짜별·주제별 묶음, 같은 태그 안 비슷한 기록은 한 줄 요약, 태그 이름 바꾸기·합치기·지우기, 「#진도」 거르기.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, sharedFrom, type Memo } from "../src/calendar/model";
import { classTags, dateGroup, ruleTags, summaries } from "../src/calendar/tags";

const note = (id: string, title: string, at: string, details?: string): Memo => ({ id, kind: "note", title, details, area: "school", source: "t", createdAt: at });

describe("rule tags (0원)", () => {
  it("학반 and school topics; the same topic always the same tag; 받아쓰기 「오반」 read as 5반", () => {
    expect(ruleTags("2학년 3반 진도 종료")).toEqual(["진도", "2-3"]);
    expect(ruleTags("2-4 진도 3단원까지")).toEqual(["진도", "2-4"]);
    expect(ruleTags("오반도 진도 종료")).toEqual(["진도", "5반"]);
    expect(ruleTags("교원학습공동체 신청자 13명 명단")).toEqual(["명단", "전학공"]);
    expect(ruleTags("교무기획과-9184 공문 회신")).toEqual(["공문"]);
    expect(ruleTags("방과후 수행평가 채점 기준")).toEqual(["수행평가", "방과후", "시험"]);
    expect(ruleTags("교무실 와이파이 비밀번호")).toEqual(["계정"]);
    expect(classTags("3학년 1반, 3학년 2반")).toEqual(["3-1", "3-2"]);
  });

  it("date groups: 오늘 · 어제 · 이번 주 · 지난주 · 이번 달 · 그 이전 (week from Sunday)", () => {
    const t = "2026-10-28"; // Wednesday
    expect(["2026-10-28", "2026-10-27", "2026-10-25", "2026-10-20", "2026-10-03", "2026-09-30"].map((d) => dateGroup(d, t))).toEqual(["오늘", "어제", "이번 주", "지난주", "이번 달", "그 이전"]);
  });

  it("like records under one tag in one line, without AI", () => {
    const sums = summaries([note("a", "2학년 3반 진도 종료", "x"), note("b", "2학년 4반 진도 종료", "x"), note("c", "2-5 진도 종료", "x"), note("d", "3학년 1반 진도 3단원까지", "x")]);
    expect(sums).toEqual([{ key: "진도 종료", classes: ["2-3", "2-4", "2-5"], ids: ["a", "b", "c"] }]);
  });

  it("tags stay on the Mac: not in 달력.json", () => {
    const s = emptyState();
    s.notes.push({ ...note("n1", "진도", "2026-10-28T09:00"), tags: ["진도"] });
    expect("tags" in sharedFrom(s, "x").notes[0]).toBe(false);
  });
});

let app: BlackholeApp | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => {
  app?.destroy();
  app = null;
});

describe("기억 보기", () => {
  async function mount() {
    const s = emptyState();
    s.settings.theme = "glass";
    s.notes.push(
      note("n1", "2학년 3반 진도 종료", "2026-10-28T09:00"),
      note("n2", "2학년 4반 진도 종료", "2026-10-27T09:00"),
      note("n3", "교원학습공동체 신청자 13명", "2026-10-20T09:00", "김OO, 이OO, 박OO …"),
      note("n4", "주차 위치 B2 기둥 14", "2026-09-30T09:00")
    );
    const adapter = memoryAdapter();
    await adapter.save(s);
    localStorage.removeItem("bh-memomode");
    document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    app = await mountBlackhole(root, adapter, { now: () => new Date("2026-10-28T10:40:00") });
    app.setView("memo");
    return root;
  }
  const texts = (root: HTMLElement, sel: string) => [...root.querySelectorAll(sel)].map((x) => x.textContent!.replace(/\s+/g, " ").trim());

  it("날짜별 groups, tag chips with counts; a tag filters (and 「#진도」 in the box)", async () => {
    const root = await mount();
    expect(texts(root, ".mgh")).toEqual(["오늘 1", "어제 1", "지난주 1", "그 이전 1"]);
    expect(texts(root, ".mtag")).toEqual(["#진도 2", "#2-3 1", "#2-4 1", "#명단 1", "#전학공 1"]);
    root.querySelector<HTMLElement>('[data-memotag="진도"]')!.click();
    expect(texts(root, ".mrow .t")).toEqual(["2학년 3반 진도 종료", "2학년 4반 진도 종료"]);
    root.querySelector<HTMLElement>('[data-memotag="2-4"]')!.click();
    expect(texts(root, ".mrow .t")).toEqual(["2학년 4반 진도 종료"]);
    root.querySelector<HTMLElement>('[data-memotag="2-4"]')!.click();
    root.querySelector<HTMLElement>('[data-memotag="진도"]')!.click();
    const box = root.querySelector<HTMLInputElement>("[data-memoq]")!;
    box.value = "#전학공";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(texts(root, ".mrow .t")).toEqual(["교원학습공동체 신청자 13명"]);
  });

  it("주제별: one fold per tag (most used first) with the one-line summary; rename = 합치기, delete, ⌘Z", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('[data-memomode="topic"]')!.click();
    const heads = texts(root, ".mgrp > summary");
    expect(heads[0]).toContain("#진도 2");
    expect(heads[0]).toContain("진도 종료: 2-3, 2-4");
    expect(heads.at(-1)).toContain("기타 1");
    expect(heads.some((h) => h.startsWith("#2-3"))).toBe(false); // 학반 filter from the bar only
    // 이름 바꾸기 to a name already used: 합침
    root.querySelector<HTMLElement>('[data-tagren="전학공"]')!.click();
    const inp = root.querySelector<HTMLInputElement>('[data-tagrename="전학공"]')!;
    inp.value = "명단";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(app!.state.notes.find((n) => n.id === "n3")!.tags).toEqual(["명단"]);
    expect(texts(root, ".mtag").some((t) => t.startsWith("#전학공"))).toBe(false);
    // 지우기: the tag goes, the 기억 stays; ⌘Z puts it back.
    root.querySelector<HTMLElement>('[data-tagdel="진도"]')!.click();
    await tick();
    expect(app!.state.notes.find((n) => n.id === "n1")!.tags).toEqual(["2-3"]);
    expect(app!.state.notes.filter((n) => !n.gone)).toHaveLength(4);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    expect(app!.state.notes.find((n) => n.id === "n1")!.tags).toBeUndefined();
  });

  it("the 상세 편집 panel adds and takes off a 기억's tags", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('.mrow[data-mopen="n4"]')!.click();
    const inp = root.querySelector<HTMLInputElement>('#bhDetail [data-df="tag"]')!;
    inp.value = "#주차";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(app!.state.notes.find((n) => n.id === "n4")!.tags).toEqual(["주차"]);
    await tick();
    root.querySelector<HTMLElement>('#bhDetail [data-dtagdel="주차"]')!.click();
    expect(app!.state.notes.find((n) => n.id === "n4")!.tags).toEqual([]);
  });
});
