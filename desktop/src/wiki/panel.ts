import { FixtureWikiSource } from "./fixture";
import { LocalWikiCache } from "./cache";
import { searchWiki } from "./service";
import type { WikiCacheStore, WikiResult, WikiSource } from "./source";

export interface WikiPanelDependencies {
  readonly source: WikiSource;
  readonly cache: WikiCacheStore;
  readonly online: () => boolean;
  readonly now: () => number;
}
export function defaultWikiPanel(): WikiPanelDependencies {
  return { source: new FixtureWikiSource(), cache: new LocalWikiCache(), online: () => navigator.onLine, now: () => Date.now() };
}

export function mountWikiPanel(host: HTMLElement, dependencies: WikiPanelDependencies): void {
  const heading = document.createElement("h3");
  heading.textContent = "관련 Wiki 문서";
  const notice = document.createElement("p");
  notice.textContent = dependencies.source.mode === "fixture"
    ? "Wiki API 미설정 · 인공 예시입니다. 기록 원문은 전달하지 않으며 직접 입력한 검색어로만 찾습니다."
    : "Wiki 읽기 전용 · 기록 원문은 전달하지 않으며 직접 입력한 검색어로만 찾습니다.";
  const form = document.createElement("form");
  form.className = "wiki-search";
  const input = document.createElement("input");
  input.type = "search";
  input.maxLength = 200;
  input.setAttribute("aria-label", "Wiki 검색어");
  input.placeholder = "Wiki 검색어 직접 입력";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "찾기";
  const output = document.createElement("div");
  output.setAttribute("aria-live", "polite");
  form.append(input, button);
  host.replaceChildren(heading, notice, form, output);
  let request = 0;
  async function run(): Promise<void> {
    const current = ++request;
    button.disabled = true;
    output.textContent = "Wiki 문서를 확인하고 있습니다.";
    try {
      const result = await searchWiki(dependencies.source, dependencies.cache, input.value,
        { online: dependencies.online(), now: dependencies.now() });
      if (current === request && host.isConnected) renderResult(output, result);
    } catch (error: unknown) {
      if (current === request && host.isConnected) output.textContent = "error · Wiki를 불러오지 못했습니다. 연결 데이터로 표시하지 않습니다.";
    } finally { if (current === request) button.disabled = false; }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); void run(); });
  void run();
}

function renderResult(output: HTMLElement, result: WikiResult): void {
  const summary = document.createElement("p");
  const freshness = { fresh: "최신 (24시간 이내)", stale: "오래된 cache · 재확인 필요", none: "cache 없음" }[result.freshness];
  const timestamp = result.fetchedAt === null ? "저장 시각 없음" : new Date(result.fetchedAt).toLocaleString("ko-KR");
  const issue = result.issue === null ? "" : ` · ${result.issue}`;
  summary.textContent = `${result.state} · provider: ${result.provider} · 원출처: ${result.origin} · ${freshness} · ${timestamp}${issue}`;
  output.replaceChildren(summary);
  if (!result.articles.length) {
    const empty = document.createElement("p");
    empty.textContent = result.state === "error" ? "사용할 Wiki 자료가 없습니다. 오류 상태를 확인하세요." : "검색 결과가 없습니다. cache 검색은 저장된 결과 범위에서만 수행합니다.";
    output.append(empty);
  }
  for (const article of result.articles) {
    const section = document.createElement("article");
    section.className = "wiki-result";
    const title = document.createElement("h4");
    title.textContent = article.title;
    const text = document.createElement("p");
    text.textContent = article.summary;
    const metadata = document.createElement("p");
    metadata.textContent = `provider: ${article.provider} · ${result.state} · 원출처: ${result.origin} · ${freshness} · ${timestamp}`;
    const link = document.createElement("a");
    link.href = article.url;
    link.textContent = result.origin === "fixture" ? "원문 링크 (인공 예시 · 실제 문서 없음)" : "원문 링크";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (result.origin === "fixture") link.addEventListener("click", (event) => event.preventDefault());
    section.append(title, text, link, metadata);
    output.append(section);
  }
}
