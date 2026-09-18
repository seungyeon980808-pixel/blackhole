import type { WikiArticle, WikiSource } from "./source";

const articles: readonly WikiArticle[] = [
  { id: "fixture-review", title: "[가상] 기록 검토 원칙", summary: "인공 예시: 기록의 근거와 해석을 구분하여 검토하는 방법입니다.", url: "https://example.invalid/wiki/review", provider: "fixture" },
  { id: "fixture-project", title: "[가상] 프로젝트 자료 정리", summary: "인공 예시: 관련 자료를 원본 링크와 함께 연결하는 방법입니다.", url: "https://example.invalid/wiki/project", provider: "fixture" }
];

export class FixtureWikiSource implements WikiSource {
  readonly provider = "fixture";
  readonly mode = "fixture";
  async search(query: string): Promise<readonly WikiArticle[]> {
    const term = query.trim().toLocaleLowerCase("ko-KR");
    return articles.filter((article) => `${article.title} ${article.summary}`.toLocaleLowerCase("ko-KR").includes(term));
  }
  async getArticle(id: string): Promise<WikiArticle | null> {
    return articles.find((article) => article.id === id) ?? null;
  }
}
